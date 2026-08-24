import type { SqlExecutor } from "@apatureai/verdict-db";

/**
 * Per-tenant training-consent store (#74). Default OFF; cross-tenant training
 * export (#43/#75) includes a tenant's data only when consent is on. Per-repo
 * memory (#41) uses a tenant's own data regardless.
 */
export class TrainingConsentStore {
  constructor(private readonly exec: SqlExecutor) {}

  /** Whether a tenant has opted into cross-tenant training (default false). */
  async getConsent(installationId: string): Promise<boolean> {
    const { rows } = await this.exec.query<{ consent: boolean }>(
      `SELECT consent FROM tenant_training_consent WHERE installation_id = $1`,
      [installationId],
    );
    return rows[0]?.consent ?? false;
  }

  /** Set a tenant's training consent (upsert). */
  async setConsent(installationId: string, consent: boolean): Promise<void> {
    await this.exec.query(
      `INSERT INTO tenant_training_consent (installation_id, consent)
       VALUES ($1, $2)
       ON CONFLICT (installation_id) DO UPDATE SET consent = EXCLUDED.consent`,
      [installationId, consent],
    );
  }
}
