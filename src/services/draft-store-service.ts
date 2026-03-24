import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  DraftMode,
  DraftRecord,
  RemoteDraftRef,
  DraftSendResult,
  ProtonMailConfig,
} from "../types/index.js";
import { extractDomain } from "../utils/helpers.js";
import { logger, type Logger } from "../utils/logger.js";

interface DraftStoreFile {
  version: number;
  updatedAt?: string;
  drafts: Record<string, DraftRecord>;
}

function createEmptyStore(): DraftStoreFile {
  return {
    version: 1,
    updatedAt: undefined,
    drafts: {},
  };
}

export class DraftStoreService {
  private readonly draftPath: string;
  private loadedStore?: DraftStoreFile;

  constructor(
    private readonly config: ProtonMailConfig,
    private readonly log: Logger = logger,
  ) {
    this.draftPath = join(this.config.dataDir, "drafts.json");
  }

  async listDrafts(includeSent = false): Promise<DraftRecord[]> {
    const store = await this.load();
    return Object.values(store.drafts)
      .filter((draft) => includeSent || draft.status === "draft")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getDraft(id: string): Promise<DraftRecord> {
    const store = await this.load();
    const draft = store.drafts[id];
    if (!draft) {
      throw new Error(`Draft not found for id ${id}`);
    }
    return draft;
  }

  async createDraft(input: {
    mode?: DraftMode;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
    isHtml?: boolean;
    priority?: "high" | "normal" | "low";
    replyTo?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: DraftRecord["attachments"];
    sourceEmailId?: string;
    sourceMessageId?: string;
    notes?: string;
  }): Promise<DraftRecord> {
    const store = await this.load();
    const now = new Date().toISOString();
    const draft: DraftRecord = {
      id: randomUUID(),
      status: "draft",
      mode: input.mode ?? "compose",
      createdAt: now,
      updatedAt: now,
      to: [...(input.to ?? [])],
      cc: [...(input.cc ?? [])],
      bcc: [...(input.bcc ?? [])],
      subject: input.subject,
      body: input.body,
      isHtml: Boolean(input.isHtml),
      priority: input.priority,
      replyTo: input.replyTo,
      inReplyTo: input.inReplyTo,
      references: input.references ? [...input.references] : undefined,
      draftMessageId: this.createDraftMessageId(),
      attachments: [...(input.attachments ?? [])],
      sourceEmailId: input.sourceEmailId,
      sourceMessageId: input.sourceMessageId,
      notes: input.notes,
      remoteSyncState: "local_only",
    };

    store.updatedAt = now;
    store.drafts[draft.id] = draft;
    await this.save(store);
    return draft;
  }

  async updateDraft(
    id: string,
    patch: {
      to?: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      body?: string;
      isHtml?: boolean;
      priority?: "high" | "normal" | "low";
      replyTo?: string;
      inReplyTo?: string;
      references?: string[];
      attachments?: DraftRecord["attachments"];
      notes?: string;
    },
  ): Promise<DraftRecord> {
    const store = await this.load();
    const existing = store.drafts[id];
    if (!existing) {
      throw new Error(`Draft not found for id ${id}`);
    }

    const updatedAt = new Date().toISOString();
    const nextDraft: DraftRecord = {
      ...existing,
      updatedAt,
      to: patch.to ? [...patch.to] : existing.to,
      cc: patch.cc ? [...patch.cc] : existing.cc,
      bcc: patch.bcc ? [...patch.bcc] : existing.bcc,
      subject: patch.subject ?? existing.subject,
      body: patch.body ?? existing.body,
      isHtml: typeof patch.isHtml === "boolean" ? patch.isHtml : existing.isHtml,
      priority: patch.priority ?? existing.priority,
      replyTo: patch.replyTo ?? existing.replyTo,
      inReplyTo: patch.inReplyTo ?? existing.inReplyTo,
      references: patch.references ? [...patch.references] : existing.references,
      attachments: patch.attachments ? [...patch.attachments] : existing.attachments,
      notes: patch.notes ?? existing.notes,
    };

    store.updatedAt = updatedAt;
    store.drafts[id] = nextDraft;
    await this.save(store);
    return nextDraft;
  }

  async markSent(id: string, result: DraftSendResult): Promise<DraftRecord> {
    const store = await this.load();
    const existing = store.drafts[id];
    if (!existing) {
      throw new Error(`Draft not found for id ${id}`);
    }

    const sentAt = new Date().toISOString();
    const nextDraft: DraftRecord = {
      ...existing,
      status: "sent",
      sentAt,
      updatedAt: sentAt,
      lastSendResult: result,
    };

    store.updatedAt = sentAt;
    store.drafts[id] = nextDraft;
    await this.save(store);
    return nextDraft;
  }

  async markRemoteSynced(id: string, remoteDraft: RemoteDraftRef): Promise<DraftRecord> {
    const store = await this.load();
    const existing = store.drafts[id];
    if (!existing) {
      throw new Error(`Draft not found for id ${id}`);
    }

    const updatedAt = new Date().toISOString();
    const nextDraft: DraftRecord = {
      ...existing,
      updatedAt,
      remoteSyncState: "synced",
      remoteSyncError: undefined,
      remoteDraft,
    };

    store.updatedAt = updatedAt;
    store.drafts[id] = nextDraft;
    await this.save(store);
    return nextDraft;
  }

  async markRemoteSyncError(id: string, message: string): Promise<DraftRecord> {
    const store = await this.load();
    const existing = store.drafts[id];
    if (!existing) {
      throw new Error(`Draft not found for id ${id}`);
    }

    const updatedAt = new Date().toISOString();
    const nextDraft: DraftRecord = {
      ...existing,
      updatedAt,
      remoteSyncState: "sync_failed",
      remoteSyncError: message,
    };

    store.updatedAt = updatedAt;
    store.drafts[id] = nextDraft;
    await this.save(store);
    return nextDraft;
  }

  async clearRemoteSync(id: string): Promise<DraftRecord> {
    const store = await this.load();
    const existing = store.drafts[id];
    if (!existing) {
      throw new Error(`Draft not found for id ${id}`);
    }

    const updatedAt = new Date().toISOString();
    const nextDraft: DraftRecord = {
      ...existing,
      updatedAt,
      remoteSyncState: "local_only",
      remoteSyncError: undefined,
      remoteDraft: undefined,
    };

    store.updatedAt = updatedAt;
    store.drafts[id] = nextDraft;
    await this.save(store);
    return nextDraft;
  }

  async deleteDraft(id: string): Promise<{ id: string; removed: boolean }> {
    const store = await this.load();
    if (!store.drafts[id]) {
      return { id, removed: false };
    }

    delete store.drafts[id];
    store.updatedAt = new Date().toISOString();
    await this.save(store);
    return { id, removed: true };
  }

  async clear(): Promise<{ path: string; removed: boolean }> {
    this.loadedStore = undefined;
    try {
      await rm(this.draftPath);
      return { path: this.draftPath, removed: true };
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        return { path: this.draftPath, removed: false };
      }
      this.log.warn("Failed to clear draft store", "DraftStoreService", error);
      throw error;
    }
  }

