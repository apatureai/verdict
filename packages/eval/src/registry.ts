import type { SqlExecutor } from "@apatureai/verdict-db";
import {
  validateCalibrationReport,
  type CalibrationAttestationVerifier,
  type CalibrationReportV1,
} from "./calibration-report.js";

/** Model/prompt registry with exact calibration-artifact promotion custody. */
export type RegistryStatus = "candidate" | "stable" | "rolled_back";
export type PromotionMode = "advisory" | "blocking";

export interface RegistryStamp {
  model: string;
  promptVersion: string;
  engineVersion: string;
  captureVersion: string;
  rubricVersion: string;
}

export interface RegistryEntry extends RegistryStamp {
  id: string;
  status: RegistryStatus;
  evalPassed: boolean;
  calibrationReportId: string | null;
  calibrationReportHash: `sha256:${string}` | null;
  calibrationReport: CalibrationReportV1 | null;
  promotionMode: PromotionMode;
  createdAt: Date;
  promotedAt: Date | null;
}

export interface PromotedCalibration {
  report: CalibrationReportV1;
  reportHash: `sha256:${string}`;
  promotionMode: PromotionMode;
}

interface RegistryRow {
  id: string;
  model: string;
  prompt_version: string;
  engine_version: string;
  capture_version: string;
  rubric_version: string;
  status: RegistryStatus;
  eval_passed: boolean;
  calibration_report_id: string | null;
  calibration_report_hash: `sha256:${string}` | null;
  calibration_report: CalibrationReportV1 | string | null;
  promotion_mode: PromotionMode;
  created_at: Date;
  promoted_at: Date | null;
}

const COLS = [
  "r.id", "r.model", "r.prompt_version", "r.engine_version", "r.capture_version", "c.rubric_version",
  "r.status", "r.eval_passed", "c.calibration_report_id", "c.calibration_report_hash",
  "c.calibration_report", "c.promotion_mode", "r.created_at", "r.promoted_at",
].join(", ");

const FROM = `model_prompt_registry r
  JOIN model_prompt_calibration_bindings c ON c.registry_id = r.id`;

function reportValue(value: RegistryRow["calibration_report"]): CalibrationReportV1 | null {
  if (value === null) return null;
  return (typeof value === "string" ? JSON.parse(value) : value) as CalibrationReportV1;
}

function mapRow(row: RegistryRow): RegistryEntry {
  return {
    id: row.id,
    model: row.model,
    promptVersion: row.prompt_version,
    engineVersion: row.engine_version,
    captureVersion: row.capture_version,
    rubricVersion: row.rubric_version,
    status: row.status,
    evalPassed: row.eval_passed,
    calibrationReportId: row.calibration_report_id,
    calibrationReportHash: row.calibration_report_hash,
    calibrationReport: reportValue(row.calibration_report),
    promotionMode: row.promotion_mode,
    createdAt: row.created_at,
    promotedAt: row.promoted_at,
  };
}

function expected(entry: RegistryStamp) {
  return {
    model: entry.model,
    promptVersion: entry.promptVersion,
    engineVersion: entry.engineVersion,
    captureVersion: entry.captureVersion,
    rubricVersion: entry.rubricVersion,
  };
}

export interface ModelPromptRegistryOptions {
  verifyAttestation?: CalibrationAttestationVerifier;
  now?: () => number;
}

export class ModelPromptRegistry {
  private readonly verifyAttestation?: CalibrationAttestationVerifier;
  private readonly now: () => number;

  constructor(private readonly exec: SqlExecutor, options: ModelPromptRegistryOptions = {}) {
    this.verifyAttestation = options.verifyAttestation;
    this.now = options.now ?? Date.now;
  }

