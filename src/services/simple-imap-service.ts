import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ImapFlow, type FetchMessageObject, type ListResponse, type SearchObject } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import type {
  AttachmentContentResult,
  EmailDetail,
  EmailSummary,
  FolderInfo,
  GetEmailsInput,
  MailboxSyncCheckpoint,
  ProtonMailConfig,
  RemoteDraftRef,
  SearchEmailsInput,
  SendEmailInput,
  SyncEmailsInput,
} from "../types/index.js";
import {
  classifyAttachment,
  createEmailId,
  dedupeEmails,
  extractAttachments,
  extractMessageIdList,
  isTextLikeMimeType,
  mapEnvelopeAddresses,
  mapParsedAddresses,
  matchesLocalSearchFilters,
  nextDay,
  normalizeLimit,
  parseDateInput,
  parseEmailId,
  previewText,
  sanitizeFileName,
  sortEmailsByNewest,
  stripHtmlToText,
  summarizeCalendarText,
} from "../utils/helpers.js";
import { logger, type Logger } from "../utils/logger.js";

const FETCH_SUMMARY_QUERY = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
  labels: true,
} as const;

const FETCH_DETAIL_QUERY = {
  ...FETCH_SUMMARY_QUERY,
  source: true,
} as const;

const MAX_ATTACHMENT_TEXT_BYTES = 512_000;

export function isLikelyAuthenticationError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const values: string[] = [];

  if (error instanceof Error) {
    values.push(error.message);
    values.push(error.name);
    const maybeResponseText = (error as { responseText?: unknown }).responseText;
    if (typeof maybeResponseText === "string") {
      values.push(maybeResponseText);
    }
  } else if (typeof error === "string") {
    values.push(error);
  } else if (typeof error === "object") {
    const maybeMessage = (error as { message?: unknown }).message;
    const maybeCode = (error as { code?: unknown }).code;
    const maybeResponse = (error as { response?: unknown }).response;
    if (typeof maybeMessage === "string") {
      values.push(maybeMessage);
    }
    if (typeof maybeCode === "string") {
      values.push(maybeCode);
    }
    if (typeof maybeResponse === "string") {
      values.push(maybeResponse);
    }
  }

  const haystack = values.join(" ").toLowerCase();
  if (!haystack) {
    return false;
  }

  return [
    "auth",
    "login failed",
    "incorrect login credentials",
    "invalid credentials",
    "authentication failed",
    "no such user",
    "too many login attempts",
  ].some((needle) => haystack.includes(needle));
}

export interface FolderSyncPlan {
  folder: string;
  strategy: MailboxSyncCheckpoint["strategy"];
  changed: boolean;
  startUid?: number;
  endUid?: number;
  highestKnownUid: number;
}

export function planFolderSync(input: {
  folder: string;
  exists: number;
  uidNext?: number;
  uidValidity?: string;
  full: boolean;
  limit: number;
  checkpoint?: MailboxSyncCheckpoint;
}): FolderSyncPlan {
  const uidNext = input.uidNext ?? 1;
  const highestKnownUid = Math.max(0, uidNext - 1);

  if (input.exists === 0 || highestKnownUid === 0) {
    return {
      folder: input.folder,
      strategy: "empty",
      changed: false,
      highestKnownUid,
    };
  }

  if (input.full) {
    return {
      folder: input.folder,
      strategy: "full",
      changed: true,
      startUid: Math.max(1, highestKnownUid - input.limit + 1),
      endUid: highestKnownUid,
      highestKnownUid,
    };
  }

  if (
    !input.checkpoint ||
    !input.checkpoint.highestUid ||
    (input.checkpoint.uidValidity && input.uidValidity && input.checkpoint.uidValidity !== input.uidValidity)
  ) {
    return {
      folder: input.folder,
      strategy: "recent",
      changed: true,
      startUid: Math.max(1, highestKnownUid - input.limit + 1),
      endUid: highestKnownUid,
      highestKnownUid,
    };
  }

  const overlap = Math.min(input.limit, Math.max(25, Math.min(100, Math.ceil(input.limit / 2))));
  const changed =
    highestKnownUid > (input.checkpoint.highestUid ?? 0) ||
    uidNext !== (input.checkpoint.uidNext ?? uidNext) ||
    input.exists !== (input.checkpoint.total ?? input.exists);
  return {
    folder: input.folder,
    strategy: changed ? "incremental" : "incremental_window",
    changed,
    startUid: Math.max(1, Math.min(highestKnownUid, input.checkpoint.highestUid) - overlap + 1),
    endUid: highestKnownUid,
    highestKnownUid,
  };
}

function mapFolder(entry: ListResponse): FolderInfo {
  return {
    path: entry.path,
    name: entry.name,
    delimiter: entry.delimiter,
    specialUse: entry.specialUse,
    listed: entry.listed,
    subscribed: entry.subscribed,
    flags: [...entry.flags],
    messages: entry.status?.messages,
    unseen: entry.status?.unseen,
    uidNext: entry.status?.uidNext,
  };
}