  private async load(): Promise<DraftStoreFile> {
    if (this.loadedStore) {
      return this.loadedStore;
    }

    try {
      const raw = await readFile(this.draftPath, "utf8");
      const parsed = JSON.parse(raw) as DraftStoreFile;
      const drafts = Object.fromEntries(
        Object.entries(parsed.drafts ?? {}).map(([id, draft]) => [id, this.normalizeDraft(draft)]),
      );
      this.loadedStore = {
        ...createEmptyStore(),
        ...parsed,
        drafts,
      };
      return this.loadedStore;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        const empty = createEmptyStore();
        this.loadedStore = empty;
        return empty;
      }
      this.log.warn("Failed to load draft store, recreating it", "DraftStoreService", error);
      const empty = createEmptyStore();
      this.loadedStore = empty;
      return empty;
    }
  }

  private async save(store: DraftStoreFile): Promise<void> {
    await mkdir(dirname(this.draftPath), { recursive: true });
    const tempPath = `${this.draftPath}.tmp`;
    await writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
    await rename(tempPath, this.draftPath);
    this.loadedStore = store;
  }

  private normalizeDraft(draft: DraftRecord): DraftRecord {
    return {
      ...draft,
      draftMessageId: draft.draftMessageId || this.createDraftMessageId(),
      remoteSyncState: draft.remoteSyncState || "local_only",
      attachments: [...(draft.attachments ?? [])],
      cc: [...(draft.cc ?? [])],
      bcc: [...(draft.bcc ?? [])],
      to: [...(draft.to ?? [])],
    };
  }

  private createDraftMessageId(): string {
    const domain = extractDomain(this.config.smtp.username) || "localhost";
    return `<draft-${randomUUID()}@${domain}>`;
  }
}
