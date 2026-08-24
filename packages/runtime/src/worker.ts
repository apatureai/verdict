import { randomUUID } from "node:crypto";
import {
  JOB_NOTIFY_CHANNEL,
  type JobRecord,
  type JobStore,
  type RecoveredJob,
  type RecoverExpiredOptions,
} from "@apatureai/verdict-jobs";
import { Client } from "pg";

export interface NotificationSource {
  start(onNotification: () => void): Promise<void>;
  close(): Promise<void>;
}

/** Dedicated Postgres LISTEN connection; pooled query connections stay separate. */
export class PgNotificationSource implements NotificationSource {
  private client: Client | null = null;

  constructor(private readonly connectionString: string) {}

  async start(onNotification: () => void): Promise<void> {
    const client = new Client({ connectionString: this.connectionString });
    this.client = client;
    try {
      await client.connect();
      client.on("notification", (message) => {
        if (message.channel === JOB_NOTIFY_CHANNEL) onNotification();
      });
      await client.query(`LISTEN ${JOB_NOTIFY_CHANNEL}`);
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.end();
  }
}

export interface WorkerStore {
  claimNext(owner: string, leaseTtlMs: number): Promise<JobRecord | null>;
  renewLease(
    id: string,
    owner: string,
    claimGeneration: number,
    leaseTtlMs: number,
  ): Promise<boolean>;
  retryOrFail(
    id: string,
    error: string,
    maxAttempts: number,
    claimGeneration: number,
  ): Promise<"queued" | "failed" | null>;
  recoverExpired(options: RecoverExpiredOptions): Promise<RecoveredJob[]>;
}

export interface EngineWorkerOptions {
  store: WorkerStore;
  processJob(jobId: string, claimGeneration: number): Promise<unknown>;
  notificationSource?: NotificationSource;
  pollIntervalMs?: number;
  maxAttempts?: number;
  /** Stable worker identity recorded as the lease owner (default: pid + random). */
  workerId?: string;
  /** Lease duration per claim; the worker renews at a third of it (#166). */
  leaseTtlMs?: number;
  /** How often the reaper scans for expired attempts (default: the lease TTL). */
  reaperIntervalMs?: number;
  /** Hard per-attempt deadline independent of heartbeats; unset = no deadline (#166). */
  maxAttemptMs?: number;
  /** Called when a heartbeat discovers the lease was lost: abort local capture/inference. */
  onLeaseLost?: (jobId: string) => void;
  /** Called per recovered attempt: best-effort stop of the lost worker's capture job. */
  onRecovered?: (job: RecoveredJob) => void;
  /** Finalize a concurrently requested cancellation after the active attempt settles. */
  finalizeCancellation?: (jobId: string, claimGeneration: number) => Promise<void>;
  onJobSettled?: (jobId: string) => void;
  logger?: Pick<Console, "info" | "error">;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * LISTEN-first worker with a bounded polling fallback and graceful drain.
 * Claims carry an expiring lease (#166): a heartbeat renews it at a third of
 * the TTL while the job runs, the startup + periodic reaper recovers attempts
 * whose worker died, and generation fencing keeps a late worker from publishing
 * over a recovered attempt.
 */
export class EngineWorker {
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly workerId: string;
  private readonly leaseTtlMs: number;
  private readonly reaperIntervalMs: number;
  private running = false;
  private stopping = false;
  private wake: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;
  private drainPromise: Promise<void> | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: EngineWorkerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.workerId = options.workerId ?? `engine-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
    this.reaperIntervalMs = options.reaperIntervalMs ?? this.leaseTtlMs;
    if (this.pollIntervalMs < 1) throw new Error("pollIntervalMs must be positive");
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }
    if (!Number.isInteger(this.leaseTtlMs) || this.leaseTtlMs < 1) {
      throw new Error("leaseTtlMs must be a positive integer");
    }
    if (!Number.isInteger(this.reaperIntervalMs) || this.reaperIntervalMs < 1) {
      throw new Error("reaperIntervalMs must be a positive integer");
    }
  }

  isReady(): boolean {
    return this.running && !this.stopping;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.options.notificationSource?.start(() => this.signalWake());
    this.stopping = false;
    this.running = true;
    // Recover attempts stranded by a previous process before taking new work,
    // then keep scanning: a single surviving worker must be able to recover
    // every other worker's losses.
    await this.reapExpired();
    this.reaperTimer = setInterval(() => {
      void this.reapExpired();
    }, this.reaperIntervalMs);
    this.reaperTimer.unref?.();
    this.loopPromise = this.runLoop();
    this.signalWake();
  }

  /** Public for deterministic integration tests and one-shot ops drains. */
  async drainOnce(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainAvailable().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  /** Public for deterministic tests: one recovery scan (also run at start + on interval). */
  async reapExpired(): Promise<void> {
    try {
      const recovered = await this.options.store.recoverExpired({
        maxAttempts: this.maxAttempts,
        ...(this.options.maxAttemptMs !== undefined ? { maxAttemptMs: this.options.maxAttemptMs } : {}),
      });
      for (const job of recovered) {
        this.options.logger?.info(
          `engine job ${job.id} recovered (${job.outcome}) from lost worker ${job.previousOwner ?? "unknown"}`,
        );
        this.options.onRecovered?.(job);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger?.error(`lease recovery scan failed: ${message}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    this.signalWake();
    await this.loopPromise;
    await this.drainPromise;
    await this.options.notificationSource?.close();
    this.running = false;
  }

  private signalWake(): void {
    this.wake?.();
    this.wake = null;
  }

  private async waitForWakeOrPoll(): Promise<void> {
    await Promise.race([
      delay(this.pollIntervalMs),
      new Promise<void>((resolve) => {
        this.wake = resolve;
      }),
    ]);
    this.wake = null;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      await this.waitForWakeOrPoll();
      if (!this.stopping) await this.drainOnce();
    }
  }

