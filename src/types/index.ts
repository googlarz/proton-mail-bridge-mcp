export interface ProtonConnectionConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export interface ProtonMailConfig {
  smtp: ProtonConnectionConfig;
  imap: ProtonConnectionConfig;
  dataDir: string;
  debug: boolean;
  cacheEnabled: boolean;
  analyticsEnabled: boolean;
  autoSync: boolean;
  syncInterval: number;
  runtime: ProtonRuntimeConfig;
}

export interface EmailAddress {
  name?: string;
  address?: string;
}

export interface EmailAttachmentInput {
  filename: string;
  content: string;
  contentType?: string;
  cid?: string;
  contentDisposition?: string;
}

export interface SendEmailInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  priority?: "high" | "normal" | "low";
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  messageId?: string;
  attachments?: EmailAttachmentInput[];
}

export interface EmailAttachmentSummary {
  id?: string;
  filename?: string;
  contentType?: string;
  size?: number;
  disposition?: string;
  part?: string;
  cid?: string;
  checksum?: string;
  isInline?: boolean;
}

export interface EmailSummary {
  id: string;
  folder: string;
  uid: number;
  seq: number;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  date?: string;
  internalDate?: string;
  isRead: boolean;
  isStarred: boolean;
  flags: string[];
  size?: number;
  preview?: string;
  hasAttachments: boolean;
  attachments: EmailAttachmentSummary[];
  attachmentText?: string;
  labels: string[];
}

export interface EmailDetail extends EmailSummary {
  text?: string;
  html?: string | false;
  headers: Record<string, string | string[]>;
}

export type DraftMode = "compose" | "reply" | "forward";
export type DraftStatus = "draft" | "sent";

export interface DraftSendResult {
  messageId?: string;
  accepted: string[];
  rejected: string[];
  response: string;
}

export interface RemoteDraftRef {
  folder: string;
  uid?: number;
  emailId?: string;
  messageId?: string;
  syncedAt: string;
}

export interface DraftRecord {
  id: string;
  status: DraftStatus;
  mode: DraftMode;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  isHtml: boolean;
  priority?: "high" | "normal" | "low";
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  draftMessageId: string;
  attachments: EmailAttachmentInput[];
  sourceEmailId?: string;
  sourceMessageId?: string;
  notes?: string;
  remoteSyncState: "local_only" | "synced" | "sync_failed";
  remoteSyncError?: string;
  remoteDraft?: RemoteDraftRef;
  lastSendResult?: DraftSendResult;
}

export interface MailboxMessageLocation {
  emailId: string;
  folder: string;
  uid: number;
  labels: string[];
  specialUse?: string;
  isRead: boolean;
  isStarred: boolean;
}

export interface MailboxMessage extends EmailSummary {
  canonicalId: string;
  primaryEmailId: string;
  threadKey: string;
  mailboxRole: string;
  normalizedLabels: string[];
  locations: MailboxMessageLocation[];
}

export interface MailboxLabel {
  id: string;
  name: string;
  type: "folder" | "label" | "special_use";
  messageCount: number;
  unreadCount: number;
  threadCount: number;
  specialUse?: string;
}

export interface ThreadSummary {
  id: string;
  subject: string;
  messageCount: number;
  unreadCount: number;
  latestDate?: string;
  participants: EmailAddress[];
  normalizedLabels: string[];
  messageIds: string[];
}

export interface ThreadDetail extends ThreadSummary {
  messages: MailboxMessage[];
}

export interface ActionableThreadSummary extends ThreadSummary {
  latestEmailId?: string;
  latestPreview?: string;
  latestFrom: EmailAddress[];
  latestIsRead: boolean;
  latestIsStarred: boolean;
  latestHasAttachments: boolean;
  pendingOn: "you" | "them" | "unknown";
  score: number;
}

export type EmailAction =
  | "mark_read"
  | "mark_unread"
  | "star"
  | "unstar"
  | "archive"
  | "trash"
  | "restore";

export interface BatchActionEntry {
  emailId: string;
  ok: boolean;
  action: EmailAction;
  result?: unknown;
  error?: string;
}

export interface BatchActionResult {
  action: EmailAction;
  total: number;
  succeeded: number;
  failed: number;
  results: BatchActionEntry[];
}

export interface AttachmentContentResult {
  emailId: string;
  attachment: EmailAttachmentSummary;
  text?: string;
  base64?: string;
  outputPath?: string;
}

export interface CitationSource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  provider?: string;
  snippet?: string;
  locator?: Record<string, unknown>;
}

export interface FolderInfo {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: string;
  listed: boolean;
  subscribed: boolean;
  flags: string[];
  messages?: number;
  unseen?: number;
  uidNext?: number;
}

export interface GetEmailsInput {
  folder?: string;
  limit?: number;
  offset?: number;
}

export interface SearchEmailsInput {
  query?: string;
  folder?: string;
  label?: string;
  threadId?: string;
  from?: string;
  to?: string;
  subject?: string;
  hasAttachment?: boolean;
  attachmentName?: string;
  isRead?: boolean;
  isStarred?: boolean;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export interface SyncEmailsInput {
  folder?: string;
  full?: boolean;
  limitPerFolder?: number;
  includeAttachmentText?: boolean;
  checkpoints?: Record<string, MailboxSyncCheckpoint>;
}

export interface MailboxSyncCheckpoint {
  folder: string;
  uidValidity?: string;
  uidNext?: number;
  highestUid?: number;
  lastSyncAt?: string;
  lastFullSyncAt?: string;
  strategy?: "empty" | "recent" | "full" | "incremental" | "incremental_window";
  changed?: boolean;
  fetched?: number;
  total?: number;
}

export interface LocalIndexStatus {
  path: string;
  ownerEmail?: string;
  updatedAt?: string;
  ageMinutes?: number;
  staleThresholdMinutes: number;
  isStale: boolean;
  folderCount: number;
  labelCount: number;
  threadCount: number;
  storedMessageCount: number;
  dedupedMessageCount: number;
  syncCheckpoints: MailboxSyncCheckpoint[];
  folders: Array<{
    path: string;
    messages?: number;
    unseen?: number;
    specialUse?: string;
    lastIndexedAt?: string;
    lastIndexedCount?: number;
  }>;
}

export interface ProtonRuntimeConfig {
  readOnly: boolean;
  allowSend: boolean;
  allowRemoteDraftSync: boolean;
  allowedActions: EmailAction[];
  startupSync: boolean;
  autoSyncFolder?: string;
  autoSyncFull: boolean;
  autoSyncLimitPerFolder: number;
  idleWatchEnabled: boolean;
  idleMaxSeconds: number;
}

export interface BackgroundSyncStatus {
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  folder?: string;
  full: boolean;
  limitPerFolder: number;
  startupSync: boolean;
  idleEnabled: boolean;
  idleWatching: boolean;
  idleMaxSeconds: number;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastIdleAt?: string;
  lastIdleChangeAt?: string;
  lastIdleEventCount?: number;
  lastIdleError?: string;
  nextRunAt?: string;
}

export interface ContactStats {
  address: string;
  name?: string;
  incoming: number;
  outgoing: number;
  totalMessages: number;
  lastContactAt?: string;
}

export interface VolumeTrendPoint {
  date: string;
  count: number;
  unreadCount: number;
  starredCount: number;
  attachmentCount: number;
}

export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  context?: string;
  message: string;
  data?: unknown;
}

export interface AuditEntry {
  timestamp: string;
  tool: string;
  status: "success" | "error";
  durationMs?: number;
  input?: unknown;
  result?: unknown;
  error?: string;
}
