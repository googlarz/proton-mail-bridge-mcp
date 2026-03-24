import type { BackgroundSyncStatus, ProtonMailConfig } from "../types/index.js";
import { logger, type Logger } from "../utils/logger.js";
import { LocalIndexService } from "./local-index-service.js";
import { SimpleIMAPService } from "./simple-imap-service.js";

export class BackgroundSyncService {
  private readonly status: BackgroundSyncStatus;
  private timer?: NodeJS.Timeout;
  private activeRun?: Promise<void>;
  private idleLoop?: Promise<void>;
  private started = false;

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
    if (this.status.idleEnabled && this.status.folder) {
      this.startIdleLoop();
    }
    if (this.status.startupSync) {
      void this.runNow("startup");
      return;
    }

    this.scheduleNextRun();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.status.nextRunAt = undefined;
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
      } catch (error) {
        this.status.lastError = error instanceof Error ? error.message : String(error);
        this.log.warn("Background mailbox sync failed", "BackgroundSyncService", {
          reason,
          error,
        });
      } finally {
        this.status.running = false;
        this.activeRun = undefined;
        if (this.started) {
          this.scheduleNextRun();
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

    const delayMs = Math.max(1, this.status.intervalMinutes) * 60_000;
    const nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.status.nextRunAt = nextRunAt;
    this.timer = setTimeout(() => {
      void this.runNow("interval");
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
          this.log.warn("Mailbox IDLE watch failed", "BackgroundSyncService", {
            folder: this.status.folder,
            error,
          });
        }
      }
      this.status.idleWatching = false;
      this.idleLoop = undefined;
    })();
  }
}