  async registerCandidate(stamp: RegistryStamp): Promise<RegistryEntry> {
    const { rows } = await this.exec.query<{ id: string }>(
      `INSERT INTO model_prompt_registry (model, prompt_version, engine_version, capture_version)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [stamp.model, stamp.promptVersion, stamp.engineVersion, stamp.captureVersion],
    );
    const id = (rows[0] as { id: string }).id;
    await this.exec.query(
      `INSERT INTO model_prompt_calibration_bindings (registry_id, rubric_version) VALUES ($1, $2)`,
      [id, stamp.rubricVersion],
    );
    return (await this.get(id)) as RegistryEntry;
  }

  async recordEval(id: string, passed: boolean): Promise<void> {
    await this.exec.query(`UPDATE model_prompt_registry SET eval_passed = $2 WHERE id = $1`, [id, passed]);
  }

  async get(id: string): Promise<RegistryEntry | null> {
    const { rows } = await this.exec.query<RegistryRow>(
      `SELECT ${COLS} FROM ${FROM} WHERE r.id = $1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async current(): Promise<RegistryEntry | null> {
    const { rows } = await this.exec.query<RegistryRow>(
      `SELECT ${COLS} FROM ${FROM} WHERE r.status = 'stable' LIMIT 1`,
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Validate and bind the exact immutable report bytes to a candidate. */
  async bindCalibrationReport(id: string, report: CalibrationReportV1): Promise<RegistryEntry> {
    const entry = await this.get(id);
    if (!entry) throw new Error(`registry entry ${id} not found`);
    if (entry.status !== "candidate") throw new Error(`cannot bind calibration to non-candidate ${id}`);
    const validated = validateCalibrationReport(report, expected(entry), this.now());
    if (!validated.ok) throw new Error(`cannot bind calibration report: ${validated.error}`);

    await this.exec.query(
      `UPDATE model_prompt_calibration_bindings
          SET calibration_report_id = $2,
              calibration_report_hash = $3,
              calibration_report = $4::jsonb
        WHERE registry_id = $1`,
      [id, report.reportId, validated.reportHash, JSON.stringify(report)],
    );
    return (await this.get(id)) as RegistryEntry;
  }

  /**
   * Promote only after the eval gate. Blocking mode additionally requires an
   * exact, sufficient, current, attested report and a release-policy verifier.
   */
  async promote(id: string, options: { mode?: PromotionMode } = {}): Promise<RegistryEntry> {
    const entry = await this.get(id);
    if (!entry) throw new Error(`registry entry ${id} not found`);
    if (!entry.evalPassed) {
      throw new Error(`cannot promote ${id}: eval gate has not passed (version bump + eval pass required)`);
    }
    const mode = options.mode ?? "advisory";
    if (mode === "blocking") {
      if (!entry.calibrationReport || !entry.calibrationReportHash || !entry.calibrationReportId) {
        throw new Error(`cannot promote ${id} for blocking: calibration report is absent`);
      }
      const validated = validateCalibrationReport(entry.calibrationReport, expected(entry), this.now());
      if (!validated.ok) throw new Error(`cannot promote ${id} for blocking: ${validated.error}`);
      if (validated.reportHash !== entry.calibrationReportHash || validated.report.reportId !== entry.calibrationReportId) {
        throw new Error(`cannot promote ${id} for blocking: calibration report binding mismatch`);
      }
      if (!entry.calibrationReport.attestation || !this.verifyAttestation) {
        throw new Error(`cannot promote ${id} for blocking: attested calibration release policy is unavailable`);
      }
      if (!(await this.verifyAttestation(entry.calibrationReport, entry.calibrationReportHash))) {
        throw new Error(`cannot promote ${id} for blocking: calibration attestation verification failed`);
      }
    }

    await this.exec.query(`UPDATE model_prompt_registry SET status = 'rolled_back' WHERE status = 'stable'`);
    await this.exec.query(
      `UPDATE model_prompt_calibration_bindings SET promotion_mode = $2 WHERE registry_id = $1`,
      [id, mode],
    );
    await this.exec.query(
      `UPDATE model_prompt_registry SET status = 'stable', promoted_at = now() WHERE id = $1`,
      [id],
    );
    return (await this.get(id)) as RegistryEntry;
  }

  /** Return a revalidated current report, or null so serving fails closed. */
  async currentCalibration(): Promise<PromotedCalibration | null> {
    const entry = await this.current();
    if (!entry?.calibrationReport || !entry.calibrationReportHash || !entry.calibrationReportId) return null;
    const validated = validateCalibrationReport(entry.calibrationReport, expected(entry), this.now());
    if (
      !validated.ok ||
      validated.reportHash !== entry.calibrationReportHash ||
      validated.report.reportId !== entry.calibrationReportId
    ) return null;
    return {
      report: validated.report,
      reportHash: validated.reportHash,
      promotionMode: entry.promotionMode,
    };
  }

  async rollback(): Promise<RegistryEntry | null> {
    const { rows: previousRows } = await this.exec.query<{ id: string }>(
      `SELECT id FROM model_prompt_registry
       WHERE status = 'rolled_back' AND promoted_at IS NOT NULL
       ORDER BY promoted_at DESC LIMIT 1`,
    );
    await this.exec.query(`UPDATE model_prompt_registry SET status = 'rolled_back' WHERE status = 'stable'`);
    const previous = previousRows[0];
    if (!previous) return null;
    await this.exec.query(
      `UPDATE model_prompt_registry SET status = 'stable', promoted_at = now() WHERE id = $1`,
      [previous.id],
    );
    return this.get(previous.id);
  }
}
