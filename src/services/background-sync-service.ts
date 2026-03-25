import type { BackgroundSyncStatus, ProtonMailConfig } from "../types/index.js";
import { logger, type Logger } from "../utils/logger.js";
import { LocalIndexService } from "./local-index-service.js";
import { isLikelyAuthenticationError, SimpleIMAPService } from "./simple-imap-service.js";

const AUTH_BACKOFF_MIN_MS = 5 * 60_000;
const AUTH_BACKOFF_MAX_MS = 30 * 60_000;
const TRANSIENT_BACKOFF_MIN_MS = 15_000;
const TRANSIENT_BACKOFF_MAX_MS = 2 * 60_000;

export class BackgroundSyncService {
  private readonly status: BackgroundSyncStatus;
  private timer?: NodeJS.Timeout;
  private activeRun?: Promise<void>;
  private idleLoop?: Promise<void>;
  private started = false;
  private authFailureCount = 0;
  private transientFailureCount = 0;

  constructor(
    private readonly config: ProtonMailConfig,
    private readonly imapService: SimpleIMAPService,
    private readonly localIndexService: LocalIndexService,
    private readonly log: Logger = logger,
  ) {
    this.status = {
      enabled: this.config.autoSync,
      running: false,
      intervalMinutes: this.config.syncInterval,
      folder: this.config.runtime.autoSyncFolder,
      full: this.config.runtime.autoSyncFull,
      limitPerFolder: this.config.runtime.autoSyncLimitPerFolder,
      startupSync: this.config.runtime.startupSync,
      idleEnabled: this.config.runtime.idleWatchEnabled,
      idleWatching: false,
      idleMaxSeconds: this.config.runtime.idleMaxSeconds,
    };
  }

  start(): void {
    if (this.started || !this.status.enabled) {
      return;
    }

    this.started = true;
    if (this.status.startupSync) {
      void this.runNow("startup");
      return;
    }

    this.startIdleLoop();
    this.scheduleNextRun();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.status.nextRunAt = undefined;
    this.status.backoffUntil = undefined;
    this.status.idleWatching = false;
  }

  getStatus(): BackgroundSyncStatus {
    return { ...this.status };
  }

  async runNow(reason = "manual"): Promise<BackgroundSyncStatus> {
    if (!this.status.enabled) {
      return this.getStatus();
    }

    if (this.activeRun) {
      await this.activeRun;
      return this.getStatus();
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.status.nextRunAt = undefined;

    this.activeRun = (async () => {
      const startedAt = new Date().toISOString();
      let failureKind: "auth" | "transient" | undefined;
      this.status.running = true;
      this.status.lastRunAt = startedAt;
      this.log.info("Starting background mailbox sync", "BackgroundSyncService", {
        reason,
        folder: this.status.folder,
        full: this.status.full,
        limitPerFolder: this.status.limitPerFolder,
      });

      try {
        const snapshot = await this.imapService.collectEmailsForIndex({
          folder: this.status.folder,
          full: this.status.full,
          limitPerFolder: this.status.limitPerFolder,
          checkpoints: await this.localIndexService.getSyncCheckpointMap(),
        });

        await this.localIndexService.recordSnapshot({
          folders: snapshot.folders,
          emails: snapshot.emails,
          syncedAt: snapshot.syncedAt,
          folderStats: snapshot.folderStats,
        });

        this.status.lastSuccessAt = snapshot.syncedAt;
        this.status.lastError = undefined;
        this.status.lastFailureKind = undefined;
        this.authFailureCount = 0;
        this.transientFailureCount = 0;
      } catch (error) {
        failureKind = isLikelyAuthenticationError(error) ? "auth" : "transient";
        this.status.lastError = error instanceof Error ? error.message : String(error);
        this.status.lastFailureKind = failureKind;
        this.log.warn("Background mailbox sync failed", "BackgroundSyncService", {
          reason,
          failureKind,
          error,
        });
      } finally {
        this.status.running = false;
        this.activeRun = undefined;
        if (this.started) {
          if (!failureKind) {
            this.startIdleLoop();
            this.scheduleNextRun();
          } else {
            this.scheduleFailureRetry(failureKind);
          }
        }
      }
    })();

    await this.activeRun;
    return this.getStatus();
  }

  private scheduleNextRun(): void {
    if (!this.started || !this.status.enabled) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const delayMs = Math.max(1, this.status.intervalMinutes) * 60_000;
    this.scheduleTimer(delayMs, "interval");
  }

  private scheduleFailureRetry(kind: "auth" | "transient"): void {
    const count = kind === "auth" ? ++this.authFailureCount : ++this.transientFailureCount;
    if (kind === "auth") {
      this.transientFailureCount = 0;
    } else {
      this.authFailureCount = 0;
    }

    const minDelay = kind === "auth" ? AUTH_BACKOFF_MIN_MS : TRANSIENT_BACKOFF_MIN_MS;
    const maxDelay = kind === "auth" ? AUTH_BACKOFF_MAX_MS : TRANSIENT_BACKOFF_MAX_MS;
    const delayMs = Math.min(maxDelay, minDelay * 2 ** Math.max(0, count - 1));
    this.status.backoffUntil = new Date(Date.now() + delayMs).toISOString();
    this.scheduleTimer(delayMs, `${kind}-retry`);
  }

  private scheduleTimer(delayMs: number, reason: string): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.status.nextRunAt = nextRunAt;
    this.timer = setTimeout(() => {
      void this.runNow(reason);
    }, delayMs);
    this.timer.unref?.();
  }

  private startIdleLoop(): void {
    if (this.idleLoop || !this.status.idleEnabled || !this.status.folder) {
      return;
    }

    this.idleLoop = (async () => {
      while (this.started && this.status.enabled && this.status.idleEnabled && this.status.folder) {
        this.status.idleWatching = true;
        try {
          const result = await this.imapService.waitForMailboxChanges({
            folder: this.status.folder,
            timeoutMs: this.status.idleMaxSeconds * 1000,
          });
          this.status.lastIdleAt = result.checkedAt;
          this.status.lastIdleError = undefined;
          if (result.changed) {
            this.status.lastIdleChangeAt = result.checkedAt;
            this.status.lastIdleEventCount = result.events.length;
            await this.runNow("idle");
          }
        } catch (error) {
          this.status.lastIdleError = error instanceof Error ? error.message : String(error);
          const failureKind = isLikelyAuthenticationError(error) ? "auth" : "transient";
          this.log.warn("Mailbox IDLE watch failed", "BackgroundSyncService", {
            folder: this.status.folder,
            failureKind,
            error,
          });
          if (failureKind === "auth") {
            this.status.lastFailureKind = "auth";
            this.status.lastError = this.status.lastIdleError;
            this.scheduleFailureRetry("auth");
            break;
          }
          await this.waitForRetry(TRANSIENT_BACKOFF_MIN_MS);
        }
      }
      this.status.idleWatching = false;
      this.idleLoop = undefined;
    })();
  }

  private async waitForRetry(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      timer.unref?.();
    });
  }
}