function createParsedAttachmentId(
  attachment: NonNullable<ParsedMail["attachments"]>[number],
  index: number,
): string {
  return attachment.checksum || attachment.cid || `attachment-${index + 1}`;
}

export class SimpleIMAPService {
  private client?: ImapFlow;
  private folderCache?: FolderInfo[];
  private readonly messageCache = new Map<string, EmailSummary>();
  private lastSyncAt?: string;
  private lastIdleAt?: string;
  private lastIdleChangeAt?: string;
  private lastIdleEventCount?: number;
  private lastIdleError?: string;

  constructor(
    private readonly config: ProtonMailConfig,
    private readonly log: Logger = logger,
  ) {}

  async connect(): Promise<void> {
    if (this.client?.usable) {
      return;
    }

    await this.disconnect();

    const client = new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.secure,
      doSTARTTLS: this.config.imap.secure ? undefined : true,
      auth: {
        user: this.config.imap.username,
        pass: this.config.imap.password,
      },
      tls: this.shouldRelaxTlsVerification() ? { rejectUnauthorized: false } : undefined,
      disableAutoIdle: true,
      maxIdleTime: this.config.runtime.idleMaxSeconds * 1000,
      logger: false,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
    });

    client.on("error", (error) => {
      this.log.warn("IMAP client error", "IMAPService", error);
    });

    await client.connect();
    this.client = client;
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      if (this.client.usable) {
        await this.client.logout();
      } else {
        this.client.close();
      }
    } catch (error) {
      this.log.warn("IMAP disconnect failed", "IMAPService", error);
      this.client.close();
    } finally {
      this.client = undefined;
    }
  }

  isConnected(): boolean {
    return Boolean(this.client?.usable);
  }

  async ping(): Promise<void> {
    const client = await this.ensureConnected();
    await client.noop();
  }

  getIdleStatus(): Record<string, unknown> {
    return {
      enabled: this.config.runtime.idleWatchEnabled,
      connected: this.isConnected(),
      maxSeconds: this.config.runtime.idleMaxSeconds,
      lastIdleAt: this.lastIdleAt,
      lastIdleChangeAt: this.lastIdleChangeAt,
      lastIdleEventCount: this.lastIdleEventCount,
      lastIdleError: this.lastIdleError,
    };
  }

  async waitForMailboxChanges(input: {
    folder?: string;
    timeoutMs?: number;
  } = {}): Promise<{
    folder: string;
    timeoutMs: number;
    checkedAt: string;
    changed: boolean;
    events: Array<Record<string, unknown>>;
  }> {
    const folder = input.folder?.trim() || "INBOX";
    const timeoutMs = normalizeLimit(input.timeoutMs, this.config.runtime.idleMaxSeconds * 1000, 1_000, 300_000);
    const client = await this.ensureConnected();
    return this.waitForMailboxChangesWithClient(client, folder, timeoutMs, true);
  }

  private async waitForMailboxChangesWithClient(
    client: ImapFlow,
    folder: string,
    timeoutMs: number,
    allowReconnectRetry: boolean,
  ): Promise<{
    folder: string;
    timeoutMs: number;
    checkedAt: string;
    changed: boolean;
    events: Array<Record<string, unknown>>;
  }> {
    const idleClient = client as unknown as {
      maxIdleTime?: number | false;
      preCheck?: false | (() => Promise<void>);
    };
    const previousMaxIdle = idleClient.maxIdleTime;
    const events: Array<Record<string, unknown>> = [];
    let idleBreakRequested = false;

    const requestIdleBreak = () => {
      if (idleBreakRequested) {
        return;
      }
      idleBreakRequested = true;

      const breaker = idleClient.preCheck;
      if (typeof breaker === "function") {
        breaker().catch((error) => {
          this.log.warn("Failed to break IMAP IDLE probe", "IMAPService", {
            folder,
            error,
          });
        });
      }
    };

    const onExists = (event: { count?: number; exists?: number }) => {
      const mailbox = client.mailbox || undefined;
      events.push({ type: "exists", count: event.count ?? event.exists ?? mailbox?.exists });
      requestIdleBreak();
    };
    const onExpunge = (event: { seq?: number }) => {
      events.push({ type: "expunge", seq: event.seq });
      requestIdleBreak();
    };
    const onFlags = (event: { seq?: number; uid?: number }) => {
      events.push({ type: "flags", seq: event.seq, uid: event.uid });
      requestIdleBreak();
    };

    client.on("exists", onExists);
    client.on("expunge", onExpunge);
    client.on("flags", onFlags);

    const lock = await client.getMailboxLock(folder, { readOnly: true });
    const timeout = setTimeout(() => {
      requestIdleBreak();
    }, timeoutMs);
    timeout.unref?.();

    try {
      idleClient.maxIdleTime = timeoutMs;
      await client.idle();
      const checkedAt = new Date().toISOString();
      const changed = events.length > 0;
      this.lastIdleAt = checkedAt;
      this.lastIdleError = undefined;
      if (changed) {
        this.lastIdleChangeAt = checkedAt;
        this.lastIdleEventCount = events.length;
      }
      return {
        folder,
        timeoutMs,
        checkedAt,
        changed,
        events,
      };
    } catch (error) {
      this.lastIdleError = error instanceof Error ? error.message : String(error);
      if (allowReconnectRetry && !isLikelyAuthenticationError(error)) {
        await this.disconnect();
        const freshClient = await this.ensureConnected();
        return this.waitForMailboxChangesWithClient(freshClient, folder, timeoutMs, false);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      lock.release();
      client.off("exists", onExists);
      client.off("expunge", onExpunge);
      client.off("flags", onFlags);
      idleClient.maxIdleTime = previousMaxIdle;
    }
  }

  async getFolders(forceRefresh = false): Promise<FolderInfo[]> {
    if (this.folderCache && !forceRefresh) {
      return this.folderCache;
    }

    const client = await this.ensureConnected();
    const folders = await client.list({
      statusQuery: {
        messages: true,
        unseen: true,
        uidNext: true,
      },
    });

    this.folderCache = folders.map(mapFolder);
    return this.folderCache;
  }

  async syncFolders(): Promise<{ syncedAt: string; folders: FolderInfo[] }> {
    const folders = await this.getFolders(true);
    const syncedAt = new Date().toISOString();
    return { syncedAt, folders };
  }

  async getEmails(input: GetEmailsInput = {}): Promise<{
    folder: string;
    total: number;
    limit: number;
    offset: number;
    emails: EmailSummary[];
  }> {
    const folder = input.folder?.trim() || "INBOX";
    const limit = normalizeLimit(input.limit, 50);
    const offset = normalizeLimit(input.offset, 0, 0, 10_000);

    return this.withMailbox(folder, true, async (client) => {
      const total = client.mailbox && client.mailbox.exists ? client.mailbox.exists : 0;
      if (total === 0 || offset >= total) {
        return { folder, total, limit, offset, emails: [] };
      }

      const endSeq = total - offset;
      const startSeq = Math.max(1, endSeq - limit + 1);
      const emails: EmailSummary[] = [];

      for await (const message of client.fetch(`${startSeq}:${endSeq}`, FETCH_SUMMARY_QUERY)) {
        const summary = this.toSummary(folder, message);
        emails.push(summary);
        this.messageCache.set(summary.id, summary);
      }

      return {
        folder,
        total,
        limit,
        offset,
        emails: sortEmailsByNewest(emails),
      };
    });
  }

  async getEmailById(emailId: string): Promise<EmailDetail> {
    const { folder, uid } = parseEmailId(emailId);

    return this.withMailbox(folder, true, async (client) => {
      const message = await client.fetchOne(String(uid), FETCH_DETAIL_QUERY, { uid: true });
      if (!message) {
        throw new Error(`Email not found for id ${emailId}`);
      }

      const summary = this.toSummary(folder, message);
      const parsed = message.source ? await this.parseSource(message.source) : undefined;
      const enriched = parsed ? this.enrichSummaryFromParsed(summary, parsed, true) : summary;

      const detail: EmailDetail = {
        ...enriched,
        text: parsed?.text || stripHtmlToText(typeof parsed?.html === "string" ? parsed.html : undefined),
        html: parsed?.html,
        headers: this.mapHeaders(parsed),
      };

      this.messageCache.set(detail.id, detail);
      return detail;
    });
  }

  async searchEmails(input: SearchEmailsInput = {}): Promise<{
    folders: string[];
    limit: number;
    total: number;
    emails: EmailSummary[];
  }> {
    const limit = normalizeLimit(input.limit, 100);
    const folders = await this.resolveFolders(input.folder);
    const searchQuery = this.buildSearchQuery(input);
    const collected: EmailSummary[] = [];

    for (const folder of folders) {
      const emails = await this.withMailbox(folder, true, async (client) => {
        const searchResult = await client.search(searchQuery, { uid: true });
        const uids = searchResult || [];
        if (uids.length === 0) {
          return [];
        }

        const targetUids = [...uids].slice(-limit).reverse();
        const results: EmailSummary[] = [];

        for await (const message of client.fetch(targetUids, FETCH_SUMMARY_QUERY, { uid: true })) {
          const summary = this.toSummary(folder, message);
          results.push(summary);
          this.messageCache.set(summary.id, summary);
        }

        return results.filter((email) => matchesLocalSearchFilters(email, input));
      });

      collected.push(...emails);
    }

    const sorted = sortEmailsByNewest(dedupeEmails(collected)).slice(0, limit);
    return {
      folders,
      limit,
      total: sorted.length,
      emails: sorted,
    };
  }

  async listAttachments(emailId: string): Promise<{
    emailId: string;
    attachments: EmailDetail["attachments"];
  }> {
    const detail = await this.getEmailById(emailId);
    return {
      emailId,
      attachments: detail.attachments,
    };
  }

  async saveAttachments(input: {
    emailId: string;
    outputPath?: string;
    includeInline?: boolean;
    filenameContains?: string;
    contentType?: string;
  }): Promise<{
    emailId: string;
    saved: AttachmentContentResult[];
    skipped: number;
  }> {
    const attachmentList = await this.listAttachments(input.emailId);
    const saved: AttachmentContentResult[] = [];
    let skipped = 0;

    for (const attachment of attachmentList.attachments) {
      if (!input.includeInline && attachment.isInline) {
        skipped += 1;
        continue;
      }
      if (
        input.filenameContains &&
        !(attachment.filename || "").toLowerCase().includes(input.filenameContains.toLowerCase())
      ) {
        skipped += 1;
        continue;
      }
      if (
        input.contentType &&
        (attachment.contentType || "").toLowerCase() !== input.contentType.toLowerCase()
      ) {
        skipped += 1;
        continue;
      }

      const attachmentId = attachment.id || attachment.filename || attachment.checksum;
      if (!attachmentId) {
        skipped += 1;
        continue;
      }

      const targetPath =
        input.outputPath && attachment.filename
          ? join(resolve(input.outputPath), sanitizeFileName(attachment.filename, attachmentId))
          : input.outputPath;

      saved.push(await this.saveAttachment(input.emailId, attachmentId, targetPath));
    }

    return {
      emailId: input.emailId,
      saved,
      skipped,
    };
  }

  async getAttachmentContent(
    emailId: string,
    attachmentId: string,
    includeBase64 = false,
  ): Promise<AttachmentContentResult> {
    const attachment = await this.getParsedAttachment(emailId, attachmentId);
    const base64 = attachment.content.toString("base64");

    return {
      emailId,
      attachment: {
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        disposition: attachment.disposition,
        cid: attachment.cid,
        checksum: attachment.checksum,
        isInline: attachment.isInline,
        kind: attachment.kind,
        isCalendarInvite: attachment.isCalendarInvite,
        isSignature: attachment.isSignature,
      },
      text:
        attachment.content.length <= MAX_ATTACHMENT_TEXT_BYTES
          ? attachment.contentType?.toLowerCase() === "text/html"
            ? stripHtmlToText(attachment.content.toString("utf8"))
            : attachment.contentType?.toLowerCase() === "text/calendar"
              ? summarizeCalendarText(attachment.content.toString("utf8"))
              : isTextLikeMimeType(attachment.contentType)
              ? attachment.content.toString("utf8")
              : undefined
          : undefined,
      base64: includeBase64 ? base64 : undefined,
    };
  }

  async saveAttachment(
    emailId: string,
    attachmentId: string,
    outputPath?: string,
  ): Promise<AttachmentContentResult> {
    const attachment = await this.getParsedAttachment(emailId, attachmentId);
    const path = await this.resolveAttachmentOutputPath(emailId, attachment, outputPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, attachment.content);

    return {
      emailId,
      attachment: {
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        disposition: attachment.disposition,
        cid: attachment.cid,
        checksum: attachment.checksum,
        isInline: attachment.isInline,
        kind: attachment.kind,
        isCalendarInvite: attachment.isCalendarInvite,
        isSignature: attachment.isSignature,
      },
      outputPath: path,
    };
  }

  async markEmailRead(emailId: string, isRead = true): Promise<{
    emailId: string;
    folder: string;
    uid: number;
    isRead: boolean;
  }> {
    const { folder, uid } = parseEmailId(emailId);

    await this.withMailbox(folder, false, async (client) => {
      if (isRead) {
        await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
      }
    });

    this.updateCachedMessage(emailId, (email) => ({ ...email, isRead }));
    return { emailId, folder, uid, isRead };
  }

  async starEmail(emailId: string, isStarred = true): Promise<{
    emailId: string;
    folder: string;
    uid: number;
    isStarred: boolean;
  }> {
    const { folder, uid } = parseEmailId(emailId);

    await this.withMailbox(folder, false, async (client) => {
      if (isStarred) {
        await client.messageFlagsAdd(String(uid), ["\\Flagged"], { uid: true });
      } else {
        await client.messageFlagsRemove(String(uid), ["\\Flagged"], { uid: true });
      }
    });

    this.updateCachedMessage(emailId, (email) => ({ ...email, isStarred }));
    return { emailId, folder, uid, isStarred };
  }

  async moveEmail(emailId: string, targetFolder: string): Promise<{
    emailId: string;
    sourceEmailId: string;
    fromFolder: string;
    targetFolder: string;
    uid: number;
    targetUid?: number;
    targetEmailId?: string;
  }> {
    const { folder, uid } = parseEmailId(emailId);
    let targetUid: number | undefined;

    await this.withMailbox(folder, false, async (client) => {
      const moved = await client.messageMove(String(uid), targetFolder, { uid: true });
      if (moved === false) {
        throw new Error(`Server did not move email ${emailId} to ${targetFolder}`);
      }
      targetUid = moved.uidMap?.get(uid);
    });

    const cached = this.messageCache.get(emailId);
    this.messageCache.delete(emailId);
    const targetEmailId = targetUid ? createEmailId(targetFolder, targetUid) : undefined;
    if (cached && targetUid && targetEmailId) {
      this.messageCache.set(targetEmailId, {
        ...cached,
        id: targetEmailId,
        folder: targetFolder,
        uid: targetUid,
      });
    }
    this.lastSyncAt = new Date().toISOString();

    return {
      emailId,
      sourceEmailId: emailId,
      fromFolder: folder,
      targetFolder,
      uid,
      targetUid,
      targetEmailId,
    };
  }

  async deleteEmail(emailId: string): Promise<{
    emailId: string;
    folder: string;
    uid: number;
    deleted: true;
  }> {
    const { folder, uid } = parseEmailId(emailId);

    await this.withMailbox(folder, false, async (client) => {
      const deleted = await client.messageDelete(String(uid), { uid: true });
      if (!deleted) {
        throw new Error(`Server did not delete email ${emailId}`);
      }
    });

    this.messageCache.delete(emailId);
    this.lastSyncAt = new Date().toISOString();

    return {
      emailId,
      folder,
      uid,
      deleted: true,
    };
  }

  async syncEmails(input: SyncEmailsInput = {}): Promise<{
    syncedAt: string;
    full: boolean;
    folders: Array<MailboxSyncCheckpoint>;
    cachedMessages: number;
  }> {
    const snapshot = await this.collectEmailsForIndex(input);
    return {
      syncedAt: snapshot.syncedAt,
      full: snapshot.full,
      folders: snapshot.folderStats,
      cachedMessages: this.messageCache.size,
    };
  }

  async collectEmailsForIndex(input: SyncEmailsInput = {}): Promise<{
    syncedAt: string;
    full: boolean;
    folders: FolderInfo[];
    folderStats: Array<MailboxSyncCheckpoint>;
    emails: EmailSummary[];
  }> {
    const folders = await this.resolveFolders(input.folder);
    const full = Boolean(input.full);
    const limit = normalizeLimit(input.limitPerFolder, full ? 250 : 50, 1, 500);
    const includeAttachmentText = input.includeAttachmentText !== false;
    const folderStats: Array<MailboxSyncCheckpoint> = [];
    const emails: EmailSummary[] = [];
    const syncedAt = new Date().toISOString();

    for (const folder of folders) {
      const batch = await this.collectFolderForIndex(folder, {
        full,
        limit,
        includeAttachmentText,
        checkpoint: input.checkpoints?.[folder],
        syncedAt,
      });
      folderStats.push(batch.checkpoint);
      emails.push(...batch.emails);
    }

    this.lastSyncAt = syncedAt;
    return {
      syncedAt,
      full,
      folders: await this.getFolders(true),
      folderStats,
      emails,
    };
  }

  private async collectFolderForIndex(
    folder: string,
    input: {
      full: boolean;
      limit: number;
      includeAttachmentText: boolean;
      checkpoint?: MailboxSyncCheckpoint;
      syncedAt: string;
    },
  ): Promise<{
    checkpoint: MailboxSyncCheckpoint;
    emails: EmailSummary[];
  }> {
    return this.withMailbox(folder, true, async (client) => {
      const mailbox = client.mailbox || undefined;
      const uidNext = mailbox?.uidNext;
      const uidValidity = mailbox?.uidValidity?.toString();
      const exists = mailbox?.exists ?? 0;
      const plan = planFolderSync({
        folder,
        exists,
        uidNext,
        uidValidity,
        full: input.full,
        limit: input.limit,
        checkpoint: input.checkpoint,
      });

      if (!plan.startUid || !plan.endUid || plan.endUid < plan.startUid) {
        return {
          checkpoint: {
            folder,
            uidValidity,
            uidNext,
            highestUid: plan.highestKnownUid,
            lastSyncAt: input.syncedAt,
            lastFullSyncAt:
              plan.strategy === "full"
                ? input.syncedAt
                : input.checkpoint?.lastFullSyncAt,
            strategy: plan.strategy,
            changed: plan.changed,
            fetched: 0,
            total: exists,
          },
          emails: [],
        };
      }

      const emails: EmailSummary[] = [];
      for await (const message of client.fetch(`${plan.startUid}:${plan.endUid}`, FETCH_DETAIL_QUERY, { uid: true })) {
        const summary = this.toSummary(folder, message);
        if (!message.source) {
          emails.push(summary);
          this.messageCache.set(summary.id, summary);
          continue;
        }

        try {
          const parsed = await this.parseSource(message.source);
          const enriched = this.enrichSummaryFromParsed(summary, parsed, input.includeAttachmentText);
          emails.push(enriched);
          this.messageCache.set(enriched.id, enriched);
        } catch (error) {
          this.log.warn("Failed to parse message source during indexing", "IMAPService", {
            folder,
            uid: message.uid,
            error,
          });
          emails.push(summary);
          this.messageCache.set(summary.id, summary);
        }
      }

      const highestUid = emails.reduce((max, email) => Math.max(max, email.uid), 0) || plan.highestKnownUid;
      return {
        checkpoint: {
          folder,
          uidValidity,
          uidNext,
          highestUid,
          lastSyncAt: input.syncedAt,
          lastFullSyncAt:
            plan.strategy === "full"
              ? input.syncedAt
              : input.checkpoint?.lastFullSyncAt,
          strategy: plan.strategy,
          changed: plan.changed,
          fetched: emails.length,
          total: exists,
        },
        emails,
      };
    });
  }

  async archiveEmail(emailId: string): Promise<{
    emailId: string;
    sourceEmailId: string;
    fromFolder: string;
    targetFolder: string;
    uid: number;
    targetUid?: number;
    targetEmailId?: string;
  }> {
    const targetFolder = await this.resolveSpecialFolder("\\Archive", ["Archive", "All Mail"]);
    return this.moveEmail(emailId, targetFolder);
  }

  async trashEmail(emailId: string): Promise<{
    emailId: string;
    sourceEmailId: string;
    fromFolder: string;
    targetFolder: string;
    uid: number;
    targetUid?: number;
    targetEmailId?: string;
  }> {
    const targetFolder = await this.resolveSpecialFolder("\\Trash", ["Trash"]);
    return this.moveEmail(emailId, targetFolder);
  }

  async restoreEmail(
    emailId: string,
    targetFolder?: string,
  ): Promise<{
    emailId: string;
    sourceEmailId: string;
    fromFolder: string;
    targetFolder: string;
    uid: number;
    targetUid?: number;
    targetEmailId?: string;
  }> {
    const destination =
      targetFolder?.trim() || (await this.resolveSpecialFolder("\\Inbox", ["INBOX"]));
    return this.moveEmail(emailId, destination);
  }

  async getAnalyticsSample(days = 30, limitPerFolder = 100): Promise<EmailSummary[]> {
    const dateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const folders = await this.resolveFolders();
    const emails: EmailSummary[] = [];

    for (const folder of folders) {
      const result = await this.searchEmails({
        folder,
        dateFrom,
        limit: limitPerFolder,
      });
      emails.push(...result.emails);
    }

    return sortEmailsByNewest(dedupeEmails(emails));
  }

  clearCache(): { clearedMessages: number; clearedFolders: boolean } {
    const clearedMessages = this.messageCache.size;
    const clearedFolders = Boolean(this.folderCache);
    this.messageCache.clear();
    this.folderCache = undefined;
    this.lastSyncAt = undefined;

    return { clearedMessages, clearedFolders };
  }

  async listRemoteDrafts(limit = 50, offset = 0): Promise<{
    folder: string;
    total: number;
    limit: number;
    offset: number;
    emails: EmailSummary[];
  }> {
    const folder = await this.resolveSpecialFolder("\\Drafts", ["Drafts"]);
    return this.getEmails({ folder, limit, offset });
  }

  async upsertRemoteDraft(input: {
    raw: Buffer;
    messageId: string;
    existingEmailId?: string;
  }): Promise<RemoteDraftRef> {
    const folder = await this.resolveSpecialFolder("\\Drafts", ["Drafts"]);

    if (input.existingEmailId) {
      try {
        await this.deleteEmail(input.existingEmailId);
      } catch (error) {
        this.log.warn("Failed to delete previous remote draft before re-sync", "IMAPService", {
          existingEmailId: input.existingEmailId,
          error,
        });
      }
    }

    const client = await this.ensureConnected();
    const appended = await client.append(folder, input.raw, ["\\Draft"], new Date());
    if (!appended) {
      throw new Error("Server did not append the draft message");
    }

    let uid = appended.uid;
    if (!uid) {
      uid = await this.findUidByHeader(folder, "message-id", input.messageId);
    }

    this.folderCache = undefined;
    this.lastSyncAt = new Date().toISOString();

    return {
      folder,
      uid,
      emailId: uid ? createEmailId(folder, uid) : undefined,
      messageId: input.messageId,
      syncedAt: this.lastSyncAt,
    };
  }

  async deleteRemoteDraft(emailId: string): Promise<{
    emailId: string;
    folder: string;
    uid: number;
    deleted: true;
  }> {
    return this.deleteEmail(emailId);
  }

  private async ensureConnected(): Promise<ImapFlow> {
    if (!this.client?.usable) {
      await this.connect();
    }

    if (!this.client) {
      throw new Error("Failed to initialize IMAP client");
    }

    return this.client;
  }

  private shouldRelaxTlsVerification(): boolean {
    const host = this.config.imap.host.trim().toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  }

  private async withMailbox<T>(
    folder: string,
    readOnly: boolean,
    action: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(folder, { readOnly });

    try {
      return await action(client);
    } finally {
      lock.release();
    }
  }

  private buildSearchQuery(input: SearchEmailsInput): SearchObject {
    const query: SearchObject = {};

    if (input.query) {
      query.text = input.query;
    }
    if (input.from) {
      query.from = input.from;
    }
    if (input.to) {
      query.to = input.to;
    }
    if (input.subject) {
      query.subject = input.subject;
    }
    if (typeof input.isRead === "boolean") {
      query.seen = input.isRead;
    }
    if (typeof input.isStarred === "boolean") {
      query.flagged = input.isStarred;
    }

    const dateFrom = parseDateInput(input.dateFrom);
    const dateTo = parseDateInput(input.dateTo);

    if (dateFrom) {
      query.since = dateFrom;
    }
    if (dateTo) {
      query.before = nextDay(dateTo);
    }

    if (Object.keys(query).length === 0) {
      query.all = true;
    }

    return query;
  }

  private async resolveFolders(folder?: string): Promise<string[]> {
    if (folder?.trim()) {
      return [folder.trim()];
    }

    const folders = await this.getFolders();
    return folders
      .filter((entry) => !entry.flags.includes("\\Noselect"))
      .map((entry) => entry.path);
  }

  private async resolveSpecialFolder(
    specialUse: string,
    fallbacks: string[],
  ): Promise<string> {
    const folders = await this.getFolders();

    const bySpecialUse = folders.find((folder) => folder.specialUse === specialUse);
    if (bySpecialUse) {
      return bySpecialUse.path;
    }

    const byFallback = folders.find((folder) =>
      fallbacks.some((fallback) => folder.path.toLowerCase() === fallback.toLowerCase()),
    );
    if (byFallback) {
      return byFallback.path;
    }

    throw new Error(`Unable to find target folder for ${specialUse}`);
  }

  private async findUidByHeader(
    folder: string,
    header: string,
    value: string,
  ): Promise<number | undefined> {
    return this.withMailbox(folder, true, async (client) => {
      const result = await client.search(
        {
          header: {
            [header]: value,
          },
        },
        { uid: true },
      );

      if (!result || result.length === 0) {
        return undefined;
      }

      return [...result].sort((left, right) => right - left)[0];
    });
  }

  private toSummary(folder: string, message: FetchMessageObject): EmailSummary {
    const flags = [...(message.flags ?? [])];
    const attachments = extractAttachments(message.bodyStructure);

    return {
      id: createEmailId(folder, message.uid),
      folder,
      uid: message.uid,
      seq: message.seq,
      messageId: message.envelope?.messageId,
      inReplyTo: message.envelope?.inReplyTo,
      references: [],
      threadId: message.threadId,
      subject: message.envelope?.subject || "(no subject)",
      from: mapEnvelopeAddresses(message.envelope?.from),
      to: mapEnvelopeAddresses(message.envelope?.to),
      cc: mapEnvelopeAddresses(message.envelope?.cc),
      bcc: mapEnvelopeAddresses(message.envelope?.bcc),
      replyTo: mapEnvelopeAddresses(message.envelope?.replyTo),
      date: message.envelope?.date?.toISOString(),
      internalDate:
        message.internalDate instanceof Date
          ? message.internalDate.toISOString()
          : message.internalDate,
      isRead: flags.includes("\\Seen"),
      isStarred: flags.includes("\\Flagged"),
      flags,
      size: message.size,
      preview: undefined,
      hasAttachments: attachments.length > 0,
      attachments,
      attachmentText: undefined,
      labels: [...(message.labels ?? [])],
    };
  }

  private enrichSummaryFromParsed(
    summary: EmailSummary,
    parsed: ParsedMail,
    includeAttachmentText: boolean,
  ): EmailSummary {
    const parsedAttachments = this.mapParsedAttachments(parsed);
    const htmlText = stripHtmlToText(typeof parsed.html === "string" ? parsed.html : undefined);
    const references = extractMessageIdList(this.readHeaderValue(parsed, "references"));

    return {
      ...summary,
      subject: parsed.subject || summary.subject,
      from: parsed.from ? mapParsedAddresses(parsed.from) : summary.from,
      to: parsed.to ? mapParsedAddresses(parsed.to) : summary.to,
      cc: parsed.cc ? mapParsedAddresses(parsed.cc) : summary.cc,
      bcc: parsed.bcc ? mapParsedAddresses(parsed.bcc) : summary.bcc,
      replyTo: parsed.replyTo ? mapParsedAddresses(parsed.replyTo) : summary.replyTo,
      preview: previewText(parsed.text || htmlText || summary.preview),
      references,
      attachments:
        parsedAttachments.length > 0 && parsedAttachments.length >= summary.attachments.length
          ? parsedAttachments
          : summary.attachments,
      hasAttachments: summary.hasAttachments || parsedAttachments.length > 0,
      attachmentText: includeAttachmentText ? this.extractAttachmentSearchText(parsed) : undefined,
    };
  }

  private async parseSource(source: Buffer): Promise<ParsedMail> {
    return simpleParser(source);
  }

  private readHeaderValue(parsed: ParsedMail | undefined, headerName: string): string | undefined {
    if (!parsed) {
      return undefined;
    }

    const value = parsed.headers.get(headerName);
    if (Array.isArray(value)) {
      return value.map((entry) => String(entry)).join(" ");
    }
    if (value === undefined || value === null) {
      return undefined;
    }
    return String(value);
  }

  private extractAttachmentSearchText(parsed: ParsedMail): string | undefined {
    const parts = (parsed.attachments ?? [])
      .flatMap((attachment) => {
        if (attachment.content.length > MAX_ATTACHMENT_TEXT_BYTES) {
          return [];
        }

        const contentType = attachment.contentType?.toLowerCase();
        if (contentType === "text/html") {
          return [stripHtmlToText(attachment.content.toString("utf8")) || ""];
        }

        if (contentType === "text/calendar") {
          return [summarizeCalendarText(attachment.content.toString("utf8")) || ""];
        }

        if (isTextLikeMimeType(contentType)) {
          return [previewText(attachment.content.toString("utf8"), 8_000) || ""];
        }

        return [];
      })
      .filter(Boolean);

    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  private mapParsedAttachments(parsed?: ParsedMail): EmailDetail["attachments"] {
    return (parsed?.attachments ?? []).map((attachment, index) => {
      const classification = classifyAttachment({
        filename: attachment.filename,
        contentType: attachment.contentType,
        disposition: attachment.contentDisposition,
        cid: attachment.cid,
      });

      return {
        id: createParsedAttachmentId(attachment, index),
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        disposition: attachment.contentDisposition,
        cid: attachment.cid,
        checksum: attachment.checksum,
        isInline: attachment.contentDisposition === "inline",
        kind: classification.kind,
        isCalendarInvite: classification.isCalendarInvite,
        isSignature: classification.isSignature,
      };
    });
  }

  private mapHeaders(parsed?: ParsedMail): Record<string, string | string[]> {
    if (!parsed) {
      return {};
    }

    return Object.fromEntries(
      [...parsed.headers.entries()].map(([key, value]) => {
        if (Array.isArray(value)) {
          return [key, value.map((item) => String(item))];
        }
        return [key, String(value)];
      }),
    );
  }

  private updateCachedMessage(
    emailId: string,
    updater: (email: EmailSummary) => EmailSummary,
  ): void {
    const cached = this.messageCache.get(emailId);
    if (!cached) {
      return;
    }

    this.messageCache.set(emailId, updater(cached));
  }

  private async getParsedAttachment(
    emailId: string,
    attachmentId: string,
  ): Promise<
    EmailDetail["attachments"][number] & {
      content: Buffer;
      checksum?: string;
    }
  > {
    const detail = await this.getEmailById(emailId);
    const parsed = await this.loadParsedMail(emailId);
    const attachments = (parsed.attachments ?? []).map((attachment, index) => ({
      id: createParsedAttachmentId(attachment, index),
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      disposition: attachment.contentDisposition,
      cid: attachment.cid,
      checksum: attachment.checksum,
      isInline: attachment.contentDisposition === "inline",
      ...classifyAttachment({
        filename: attachment.filename,
        contentType: attachment.contentType,
        disposition: attachment.contentDisposition,
        cid: attachment.cid,
      }),
      content: attachment.content,
    }));

    const match = attachments.find(
      (attachment) =>
        attachment.id === attachmentId ||
        attachment.filename === attachmentId ||
        attachment.checksum === attachmentId,
    );

    if (!match) {
      throw new Error(`Attachment ${attachmentId} not found on email ${detail.id}`);
    }

    return match;
  }

  private async loadParsedMail(emailId: string): Promise<ParsedMail> {
    const { folder, uid } = parseEmailId(emailId);

    return this.withMailbox(folder, true, async (client) => {
      const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!message || !message.source) {
        throw new Error(`Email not found for id ${emailId}`);
      }
      const source = message.source;
      return this.parseSource(source);
    });
  }

  private async resolveAttachmentOutputPath(
    emailId: string,
    attachment: { id?: string; filename?: string },
    outputPath?: string,
  ): Promise<string> {
    const filename = sanitizeFileName(attachment.filename, attachment.id || "attachment");
    if (!outputPath) {
      return join(this.config.dataDir, "attachments", encodeURIComponent(emailId), filename);
    }

    const resolved = resolve(outputPath);
    try {
      const existing = await stat(resolved);
      if (existing.isDirectory()) {
        return join(resolved, filename);
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code !== "ENOENT"
      ) {
        throw error;
      }
    }

    if (resolved.endsWith("/") || resolved.endsWith("\\")) {
      return join(resolved, filename);
    }

    return resolved;
  }
}
