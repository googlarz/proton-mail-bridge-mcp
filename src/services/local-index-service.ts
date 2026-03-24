import Database from "better-sqlite3";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ActionableThreadSummary,
  EmailSummary,
  FolderInfo,
  MailboxLabel,
  MailboxMessage,
  MailboxMessageLocation,
  LocalIndexStatus,
  MailboxSyncCheckpoint,
  ProtonMailConfig,
  SearchEmailsInput,
  ThreadDetail,
  ThreadSummary,
} from "../types/index.js";
import {
  dedupeEmails,
  extractMessageIdList,
  lowerCaseAddress,
  normalizeMessageId,
  normalizeSubjectForThread,
  sortEmailsByNewest,
} from "../utils/helpers.js";
import { logger, type Logger } from "../utils/logger.js";

interface IndexedFolderState {
  path: string;
  messages?: number;
  unseen?: number;
  specialUse?: string;
  lastIndexedAt?: string;
  lastIndexedCount?: number;
}

interface LegacyLocalIndexFile {
  version: number;
  ownerEmail?: string;
  updatedAt?: string;
  folders: FolderInfo[];
  indexedFolders: Record<string, IndexedFolderState>;
  messages: Record<string, EmailSummary>;
}

interface SnapshotData {
  ownerEmail?: string;
  updatedAt?: string;
  folders: FolderInfo[];
  indexedFolders: IndexedFolderState[];
  syncCheckpoints: MailboxSyncCheckpoint[];
  messages: EmailSummary[];
}

type MessageRow = {
  email_id: string;
  folder: string;
  uid: number;
  seq: number;
  message_id: string | null;
  in_reply_to: string | null;
  references_json: string | null;
  thread_id: string | null;
  subject: string;
  from_json: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  reply_to_json: string;
  date: string | null;
  internal_date: string | null;
  is_read: number;
  is_starred: number;
  flags_json: string;
  size: number | null;
  preview: string | null;
  has_attachments: number;
  attachments_json: string;
  attachment_text: string | null;
  labels_json: string;
};

const DB_SCHEMA_VERSION = 2;
const STALE_THRESHOLD_MINUTES = 60;

function matchesIndexedSearch(email: EmailSummary, filters: SearchEmailsInput): boolean {
  if (filters.folder && email.folder !== filters.folder) {
    return false;
  }

  if (filters.label) {
    const labelNeedle = filters.label.toLowerCase();
    const folderMatch = email.folder.toLowerCase() === labelNeedle;
    const labelMatch = email.labels.some((label) => label.toLowerCase() === labelNeedle);
    if (!folderMatch && !labelMatch) {
      return false;
    }
  }

  if (filters.threadId && email.threadId !== filters.threadId) {
    return false;
  }

  if (typeof filters.hasAttachment === "boolean" && email.hasAttachments !== filters.hasAttachment) {
    return false;
  }

  if (filters.attachmentName) {
    const attachmentNeedle = filters.attachmentName.toLowerCase();
    const match = email.attachments.some((attachment) =>
      (attachment.filename || "").toLowerCase().includes(attachmentNeedle),
    );
    if (!match) {
      return false;
    }
  }

  if (typeof filters.isRead === "boolean" && email.isRead !== filters.isRead) {
    return false;
  }

  if (typeof filters.isStarred === "boolean" && email.isStarred !== filters.isStarred) {
    return false;
  }

  const haystacks = [
    email.subject,
    email.preview ?? "",
    email.attachmentText ?? "",
    email.folder,
    email.labels.join(" "),
    ...email.from.map((value) => `${value.name ?? ""} ${value.address ?? ""}`),
    ...email.to.map((value) => `${value.name ?? ""} ${value.address ?? ""}`),
    ...email.cc.map((value) => `${value.name ?? ""} ${value.address ?? ""}`),
  ]
    .join("\n")
    .toLowerCase();

  if (filters.query && !haystacks.includes(filters.query.toLowerCase())) {
    return false;
  }

  if (filters.subject && !email.subject.toLowerCase().includes(filters.subject.toLowerCase())) {
    return false;
  }

  if (filters.from) {
    const fromNeedle = filters.from.toLowerCase();
    const match = email.from.some((value) =>
      `${value.name ?? ""} ${value.address ?? ""}`.toLowerCase().includes(fromNeedle),
    );
    if (!match) {
      return false;
    }
  }

  if (filters.to) {
    const toNeedle = filters.to.toLowerCase();
    const recipients = [...email.to, ...email.cc, ...email.bcc];
    const match = recipients.some((value) =>
      `${value.name ?? ""} ${value.address ?? ""}`.toLowerCase().includes(toNeedle),
    );
    if (!match) {
      return false;
    }
  }

  const emailDate = email.internalDate || email.date;
  if (filters.dateFrom && emailDate) {
    if (new Date(emailDate).getTime() < new Date(filters.dateFrom).getTime()) {
      return false;
    }
  }

  if (filters.dateTo && emailDate) {
    if (new Date(emailDate).getTime() > new Date(filters.dateTo).getTime()) {
      return false;
    }
  }

  return true;
}

function canonicalMessageKey(email: EmailSummary): string {
  const messageId = normalizeMessageId(email.messageId);
  if (messageId) {
    return messageId;
  }

  const fromAddress = lowerCaseAddress(email.from[0]?.address) || "unknown";
  const dateBucket = email.internalDate || email.date || String(email.uid);
  return `${normalizeSubjectForThread(email.subject).toLowerCase()}::${fromAddress}::${dateBucket}`;
}

function threadKeyForEmail(email: EmailSummary): string {
  if (email.threadId?.trim()) {
    return `imap:${email.threadId.trim()}`;
  }
  return fallbackThreadKey(email);
}

function specialUseToRole(specialUse?: string, folderPath?: string): string {
  switch (specialUse) {
    case "\\Inbox":
      return "inbox";
    case "\\Sent":
      return "sent";
    case "\\Drafts":
      return "drafts";
    case "\\Trash":
      return "trash";
    case "\\Archive":
      return "archive";
    default:
      return folderPath ? folderPath.toLowerCase() : "folder";
  }
}

function friendlySpecialUse(specialUse?: string): string | undefined {
  return specialUse?.replace(/^\\/, "");
}