  /** Renew the claim's lease at a third of the TTL; on loss, abort the local attempt. */
  private startHeartbeat(job: JobRecord): () => void {
    let lost = false;
    const timer = setInterval(() => {
      void (async () => {
        if (lost) return;
        const renewed = await this.options.store
          .renewLease(job.id, this.workerId, job.claimGeneration, this.leaseTtlMs)
          .catch(() => false);
        if (!renewed && !lost) {
          lost = true;
          clearInterval(timer);
          this.options.logger?.error(
            `engine job ${job.id} lease lost by ${this.workerId}; aborting local attempt`,
          );
          this.options.onLeaseLost?.(job.id);
        }
      })();
    }, Math.max(1, Math.floor(this.leaseTtlMs / 3)));
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async drainAvailable(): Promise<void> {
    while (!this.stopping) {
      const job = await this.options.store.claimNext(this.workerId, this.leaseTtlMs);
      if (!job) return;
      const stopHeartbeat = this.startHeartbeat(job);
      try {
        await this.options.processJob(job.id, job.claimGeneration);
        this.options.logger?.info(`engine job ${job.id} succeeded`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const state = await this.options.store.retryOrFail(
          job.id,
          message,
          this.maxAttempts,
          job.claimGeneration,
        );
        this.options.logger?.error(`engine job ${job.id} ${state ?? "lost"}: ${message}`);
      } finally {
        stopHeartbeat();
        await this.options.finalizeCancellation?.(job.id, job.claimGeneration).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.options.logger?.error(`engine job ${job.id} cancellation finalization failed: ${message}`);
        });
        this.options.onJobSettled?.(job.id);
      }
    }
  }
}

export type JobStoreWorkerView = Pick<
  JobStore,
  "claimNext" | "renewLease" | "retryOrFail" | "recoverExpired"
>;