function locationScore(location: { email: EmailSummary; folder?: FolderInfo }): number {
  const specialUse = location.folder?.specialUse;
  let score = 0;

  switch (specialUse) {
    case "\\Inbox":
      score += 100;
      break;
    case "\\Sent":
      score += 80;
      break;
    case "\\Drafts":
      score += 70;
      break;
    case "\\Archive":
      score += 50;
      break;
    case "\\Trash":
      score += 10;
      break;
    default:
      score += 40;
      break;
  }

  if (!location.email.isRead) {
    score += 3;
  }
  if (location.email.hasAttachments) {
    score += 1;
  }

  return score;
}

function uniqueParticipants(messages: EmailSummary[]): MailboxMessage["from"] {
  const seen = new Set<string>();
  const participants: MailboxMessage["from"] = [];

  for (const message of messages) {
    for (const address of [...message.from, ...message.to, ...message.cc]) {
      const key = lowerCaseAddress(address.address) || address.name?.trim().toLowerCase();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      participants.push(address);
    }
  }

  return participants;
}

function isOutgoingMessage(message: Pick<EmailSummary, "from">, ownerEmail?: string): boolean {
  const owner = lowerCaseAddress(ownerEmail);
  if (!owner) {
    return false;
  }

  return message.from.some((address) => lowerCaseAddress(address.address) === owner);
}

function actionableThreadScore(
  thread: ThreadDetail,
  ownerEmail?: string,
): {
  pendingOn: ActionableThreadSummary["pendingOn"];
  score: number;
} {
  const latestMessage = thread.messages[thread.messages.length - 1];
  const latestIsOutgoing = latestMessage ? isOutgoingMessage(latestMessage, ownerEmail) : false;
  const pendingOn: ActionableThreadSummary["pendingOn"] = latestMessage
    ? latestIsOutgoing
      ? "them"
      : "you"
    : "unknown";

  let score = 0;
  score += thread.unreadCount * 10;
  if (pendingOn === "you") {
    score += 8;
  }
  if (latestMessage?.isStarred) {
    score += 4;
  }
  if (latestMessage?.hasAttachments) {
    score += 2;
  }

  const latestTime = new Date(thread.latestDate || 0).getTime();
  if (latestTime > 0) {
    const ageHours = (Date.now() - latestTime) / (60 * 60 * 1000);
    if (ageHours > 24) {
      score += 3;
    } else if (ageHours > 4) {
      score += 1;
    }
  }

  return { pendingOn, score };
}

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function emailToSearchParts(email: EmailSummary): {
  labels: string;
  participants: string;
  attachmentNames: string;
} {
  return {
    labels: [email.folder, ...email.labels].join(" "),
    participants: [...email.from, ...email.to, ...email.cc, ...email.bcc]
      .map((value) => `${value.name ?? ""} ${value.address ?? ""}`.trim())
      .join(" "),
    attachmentNames: [
      ...email.attachments.map((attachment) => attachment.filename || ""),
      email.attachmentText || "",
    ]
      .join(" ")
      .trim(),
  };
}

function participantThreadSignature(message: EmailSummary, ownerEmail?: string): string {
  const owner = lowerCaseAddress(ownerEmail);
  const addresses = [...message.from, ...message.to, ...message.cc]
    .map((entry) => lowerCaseAddress(entry.address))
    .filter((entry): entry is string => Boolean(entry));
  const counterparties = owner ? addresses.filter((entry) => entry !== owner) : addresses;
  const signatureSource = counterparties.length > 0 ? counterparties : addresses;
  const signature = [...new Set(signatureSource)].sort().slice(0, 4).join("|");
  return signature || "unknown";
}

function fallbackThreadKey(message: EmailSummary, ownerEmail?: string): string {
  return `subject:${normalizeSubjectForThread(message.subject).toLowerCase()}::${participantThreadSignature(
    message,
    ownerEmail,
  )}`;
}

export class LocalIndexService {
  private readonly dbPath: string;
  private readonly legacyIndexPath: string;
  private db?: Database.Database;
  private initialized = false;

  constructor(
    private readonly config: ProtonMailConfig,
    private readonly log: Logger = logger,
  ) {
    this.dbPath = join(this.config.dataDir, "mail-index.sqlite");
    this.legacyIndexPath = join(this.config.dataDir, "mail-index.json");
  }

  async recordSnapshot(input: {
    folders: FolderInfo[];
    emails: EmailSummary[];
    syncedAt: string;
    folderStats: Array<MailboxSyncCheckpoint>;
  }): Promise<LocalIndexStatus> {
    const db = await this.ensureDb();
    const ownerEmail = lowerCaseAddress(this.config.smtp.username);
    this.applySnapshot(db, input, ownerEmail);
    return this.getStatus();
  }

  async getStatus(): Promise<LocalIndexStatus> {
    const snapshot = await this.loadSnapshot();
    return this.toStatus(snapshot);
  }

  async search(filters: SearchEmailsInput): Promise<{
    total: number;
    emails: EmailSummary[];
  }> {
    if (filters.threadId?.trim()) {
      const snapshot = await this.loadSnapshot();
      const thread = (this.buildThreads(snapshot, true) as ThreadDetail[]).find((entry) => entry.id === filters.threadId);
      if (thread) {
        const threadMessages = sortEmailsByNewest(thread.messages).filter((email) =>
          matchesIndexedSearch(email, { ...filters, threadId: undefined }),
        );
        return {
          total: threadMessages.length,
          emails: threadMessages.slice(0, filters.limit ?? 100),
        };
      }
    }

    const db = await this.ensureDb();
    const limit = filters.limit ?? 100;
    const emails = this.loadCandidateEmails(db, filters, Math.max(limit * 10, 500));
    const matches = sortEmailsByNewest(dedupeEmails(emails)).filter((email) =>
      matchesIndexedSearch(email, filters),
    );

    return {
      total: matches.length,
      emails: matches.slice(0, limit),
    };
  }

  async clear(): Promise<{ path: string; removed: boolean }> {
    this.closeDb();
    let removed = false;

    for (const path of [this.dbPath, this.legacyIndexPath]) {
      try {
        await rm(path);
        removed = true;
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            (error as { code?: string }).code === "ENOENT"
          )
        ) {
          throw error;
        }
      }
    }

    return { path: this.dbPath, removed };
  }

  async listRecentMessages(limit = 50): Promise<MailboxMessage[]> {
    const snapshot = await this.loadSnapshot();
    return this.buildMailboxMessages(snapshot).slice(0, limit);
  }

  async getLabels(limit = 250): Promise<MailboxLabel[]> {
    const snapshot = await this.loadSnapshot();
    const messages = this.buildMailboxMessages(snapshot);
    const counts = new Map<
      string,
      {
        label: MailboxLabel;
        threadIds: Set<string>;
      }
    >();

    for (const message of messages) {
      const folderInfo = snapshot.folders.find((folder) => folder.path === message.folder);
      const addCount = (
        id: string,
        name: string,
        type: MailboxLabel["type"],
        specialUse?: string,
      ): void => {
        const existing = counts.get(id) ?? {
          label: {
            id,
            name,
            type,
            messageCount: 0,
            unreadCount: 0,
            threadCount: 0,
            specialUse,
          },
          threadIds: new Set<string>(),
        };

        existing.label.messageCount += 1;
        if (!message.isRead) {
          existing.label.unreadCount += 1;
        }
        existing.threadIds.add(message.threadKey);
        existing.label.threadCount = existing.threadIds.size;
        counts.set(id, existing);
      };

      addCount(`folder:${message.folder.toLowerCase()}`, message.folder, "folder", folderInfo?.specialUse);

      if (folderInfo?.specialUse) {
        const friendly = friendlySpecialUse(folderInfo.specialUse) || folderInfo.specialUse;
        addCount(`special:${friendly.toLowerCase()}`, friendly, "special_use", folderInfo.specialUse);
      }

      for (const label of message.normalizedLabels) {
        addCount(`label:${label.toLowerCase()}`, label, "label");
      }
    }

    return [...counts.values()]
      .map((entry) => entry.label)
      .sort((left, right) => {
        if (right.messageCount !== left.messageCount) {
          return right.messageCount - left.messageCount;
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, limit);
  }

  async getThreads(input: { query?: string; label?: string; limit?: number } = {}): Promise<{
    total: number;
    threads: ThreadSummary[];
  }> {
    const snapshot = await this.loadSnapshot();
    const threads = this.buildThreads(snapshot).filter((thread) => {
      if (input.label) {
        const labelNeedle = input.label.toLowerCase();
        if (!thread.normalizedLabels.some((label) => label.toLowerCase() === labelNeedle)) {
          return false;
        }
      }

      if (input.query) {
        const haystack = [
          thread.subject,
          ...thread.participants.map((participant) => `${participant.name ?? ""} ${participant.address ?? ""}`),
          ...thread.normalizedLabels,
        ]
          .join("\n")
          .toLowerCase();
        if (!haystack.includes(input.query.toLowerCase())) {
          return false;
        }
      }

      return true;
    });

    const limit = input.limit ?? 100;
    return {
      total: threads.length,
      threads: threads.slice(0, limit),
    };
  }

  async getThreadById(threadId: string): Promise<ThreadDetail> {
    const snapshot = await this.loadSnapshot();
    const thread = this.buildThreads(snapshot, true).find((entry) => entry.id === threadId) as
      | ThreadDetail
      | undefined;
    if (!thread) {
      throw new Error(`Thread not found for id ${threadId}`);
    }
    return thread;
  }

  async getActionableThreads(input: {
    query?: string;
    label?: string;
    limit?: number;
    unreadOnly?: boolean;
    pendingOn?: "you" | "them" | "any";
  } = {}): Promise<{
    total: number;
    threads: ActionableThreadSummary[];
  }> {
    const snapshot = await this.loadSnapshot();
    const pendingFilter = input.pendingOn || "any";
    const limit = input.limit ?? 50;
    const actionable = (this.buildThreads(snapshot, true) as ThreadDetail[])
      .map((thread) => {
        const latestMessage = thread.messages[thread.messages.length - 1];
        const { pendingOn, score } = actionableThreadScore(thread, snapshot.ownerEmail);
        return {
          ...thread,
          latestEmailId: latestMessage?.primaryEmailId,
          latestPreview: latestMessage?.preview,
          latestFrom: latestMessage?.from ?? [],
          latestIsRead: latestMessage?.isRead ?? true,
          latestIsStarred: latestMessage?.isStarred ?? false,
          latestHasAttachments: latestMessage?.hasAttachments ?? false,
          pendingOn,
          score,
        } satisfies ActionableThreadSummary;
      })
      .filter((thread) => {
        if (input.unreadOnly !== false && thread.unreadCount === 0) {
          return false;
        }

        if (pendingFilter !== "any" && thread.pendingOn !== pendingFilter) {
          return false;
        }

        if (input.label) {
          const labelNeedle = input.label.toLowerCase();
          if (!thread.normalizedLabels.some((label) => label.toLowerCase() === labelNeedle)) {
            return false;
          }
        }

        if (input.query) {
          const haystack = [
            thread.subject,
            thread.latestPreview || "",
            ...thread.latestFrom.map((value) => `${value.name ?? ""} ${value.address ?? ""}`),
            ...thread.normalizedLabels,
          ]
            .join("\n")
            .toLowerCase();
          if (!haystack.includes(input.query.toLowerCase())) {
            return false;
          }
        }

        return true;
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        const leftTime = new Date(left.latestDate || 0).getTime();
        const rightTime = new Date(right.latestDate || 0).getTime();
        return rightTime - leftTime;
      });

    return {
      total: actionable.length,
      threads: actionable.slice(0, limit),
    };
  }

  async getSyncCheckpointMap(): Promise<Record<string, MailboxSyncCheckpoint>> {
    const snapshot = await this.loadSnapshot();
    return Object.fromEntries(snapshot.syncCheckpoints.map((checkpoint) => [checkpoint.folder, checkpoint]));
  }

  async getInboxDigest(input: {
    limit?: number;
    minAgeHours?: number;
  } = {}): Promise<Record<string, unknown>> {
    const snapshot = await this.loadSnapshot();
    const minAgeHours = input.minAgeHours ?? 24;
    const allActionable = (this.buildThreads(snapshot, true) as ThreadDetail[])
      .map((thread) => {
        const latestMessage = thread.messages[thread.messages.length - 1];
        const { pendingOn, score } = actionableThreadScore(thread, snapshot.ownerEmail);
        return {
          ...thread,
          latestEmailId: latestMessage?.primaryEmailId,
          latestPreview: latestMessage?.preview,
          latestFrom: latestMessage?.from ?? [],
          latestIsRead: latestMessage?.isRead ?? true,
          latestIsStarred: latestMessage?.isStarred ?? false,
          latestHasAttachments: latestMessage?.hasAttachments ?? false,
          pendingOn,
          score,
        } satisfies ActionableThreadSummary;
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return new Date(right.latestDate || 0).getTime() - new Date(left.latestDate || 0).getTime();
      });

    const now = Date.now();
    const staleThresholdMs = minAgeHours * 60 * 60 * 1000;
    const staleAwaitingYou = allActionable.filter((thread) => {
      if (thread.pendingOn !== "you" || !thread.latestDate) {
        return false;
      }
      return now - new Date(thread.latestDate).getTime() >= staleThresholdMs;
    });

    return {
      generatedAt: new Date().toISOString(),
      indexUpdatedAt: snapshot.updatedAt,
      counts: {
        totalThreads: allActionable.length,
        unreadThreads: allActionable.filter((thread) => thread.unreadCount > 0).length,
        pendingOnYou: allActionable.filter((thread) => thread.pendingOn === "you").length,
        pendingOnThem: allActionable.filter((thread) => thread.pendingOn === "them").length,
        starredThreads: allActionable.filter((thread) => thread.latestIsStarred).length,
        attachmentThreads: allActionable.filter((thread) => thread.latestHasAttachments).length,
        staleAwaitingYou: staleAwaitingYou.length,
      },
      topThreads: allActionable.slice(0, input.limit ?? 10),
      staleAwaitingYou: staleAwaitingYou.slice(0, input.limit ?? 10),
    };
  }

  async getFollowUpCandidates(input: {
    limit?: number;
    minAgeHours?: number;
    pendingOn?: "you" | "them" | "any";
  } = {}): Promise<Record<string, unknown>> {
    const snapshot = await this.loadSnapshot();
    const minAgeHours = input.minAgeHours ?? 24;
    const pendingOn = input.pendingOn ?? "you";
    const thresholdMs = minAgeHours * 60 * 60 * 1000;
    const now = Date.now();

    const candidates = (this.buildThreads(snapshot, true) as ThreadDetail[])
      .map((thread) => {
        const latestMessage = thread.messages[thread.messages.length - 1];
        const { pendingOn: currentPendingOn, score } = actionableThreadScore(thread, snapshot.ownerEmail);
        const ageHours = thread.latestDate
          ? Math.max(0, Math.round((now - new Date(thread.latestDate).getTime()) / (60 * 60 * 1000)))
          : undefined;
        return {
          ...thread,
          latestEmailId: latestMessage?.primaryEmailId,
          latestPreview: latestMessage?.preview,
          latestFrom: latestMessage?.from ?? [],
          latestIsRead: latestMessage?.isRead ?? true,
          latestIsStarred: latestMessage?.isStarred ?? false,
          latestHasAttachments: latestMessage?.hasAttachments ?? false,
          pendingOn: currentPendingOn,
          score,
          ageHours,
          suggestedAction:
            currentPendingOn === "you" ? "reply" : currentPendingOn === "them" ? "follow_up" : "review",
        } satisfies ActionableThreadSummary & {
          ageHours?: number;
          suggestedAction: "reply" | "follow_up" | "review";
        };
      })
      .filter((thread) => {
        if (pendingOn !== "any" && thread.pendingOn !== pendingOn) {
          return false;
        }
        if (thread.latestDate && now - new Date(thread.latestDate).getTime() < thresholdMs) {
          return false;
        }
        return true;
      })
      .sort((left, right) => {
        if ((right.ageHours ?? 0) !== (left.ageHours ?? 0)) {
          return (right.ageHours ?? 0) - (left.ageHours ?? 0);
        }
        return right.score - left.score;
      });

    return {
      generatedAt: new Date().toISOString(),
      indexUpdatedAt: snapshot.updatedAt,
      minAgeHours,
      pendingOn,
      total: candidates.length,
      threads: candidates.slice(0, input.limit ?? 25),
    };
  }

  async runIntegrityCheck(): Promise<{
    ok: boolean;
    integrity: string;
    storedMessageCount: number;
    ftsRowCount: number;
    syncCheckpointCount: number;
  }> {
    const db = await this.ensureDb();
    const integrity = String(
      (db.prepare(`PRAGMA integrity_check`).get() as { integrity_check?: string } | undefined)?.integrity_check || "unknown",
    );
    const storedMessageCount = Number(
      (db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number }).count,
    );
    const ftsRowCount = Number(
      (db.prepare(`SELECT COUNT(*) AS count FROM messages_fts`).get() as { count: number }).count,
    );
    const syncCheckpointCount = Number(
      (db.prepare(`SELECT COUNT(*) AS count FROM sync_state`).get() as { count: number }).count,
    );

    return {
      ok: integrity.toLowerCase() === "ok",
      integrity,
      storedMessageCount,
      ftsRowCount,
      syncCheckpointCount,
    };
  }

  private async ensureDb(): Promise<Database.Database> {
    if (this.db && this.initialized) {
      return this.db;
    }

    await mkdir(dirname(this.dbPath), { recursive: true });
    const db = this.db ?? new Database(this.dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");

    this.runMigrations(db);
    this.db = db;
    await this.maybeImportLegacyIndex(db);

    this.initialized = true;
    return db;
  }

  private applySnapshot(
    db: Database.Database,
    input: {
      folders: FolderInfo[];
      emails: EmailSummary[];
      syncedAt: string;
      folderStats: Array<MailboxSyncCheckpoint>;
    },
    ownerEmail?: string,
  ): void {
    const upsertFolder = db.prepare(`
      INSERT INTO folders (
        path, name, delimiter, special_use, listed, subscribed, flags_json,
        messages, unseen, uid_next, last_indexed_at, last_indexed_count
      ) VALUES (
        @path, @name, @delimiter, @special_use, @listed, @subscribed, @flags_json,
        @messages, @unseen, @uid_next, @last_indexed_at, @last_indexed_count
      )
      ON CONFLICT(path) DO UPDATE SET
        name = excluded.name,
        delimiter = excluded.delimiter,
        special_use = excluded.special_use,
        listed = excluded.listed,
        subscribed = excluded.subscribed,
        flags_json = excluded.flags_json,
        messages = excluded.messages,
        unseen = excluded.unseen,
        uid_next = excluded.uid_next,
        last_indexed_at = excluded.last_indexed_at,
        last_indexed_count = excluded.last_indexed_count
    `);

    const upsertMessage = db.prepare(`
      INSERT INTO messages (
        email_id, folder, uid, seq, message_id, in_reply_to, references_json, thread_id, subject,
        from_json, to_json, cc_json, bcc_json, reply_to_json, date, internal_date,
        is_read, is_starred, flags_json, size, preview, has_attachments, attachments_json, attachment_text, labels_json
      ) VALUES (
        @email_id, @folder, @uid, @seq, @message_id, @in_reply_to, @references_json, @thread_id, @subject,
        @from_json, @to_json, @cc_json, @bcc_json, @reply_to_json, @date, @internal_date,
        @is_read, @is_starred, @flags_json, @size, @preview, @has_attachments, @attachments_json, @attachment_text, @labels_json
      )
      ON CONFLICT(email_id) DO UPDATE SET
        folder = excluded.folder,
        uid = excluded.uid,
        seq = excluded.seq,
        message_id = excluded.message_id,
        in_reply_to = excluded.in_reply_to,
        references_json = excluded.references_json,
        thread_id = excluded.thread_id,
        subject = excluded.subject,
        from_json = excluded.from_json,
        to_json = excluded.to_json,
        cc_json = excluded.cc_json,
        bcc_json = excluded.bcc_json,
        reply_to_json = excluded.reply_to_json,
        date = excluded.date,
        internal_date = excluded.internal_date,
        is_read = excluded.is_read,
        is_starred = excluded.is_starred,
        flags_json = excluded.flags_json,
        size = excluded.size,
        preview = excluded.preview,
        has_attachments = excluded.has_attachments,
        attachments_json = excluded.attachments_json,
        attachment_text = excluded.attachment_text,
        labels_json = excluded.labels_json
    `);
    const upsertSyncState = db.prepare(`
      INSERT INTO sync_state (
        folder, uid_validity, uid_next, highest_uid, last_sync_at, last_full_sync_at, strategy, changed, fetched, total
      ) VALUES (
        @folder, @uid_validity, @uid_next, @highest_uid, @last_sync_at, @last_full_sync_at, @strategy, @changed, @fetched, @total
      )
      ON CONFLICT(folder) DO UPDATE SET
        uid_validity = excluded.uid_validity,
        uid_next = excluded.uid_next,
        highest_uid = excluded.highest_uid,
        last_sync_at = excluded.last_sync_at,
        last_full_sync_at = COALESCE(excluded.last_full_sync_at, sync_state.last_full_sync_at),
        strategy = excluded.strategy,
        changed = excluded.changed,
        fetched = excluded.fetched,
        total = excluded.total
    `);

    const deleteFts = db.prepare(`DELETE FROM messages_fts WHERE email_id = ?`);
    const insertFts = db.prepare(`
      INSERT INTO messages_fts (
        email_id, subject, preview, folder, labels, participants, attachment_names
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const setMetadata = db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    const transaction = db.transaction(() => {
      setMetadata.run("schemaVersion", String(DB_SCHEMA_VERSION));
      setMetadata.run("ownerEmail", ownerEmail || "");
      setMetadata.run("updatedAt", input.syncedAt);

      for (const folder of input.folders) {
        const folderStat = input.folderStats.find((entry) => entry.folder === folder.path);
        upsertFolder.run({
          path: folder.path,
          name: folder.name,
          delimiter: folder.delimiter,
          special_use: folder.specialUse ?? null,
          listed: folder.listed ? 1 : 0,
          subscribed: folder.subscribed ? 1 : 0,
          flags_json: JSON.stringify(folder.flags),
          messages: folder.messages ?? null,
          unseen: folder.unseen ?? null,
          uid_next: folder.uidNext ?? null,
          last_indexed_at: input.syncedAt,
          last_indexed_count: folderStat?.fetched ?? null,
        });
      }

      for (const folderStat of input.folderStats) {
        upsertSyncState.run({
          folder: folderStat.folder,
          uid_validity: folderStat.uidValidity ?? null,
          uid_next: folderStat.uidNext ?? null,
          highest_uid: folderStat.highestUid ?? null,
          last_sync_at: folderStat.lastSyncAt ?? input.syncedAt,
          last_full_sync_at:
            folderStat.strategy === "full"
              ? folderStat.lastFullSyncAt ?? folderStat.lastSyncAt ?? input.syncedAt
              : folderStat.lastFullSyncAt ?? null,
          strategy: folderStat.strategy ?? null,
          changed: folderStat.changed ? 1 : 0,
          fetched: folderStat.fetched ?? null,
          total: folderStat.total ?? null,
        });
      }

      for (const email of input.emails) {
        upsertMessage.run({
          email_id: email.id,
          folder: email.folder,
          uid: email.uid,
          seq: email.seq,
          message_id: email.messageId ?? null,
          in_reply_to: email.inReplyTo ?? null,
          references_json: JSON.stringify(email.references ?? []),
          thread_id: email.threadId ?? null,
          subject: email.subject,
          from_json: JSON.stringify(email.from),
          to_json: JSON.stringify(email.to),
          cc_json: JSON.stringify(email.cc),
          bcc_json: JSON.stringify(email.bcc),
          reply_to_json: JSON.stringify(email.replyTo),
          date: email.date ?? null,
          internal_date: email.internalDate ?? null,
          is_read: email.isRead ? 1 : 0,
          is_starred: email.isStarred ? 1 : 0,
          flags_json: JSON.stringify(email.flags),
          size: email.size ?? null,
          preview: email.preview ?? null,
          has_attachments: email.hasAttachments ? 1 : 0,
          attachments_json: JSON.stringify(email.attachments),
          attachment_text: email.attachmentText ?? null,
          labels_json: JSON.stringify(email.labels),
        });

        const search = emailToSearchParts(email);
        deleteFts.run(email.id);
        insertFts.run(
          email.id,
          email.subject,
          email.preview ?? "",
          email.folder,
          search.labels,
          search.participants,
          search.attachmentNames,
        );
      }
    });

    transaction();
  }

  private runMigrations(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS folders (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        delimiter TEXT NOT NULL,
        special_use TEXT,
        listed INTEGER NOT NULL,
        subscribed INTEGER NOT NULL,
        flags_json TEXT NOT NULL,
        messages INTEGER,
        unseen INTEGER,
        uid_next INTEGER,
        last_indexed_at TEXT,
        last_indexed_count INTEGER
      );

      CREATE TABLE IF NOT EXISTS messages (
        email_id TEXT PRIMARY KEY,
        folder TEXT NOT NULL,
        uid INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        message_id TEXT,
        in_reply_to TEXT,
        references_json TEXT NOT NULL DEFAULT '[]',
        thread_id TEXT,
        subject TEXT NOT NULL,
        from_json TEXT NOT NULL,
        to_json TEXT NOT NULL,
        cc_json TEXT NOT NULL,
        bcc_json TEXT NOT NULL,
        reply_to_json TEXT NOT NULL,
        date TEXT,
        internal_date TEXT,
        is_read INTEGER NOT NULL,
        is_starred INTEGER NOT NULL,
        flags_json TEXT NOT NULL,
        size INTEGER,
        preview TEXT,
        has_attachments INTEGER NOT NULL,
        attachments_json TEXT NOT NULL,
        attachment_text TEXT,
        labels_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        folder TEXT PRIMARY KEY,
        uid_validity TEXT,
        uid_next INTEGER,
        highest_uid INTEGER,
        last_sync_at TEXT,
        last_full_sync_at TEXT,
        strategy TEXT,
        changed INTEGER NOT NULL DEFAULT 0,
        fetched INTEGER,
        total INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder);
      CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
      CREATE INDEX IF NOT EXISTS idx_messages_in_reply_to ON messages(in_reply_to);
      CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_messages_internal_date ON messages(internal_date);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        email_id UNINDEXED,
        subject,
        preview,
        folder,
        labels,
        participants,
        attachment_names,
        tokenize = 'porter unicode61'
      );
    `);
    this.ensureMessagesColumns(db);
  }

  private ensureMessagesColumns(db: Database.Database): void {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>).map((row) => row.name),
    );

    if (!columns.has("references_json")) {
      db.exec(`ALTER TABLE messages ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!columns.has("attachment_text")) {
      db.exec(`ALTER TABLE messages ADD COLUMN attachment_text TEXT`);
    }
  }

  private async maybeImportLegacyIndex(db: Database.Database): Promise<void> {
    const hasMetadata = db.prepare(`SELECT value FROM metadata WHERE key = 'schemaVersion'`).get() as
      | { value: string }
      | undefined;
    if (hasMetadata) {
      return;
    }

    try {
      const raw = await readFile(this.legacyIndexPath, "utf8");
      const legacy = JSON.parse(raw) as LegacyLocalIndexFile;
      this.log.info("Importing legacy JSON mailbox index into SQLite", "LocalIndexService", {
        legacyPath: this.legacyIndexPath,
      });

      this.applySnapshot(
        db,
        {
          folders: legacy.folders ?? [],
          emails: Object.values(legacy.messages ?? {}),
          syncedAt: legacy.updatedAt || new Date().toISOString(),
          folderStats: Object.values(legacy.indexedFolders ?? {}).map((entry) => ({
            folder: entry.path,
            fetched: entry.lastIndexedCount ?? 0,
            total: entry.messages ?? 0,
          })),
        },
        lowerCaseAddress(this.config.smtp.username),
      );
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: string }).code === "ENOENT"
        )
      ) {
        this.log.warn("Failed to import legacy JSON mailbox index", "LocalIndexService", error);
      }

      const setMetadata = db.prepare(`
        INSERT INTO metadata (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      setMetadata.run("schemaVersion", String(DB_SCHEMA_VERSION));
      setMetadata.run("ownerEmail", lowerCaseAddress(this.config.smtp.username) || "");
      setMetadata.run("updatedAt", "");
    }
  }

  private loadCandidateEmails(
    db: Database.Database,
    filters: SearchEmailsInput,
    limitHint: number,
  ): EmailSummary[] {
    const sqlParts = [`SELECT * FROM messages`];
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (filters.query) {
      const ftsIds = this.searchFtsIds(db, filters.query, limitHint);
      if (ftsIds.length === 0) {
        return [];
      }
      conditions.push(`email_id IN (${ftsIds.map(() => "?").join(", ")})`);
      params.push(...ftsIds);
    }

    if (filters.folder) {
      conditions.push(`folder = ?`);
      params.push(filters.folder);
    }
    if (typeof filters.isRead === "boolean") {
      conditions.push(`is_read = ?`);
      params.push(filters.isRead ? 1 : 0);
    }
    if (typeof filters.isStarred === "boolean") {
      conditions.push(`is_starred = ?`);
      params.push(filters.isStarred ? 1 : 0);
    }
    if (typeof filters.hasAttachment === "boolean") {
      conditions.push(`has_attachments = ?`);
      params.push(filters.hasAttachment ? 1 : 0);
    }
    if (filters.subject) {
      conditions.push(`LOWER(subject) LIKE ?`);
      params.push(`%${filters.subject.toLowerCase()}%`);
    }
    if (filters.threadId) {
      conditions.push(`thread_id = ?`);
      params.push(filters.threadId);
    }
    if (filters.dateFrom) {
      conditions.push(`COALESCE(internal_date, date) >= ?`);
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push(`COALESCE(internal_date, date) <= ?`);
      params.push(filters.dateTo);
    }

    if (conditions.length > 0) {
      sqlParts.push(`WHERE ${conditions.join(" AND ")}`);
    }

    sqlParts.push(`ORDER BY COALESCE(internal_date, date) DESC, uid DESC LIMIT ?`);
    params.push(limitHint);

    return db
      .prepare(sqlParts.join(" "))
      .all(...params)
      .map((row) => this.rowToEmailSummary(row as MessageRow));
  }

  private searchFtsIds(db: Database.Database, query: string, limit: number): string[] {
    const match = query
      .trim()
      .split(/\s+/)
      .map((token) => `"${token.replace(/"/g, '""')}"`)
      .join(" AND ");

    if (!match) {
      return [];
    }

    try {
      return db
        .prepare(`SELECT email_id FROM messages_fts WHERE messages_fts MATCH ? LIMIT ?`)
        .all(match, limit)
        .map((row) => String((row as { email_id: string }).email_id));
    } catch (error) {
      this.log.warn("FTS search failed, falling back to metadata scan", "LocalIndexService", {
        query,
        error,
      });
      return [];
    }
  }

  private async loadSnapshot(): Promise<SnapshotData> {
    const db = await this.ensureDb();

    const metadataRows = db
      .prepare(`SELECT key, value FROM metadata`)
      .all() as Array<{ key: string; value: string }>;
    const metadata = Object.fromEntries(metadataRows.map((row) => [row.key, row.value]));

    const folders = db
      .prepare(`SELECT * FROM folders ORDER BY path ASC`)
      .all()
      .map((row) => this.rowToFolderInfo(row as Record<string, unknown>));

    const indexedFolders = db
      .prepare(`
        SELECT path, messages, unseen, special_use, last_indexed_at, last_indexed_count
        FROM folders
        ORDER BY path ASC
      `)
      .all()
      .map((row) => ({
        path: String((row as { path: string }).path),
        messages: (row as { messages?: number }).messages,
        unseen: (row as { unseen?: number }).unseen,
        specialUse: (row as { special_use?: string }).special_use,
        lastIndexedAt: (row as { last_indexed_at?: string }).last_indexed_at,
        lastIndexedCount: (row as { last_indexed_count?: number }).last_indexed_count,
      }));

    const syncCheckpoints = db
      .prepare(`
        SELECT folder, uid_validity, uid_next, highest_uid, last_sync_at, last_full_sync_at, strategy, changed, fetched, total
        FROM sync_state
        ORDER BY folder ASC
      `)
      .all()
      .map((row) => ({
        folder: String((row as { folder: string }).folder),
        uidValidity: (row as { uid_validity?: string }).uid_validity,
        uidNext: (row as { uid_next?: number }).uid_next,
        highestUid: (row as { highest_uid?: number }).highest_uid,
        lastSyncAt: (row as { last_sync_at?: string }).last_sync_at,
        lastFullSyncAt: (row as { last_full_sync_at?: string }).last_full_sync_at,
        strategy: (row as { strategy?: MailboxSyncCheckpoint["strategy"] }).strategy,
        changed: Boolean((row as { changed?: number }).changed),
        fetched: (row as { fetched?: number }).fetched,
        total: (row as { total?: number }).total,
      } satisfies MailboxSyncCheckpoint));

    const messages = db
      .prepare(`SELECT * FROM messages ORDER BY COALESCE(internal_date, date) DESC, uid DESC`)
      .all()
      .map((row) => this.rowToEmailSummary(row as MessageRow));

    return {
      ownerEmail: metadata.ownerEmail || undefined,
      updatedAt: metadata.updatedAt || undefined,
      folders,
      indexedFolders,
      syncCheckpoints,
      messages,
    };
  }

  private rowToFolderInfo(row: Record<string, unknown>): FolderInfo {
    return {
      path: String(row.path),
      name: String(row.name),
      delimiter: String(row.delimiter),
      specialUse: typeof row.special_use === "string" ? row.special_use : undefined,
      listed: Boolean(row.listed),
      subscribed: Boolean(row.subscribed),
      flags: safeJsonParse<string[]>(String(row.flags_json || "[]"), []),
      messages: typeof row.messages === "number" ? row.messages : undefined,
      unseen: typeof row.unseen === "number" ? row.unseen : undefined,
      uidNext: typeof row.uid_next === "number" ? row.uid_next : undefined,
    };
  }

  private rowToEmailSummary(row: MessageRow): EmailSummary {
    return {
      id: row.email_id,
      folder: row.folder,
      uid: row.uid,
      seq: row.seq,
      messageId: row.message_id ?? undefined,
      inReplyTo: row.in_reply_to ?? undefined,
      references: safeJsonParse(row.references_json, []),
      threadId: row.thread_id ?? undefined,
      subject: row.subject,
      from: safeJsonParse(row.from_json, []),
      to: safeJsonParse(row.to_json, []),
      cc: safeJsonParse(row.cc_json, []),
      bcc: safeJsonParse(row.bcc_json, []),
      replyTo: safeJsonParse(row.reply_to_json, []),
      date: row.date ?? undefined,
      internalDate: row.internal_date ?? undefined,
      isRead: Boolean(row.is_read),
      isStarred: Boolean(row.is_starred),
      flags: safeJsonParse(row.flags_json, []),
      size: row.size ?? undefined,
      preview: row.preview ?? undefined,
      hasAttachments: Boolean(row.has_attachments),
      attachments: safeJsonParse(row.attachments_json, []),
      attachmentText: row.attachment_text ?? undefined,
      labels: safeJsonParse(row.labels_json, []),
    };
  }

  private toStatus(snapshot: SnapshotData): LocalIndexStatus {
    const dedupedCount = dedupeEmails(snapshot.messages).length;
    const mailboxMessages = this.buildMailboxMessages(snapshot);
    const threadCount = this.buildThreads(snapshot).length;
    const labelCount = new Set(
      mailboxMessages.flatMap((message) => message.normalizedLabels.map((label) => label.toLowerCase())),
    ).size;
    const ageMinutes = snapshot.updatedAt
      ? Math.max(0, Math.round((Date.now() - new Date(snapshot.updatedAt).getTime()) / 60_000))
      : undefined;

    return {
      path: this.dbPath,
      ownerEmail: snapshot.ownerEmail,
      updatedAt: snapshot.updatedAt,
      ageMinutes,
      staleThresholdMinutes: STALE_THRESHOLD_MINUTES,
      isStale: typeof ageMinutes === "number" ? ageMinutes > STALE_THRESHOLD_MINUTES : true,
      folderCount: snapshot.folders.length,
      labelCount,
      threadCount,
      storedMessageCount: snapshot.messages.length,
      dedupedMessageCount: dedupedCount,
      syncCheckpoints: snapshot.syncCheckpoints,
      folders: snapshot.indexedFolders,
    };
  }

  private buildMailboxMessages(snapshot: SnapshotData): MailboxMessage[] {
    const foldersByPath = new Map(snapshot.folders.map((folder) => [folder.path, folder]));
    const groups = new Map<string, Array<{ email: EmailSummary; folder?: FolderInfo }>>();

    for (const email of snapshot.messages) {
      const key = canonicalMessageKey(email);
      const group = groups.get(key) ?? [];
      group.push({ email, folder: foldersByPath.get(email.folder) });
      groups.set(key, group);
    }

    return sortEmailsByNewest(
      [...groups.entries()].map(([canonicalId, entries]) => {
        const primaryEntry = [...entries].sort((left, right) => locationScore(right) - locationScore(left))[0];
        const primary = primaryEntry.email;
        const primaryFolder = primaryEntry.folder;
        const locations: MailboxMessageLocation[] = entries.map(({ email, folder }) => ({
          emailId: email.id,
          folder: email.folder,
          uid: email.uid,
          labels: [...email.labels],
          specialUse: folder?.specialUse,
          isRead: email.isRead,
          isStarred: email.isStarred,
        }));

        const normalizedLabels = new Set<string>();
        for (const entry of entries) {
          normalizedLabels.add(entry.email.folder);
          for (const label of entry.email.labels) {
            normalizedLabels.add(label);
          }
          const friendly = friendlySpecialUse(entry.folder?.specialUse);
          if (friendly) {
            normalizedLabels.add(friendly);
          }
          const pathParts = entry.email.folder.split("/");
          if (pathParts.length > 1) {
            normalizedLabels.add(pathParts[pathParts.length - 1]);
          }
        }

        return {
          ...primary,
          canonicalId,
          primaryEmailId: primary.id,
          threadKey: threadKeyForEmail(primary),
          mailboxRole: specialUseToRole(primaryFolder?.specialUse, primary.folder),
          normalizedLabels: [...normalizedLabels].sort((left, right) => left.localeCompare(right)),
          locations: locations.sort((left, right) => right.uid - left.uid),
        };
      }),
    );
  }

  private buildThreads(
    snapshot: SnapshotData,
    includeMessages = false,
  ): Array<ThreadSummary | ThreadDetail> {
    const messages = this.assignResolvedThreadKeys(this.buildMailboxMessages(snapshot), snapshot.ownerEmail);
    const groups = new Map<string, MailboxMessage[]>();

    for (const message of messages) {
      const key = message.threadKey;
      const group = groups.get(key) ?? [];
      group.push(message);
      groups.set(key, group);
    }

    return [...groups.entries()]
      .map(([id, entries]) => {
        const sortedMessages = [...entries].sort((left, right) => {
          const leftTime = new Date(left.internalDate || left.date || 0).getTime();
          const rightTime = new Date(right.internalDate || right.date || 0).getTime();
          if (leftTime !== rightTime) {
            return leftTime - rightTime;
          }
          return left.uid - right.uid;
        });

        const latest = sortEmailsByNewest(sortedMessages)[0];
        const normalizedLabels = new Set<string>();
        for (const message of sortedMessages) {
          for (const label of message.normalizedLabels) {
            normalizedLabels.add(label);
          }
        }

        const summary: ThreadSummary = {
          id,
          subject: latest ? normalizeSubjectForThread(latest.subject) : "(no subject)",
          messageCount: sortedMessages.length,
          unreadCount: sortedMessages.filter((message) => !message.isRead).length,
          latestDate: latest?.internalDate || latest?.date,
          participants: uniqueParticipants(sortedMessages),
          normalizedLabels: [...normalizedLabels].sort((left, right) => left.localeCompare(right)),
          messageIds: sortedMessages.map((message) => message.primaryEmailId),
        };

        if (!includeMessages) {
          return summary;
        }

        return {
          ...summary,
          messages: sortedMessages,
        };
      })
      .sort((left, right) => {
        const leftTime = new Date(left.latestDate || 0).getTime();
        const rightTime = new Date(right.latestDate || 0).getTime();
        if (rightTime !== leftTime) {
          return rightTime - leftTime;
        }
        return left.subject.localeCompare(right.subject);
      });
  }

  private assignResolvedThreadKeys(messages: MailboxMessage[], ownerEmail?: string): MailboxMessage[] {
    const byCanonicalId = new Map(messages.map((message) => [message.canonicalId, message]));
    const byMessageId = new Map(
      messages.flatMap((message) => {
        const normalized = normalizeMessageId(message.messageId);
        return normalized ? [[normalized, message] as const] : [];
      }),
    );
    const resolvedKeys = new Map<string, string>();

    const resolveThreadKey = (message: MailboxMessage, stack = new Set<string>()): string => {
      if (resolvedKeys.has(message.canonicalId)) {
        return resolvedKeys.get(message.canonicalId) as string;
      }

      if (message.threadId?.trim()) {
        const direct = `imap:${message.threadId.trim()}`;
        resolvedKeys.set(message.canonicalId, direct);
        return direct;
      }

      if (stack.has(message.canonicalId)) {
        const fallback = fallbackThreadKey(message, ownerEmail);
        resolvedKeys.set(message.canonicalId, fallback);
        return fallback;
      }

      stack.add(message.canonicalId);

      const referenceCandidates = [
        normalizeMessageId(message.inReplyTo),
        ...[...extractMessageIdList(message.references)].reverse(),
      ].filter((value): value is string => Boolean(value));

      for (const parentId of referenceCandidates) {
        const parent = byMessageId.get(parentId) ?? byCanonicalId.get(parentId);
        if (parent && parent.canonicalId !== message.canonicalId) {
          const resolved = resolveThreadKey(parent, stack);
          resolvedKeys.set(message.canonicalId, resolved);
          stack.delete(message.canonicalId);
          return resolved;
        }
      }

      const syntheticReferenceRoot = extractMessageIdList(message.references)[0] || normalizeMessageId(message.inReplyTo);
      if (syntheticReferenceRoot) {
        const synthetic = `ref:${syntheticReferenceRoot}`;
        resolvedKeys.set(message.canonicalId, synthetic);
        stack.delete(message.canonicalId);
        return synthetic;
      }

      const fallback = fallbackThreadKey(message, ownerEmail);
      resolvedKeys.set(message.canonicalId, fallback);
      stack.delete(message.canonicalId);
      return fallback;
    };

    return messages.map((message) => ({
      ...message,
      threadKey: resolveThreadKey(message),
    }));
  }

  private closeDb(): void {
    if (this.db) {
      this.db.close();
      this.db = undefined;
      this.initialized = false;
    }
  }
}
