#!/usr/bin/env node

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AnalyticsService } from "./services/analytics-service.js";
import { AuditService } from "./services/audit-service.js";
import { BackgroundSyncService } from "./services/background-sync-service.js";
import { DraftStoreService } from "./services/draft-store-service.js";
import { LocalIndexService } from "./services/local-index-service.js";
import { SimpleIMAPService } from "./services/simple-imap-service.js";
import { SMTPService } from "./services/smtp-service.js";
import type {
  BatchActionEntry,
  BatchActionResult,
  CitationSource,
  DraftRecord,
  EmailAction,
  EmailAddress,
  EmailAttachmentInput,
  EmailDetail,
  EmailSummary,
  ProtonMailConfig,
} from "./types/index.js";
import {
  ensureValidEmails,
  isTextLikeMimeType,
  isValidEmail,
  lowerCaseAddress,
  normalizeBoolean,
  normalizeLimit,
  normalizeJsonValue,
  parseEmails,
  stringifyForJson,
} from "./utils/helpers.js";
import { logger } from "./utils/logger.js";
import {
  ensureEmailActionAllowed,
  ensureMailboxWriteAllowed,
  ensureRemoteDraftSyncAllowed,
  ensureSendAllowed,
  resolveRemoteDraftSync,
  sanitizeRuntimeConfig,
} from "./utils/runtime-policy.js";

type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "resource_link";
        uri: string;
        name: string;
        title?: string;
        description?: string;
        mimeType?: string;
      }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const RESOURCE_SCHEME = "protonmail";
const ALL_EMAIL_ACTIONS: EmailAction[] = [
  "mark_read",
  "mark_unread",
  "star",
  "unstar",
  "archive",
  "trash",
  "restore",
];

const TOOLS = [
  {
    name: "send_email",
    description: "Send an email through Proton SMTP with optional CC, BCC, reply-to, and attachments.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email addresses, comma-separated." },
        cc: { type: "string", description: "CC recipient email addresses, comma-separated." },
        bcc: { type: "string", description: "BCC recipient email addresses, comma-separated." },
        subject: { type: "string", description: "Email subject." },
        body: { type: "string", description: "Email body content." },
        isHtml: { type: "boolean", description: "Whether body should be sent as HTML.", default: false },
        priority: {
          type: "string",
          enum: ["high", "normal", "low"],
          description: "SMTP priority header.",
        },
        replyTo: { type: "string", description: "Optional reply-to email address." },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string", description: "Base64 content." },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "send_test_email",
    description: "Send a simple test email to validate SMTP connectivity.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        customMessage: { type: "string", description: "Optional custom test body." },
      },
      required: ["to"],
    },
  },
  {
    name: "reply_to_email",
    description: "Reply to an email by its emailId, optionally replying to all recipients.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Original email id." },
        body: { type: "string", description: "Reply body to prepend." },
        replyAll: { type: "boolean", description: "Reply to all original recipients.", default: false },
        isHtml: { type: "boolean", description: "Send body as HTML.", default: false },
        cc: { type: "string", description: "Additional CC recipients, comma-separated." },
        bcc: { type: "string", description: "Additional BCC recipients, comma-separated." },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string" },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
      },
      required: ["emailId", "body"],
    },
  },
  {
    name: "forward_email",
    description: "Forward an email by its emailId to one or more recipients.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Original email id." },
        to: { type: "string", description: "Forward recipient list, comma-separated." },
        body: { type: "string", description: "Optional message before the forwarded content." },
        isHtml: { type: "boolean", description: "Send body as HTML.", default: false },
        cc: { type: "string", description: "CC recipients, comma-separated." },
        bcc: { type: "string", description: "BCC recipients, comma-separated." },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string" },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
      },
      required: ["emailId", "to"],
    },
  },
  {
    name: "create_draft",
    description: "Create a local persistent draft that can later be reviewed, updated, or sent.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email addresses, comma-separated." },
        cc: { type: "string", description: "CC recipient email addresses, comma-separated." },
        bcc: { type: "string", description: "BCC recipient email addresses, comma-separated." },
        subject: { type: "string", description: "Draft subject." },
        body: { type: "string", description: "Draft body." },
        isHtml: { type: "boolean", description: "Whether the body should be HTML.", default: false },
        priority: { type: "string", enum: ["high", "normal", "low"] },
        replyTo: { type: "string", description: "Optional reply-to email address." },
        notes: { type: "string", description: "Optional local note for the draft." },
        syncToRemote: {
          type: "boolean",
          description: "Whether to sync the draft to the Proton Drafts mailbox when IMAP is available.",
          default: true,
        },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string", description: "Base64 content." },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
      },
      required: ["subject", "body"],
    },
  },
  {
    name: "create_reply_draft",
    description: "Create a reply draft for an existing email, optionally replying to all recipients.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Original email id." },
        body: { type: "string", description: "Reply body to prepend." },
        replyAll: { type: "boolean", description: "Reply to all original recipients.", default: false },
        isHtml: { type: "boolean", description: "Store body as HTML.", default: false },
        cc: { type: "string", description: "Additional CC recipients, comma-separated." },
        bcc: { type: "string", description: "Additional BCC recipients, comma-separated." },
        notes: { type: "string", description: "Optional local note for the draft." },
        syncToRemote: {
          type: "boolean",
          description: "Whether to sync the draft to the Proton Drafts mailbox when IMAP is available.",
          default: true,
        },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string", description: "Base64 content." },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
      },
      required: ["emailId", "body"],
    },
  },
  {
    name: "create_forward_draft",
    description: "Create a forward draft for an existing email.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Original email id." },
        to: { type: "string", description: "Forward recipient list, comma-separated." },
        body: { type: "string", description: "Optional message before the forwarded content." },
        isHtml: { type: "boolean", description: "Store body as HTML.", default: false },
        cc: { type: "string", description: "CC recipients, comma-separated." },
        bcc: { type: "string", description: "BCC recipients, comma-separated." },
        notes: { type: "string", description: "Optional local note for the draft." },
        syncToRemote: {
          type: "boolean",
          description: "Whether to sync the draft to the Proton Drafts mailbox when IMAP is available.",
          default: true,
        },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string", description: "Base64 content." },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
      },
      required: ["emailId", "to"],
    },
  },
  {
    name: "list_drafts",
    description: "List local persistent drafts.",
    inputSchema: {
      type: "object",
      properties: {
        includeSent: { type: "boolean", description: "Include drafts already sent.", default: false },
      },
    },
  },
  {
    name: "list_remote_drafts",
    description: "List drafts currently stored in the Proton Drafts mailbox.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum drafts to return.", default: 50 },
        offset: { type: "number", description: "Pagination offset.", default: 0 },
      },
    },
  },
  {
    name: "get_draft",
    description: "Get a single local persistent draft by id.",
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string" },
      },
      required: ["draftId"],
    },
  },
  {
    name: "update_draft",
    description: "Update a local persistent draft.",
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string" },
        to: { type: "string", description: "Recipient email addresses, comma-separated." },
        cc: { type: "string", description: "CC recipient email addresses, comma-separated." },
        bcc: { type: "string", description: "BCC recipient email addresses, comma-separated." },
        subject: { type: "string", description: "Draft subject." },
        body: { type: "string", description: "Draft body." },
        isHtml: { type: "boolean", description: "Whether the body should be HTML." },
        priority: { type: "string", enum: ["high", "normal", "low"] },
        replyTo: { type: "string", description: "Optional reply-to email address." },
        notes: { type: "string", description: "Optional local note for the draft." },
        syncToRemote: {
          type: "boolean",
          description: "Whether to sync the updated draft to the Proton Drafts mailbox when IMAP is available.",
          default: true,
        },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string", description: "Base64 content." },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
      },
      required: ["draftId"],
    },
  },
  {
    name: "sync_draft_to_remote",
    description: "Force a local draft to sync into the Proton Drafts mailbox and return the remote draft reference.",
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string" },
      },
      required: ["draftId"],
    },
  },
  {
    name: "send_draft",
    description: "Send a previously created draft through Proton SMTP.",
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string" },
      },
      required: ["draftId"],
    },
  },
  {
    name: "delete_draft",
    description: "Delete a local persistent draft.",
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string" },
      },
      required: ["draftId"],
    },
  },
  {
    name: "get_emails",
    description: "Fetch emails from a folder. Results are returned newest first.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder name.", default: "INBOX" },
        limit: { type: "number", description: "Number of emails to return.", default: 50 },
        offset: { type: "number", description: "Pagination offset from newest first.", default: 0 },
      },
    },
  },
  {
    name: "get_email_by_id",
    description: "Fetch a full email by the emailId returned from get_emails or search_emails.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id from previous tool output." },
      },
      required: ["emailId"],
    },
  },
  {
    name: "search_emails",
    description: "Search emails using IMAP filters and optional local attachment filtering.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query across headers and body." },
        folder: { type: "string", description: "Folder to search. Defaults to all folders." },
        label: { type: "string", description: "Folder or label filter applied locally after IMAP fetch." },
        threadId: { type: "string", description: "Thread id filter applied locally after IMAP fetch." },
        from: { type: "string", description: "Sender filter." },
        to: { type: "string", description: "Recipient filter." },
        subject: { type: "string", description: "Subject filter." },
        hasAttachment: { type: "boolean", description: "Whether the message should have attachments." },
        attachmentName: { type: "string", description: "Attachment filename filter applied locally." },
        isRead: { type: "boolean", description: "Read status filter." },
        isStarred: { type: "boolean", description: "Starred status filter." },
        dateFrom: { type: "string", description: "Inclusive start date/time in ISO format." },
        dateTo: { type: "string", description: "Inclusive end date/time in ISO format." },
        limit: { type: "number", description: "Maximum results.", default: 100 },
      },
    },
  },
  {
    name: "get_folders",
    description: "List folders with message counts and unseen counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sync_folders",
    description: "Refresh folder metadata from the IMAP server.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mark_email_read",
    description: "Mark an email as read or unread.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        isRead: { type: "boolean", default: true },
      },
      required: ["emailId"],
    },
  },
  {
    name: "star_email",
    description: "Star or unstar an email.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        isStarred: { type: "boolean", default: true },
      },
      required: ["emailId"],
    },
  },
  {
    name: "move_email",
    description: "Move an email to another folder.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        targetFolder: { type: "string" },
      },
      required: ["emailId", "targetFolder"],
    },
  },
  {
    name: "archive_email",
    description: "Move an email to the archive folder.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
      },
      required: ["emailId"],
    },
  },
  {
    name: "trash_email",
    description: "Move an email to the trash folder instead of permanently deleting it.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
      },
      required: ["emailId"],
    },
  },
  {
    name: "restore_email",
    description: "Restore an email to INBOX or to a target folder.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        targetFolder: { type: "string", description: "Optional restore destination. Defaults to INBOX." },
      },
      required: ["emailId"],
    },
  },
  {
    name: "delete_email",
    description: "Delete an email from its current folder.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
      },
      required: ["emailId"],
    },
  },
  {
    name: "batch_email_action",
    description: "Apply a reversible mailbox action to multiple email ids in one call.",
    inputSchema: {
      type: "object",
      properties: {
        emailIds: {
          type: "string",
          description: "Composite email ids, comma-separated.",
        },
        action: {
          type: "string",
          enum: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore"],
        },
        targetFolder: {
          type: "string",
          description: "Optional restore destination. Used only when action is restore.",
        },
        continueOnError: {
          type: "boolean",
          description: "Continue applying the action after an individual failure.",
          default: true,
        },
      },
      required: ["emailIds", "action"],
    },
  },
  {
    name: "apply_thread_action",
    description:
      "Apply a reversible mailbox action to every message in a normalized thread, optionally limited to unread messages.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread id from get_threads or get_actionable_threads." },
        action: {
          type: "string",
          enum: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore"],
        },
        targetFolder: {
          type: "string",
          description: "Optional restore destination. Used only when action is restore.",
        },
        unreadOnly: {
          type: "boolean",
          description: "Only apply the action to unread messages in the thread.",
          default: false,
        },
        continueOnError: {
          type: "boolean",
          description: "Continue applying the action after an individual failure.",
          default: true,
        },
        syncBefore: {
          type: "boolean",
          description: "Refresh the local mailbox index from IMAP before resolving the thread.",
          default: false,
        },
      },
      required: ["threadId", "action"],
    },
  },
  {
    name: "get_email_stats",
    description: "Summarize mailbox counts and a recent analytics sample.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_email_analytics",
    description: "Generate sampled mailbox analytics such as top senders and busiest hours.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_contacts",
    description: "List contacts ranked by interaction volume in the sampled analytics window.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum contacts to return.", default: 100 },
      },
    },
  },
  {
    name: "get_volume_trends",
    description: "Return daily message counts for a recent window.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Number of trailing days to include.", default: 30 },
      },
    },
  },
  {
    name: "get_connection_status",
    description: "Verify SMTP and IMAP availability.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_runtime_status",
    description: "Return runtime policy, background sync and IDLE state, draft stats, and local index freshness.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_doctor",
    description: "Run a production health check for SMTP, IMAP, IDLE, SQLite index integrity, and runtime policy.",
    inputSchema: {
      type: "object",
      properties: {
        includeSmtp: { type: "boolean", description: "Verify SMTP connectivity.", default: true },
        includeImap: { type: "boolean", description: "Verify IMAP connectivity.", default: true },
        includeIdleProbe: {
          type: "boolean",
          description: "Run a short IMAP IDLE wait to confirm the watch path is operational.",
          default: false,
        },
        idleTimeoutSeconds: {
          type: "number",
          description: "IDLE probe timeout in seconds when includeIdleProbe is true.",
          default: 5,
        },
      },
    },
  },
  {
    name: "run_background_sync",
    description: "Trigger the configured background mailbox sync immediately and return its updated status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wait_for_mailbox_changes",
    description: "Wait briefly on IMAP IDLE and report whether mailbox change events were observed.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Mailbox to watch during IDLE.", default: "INBOX" },
        timeoutSeconds: { type: "number", description: "Maximum watch duration in seconds.", default: 15 },
      },
    },
  },
  {
    name: "sync_emails",
    description: "Incrementally sync emails and persist the local v3 mailbox index on disk, using checkpoints when available.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder to sync. Defaults to all folders." },
        full: { type: "boolean", description: "Fetch a larger per-folder sample.", default: false },
        limitPerFolder: { type: "number", description: "Override the per-folder fetch limit." },
        includeAttachmentText: {
          type: "boolean",
          description: "Extract searchable text from text-like attachments while syncing.",
          default: true,
        },
      },
    },
  },
  {
    name: "get_index_status",
    description: "Return status for the persistent on-disk mailbox index.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_indexed_emails",
    description: "Search the persistent on-disk mailbox index without hitting IMAP.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query across indexed metadata." },
        folder: { type: "string", description: "Folder filter." },
        label: { type: "string", description: "Folder or label filter." },
        threadId: { type: "string", description: "Thread id filter." },
        from: { type: "string", description: "Sender filter." },
        to: { type: "string", description: "Recipient filter." },
        subject: { type: "string", description: "Subject filter." },
        hasAttachment: { type: "boolean", description: "Attachment filter." },
        attachmentName: { type: "string", description: "Attachment filename filter." },
        isRead: { type: "boolean", description: "Read status filter." },
        isStarred: { type: "boolean", description: "Starred status filter." },
        dateFrom: { type: "string", description: "Inclusive start date/time in ISO format." },
        dateTo: { type: "string", description: "Inclusive end date/time in ISO format." },
        limit: { type: "number", description: "Maximum results.", default: 100 },
      },
    },
  },
  {
    name: "get_labels",
    description: "Return normalized Proton folder and label views from the local mailbox index.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum labels to return.", default: 250 },
      },
    },
  },
  {
    name: "get_threads",
    description: "Return normalized mailbox threads from the local mailbox index.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text filter across subject, participants, and labels." },
        label: { type: "string", description: "Require a normalized label on the thread." },
        limit: { type: "number", description: "Maximum threads to return.", default: 100 },
      },
    },
  },
  {
    name: "get_actionable_threads",
    description:
      "Return the most actionable mailbox threads, ranked for reply triage with pending-on-you status.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text filter across subject, latest preview, senders, and labels." },
        label: { type: "string", description: "Require a normalized label on the thread." },
        pendingOn: {
          type: "string",
          enum: ["you", "them", "any"],
          description: "Filter by who the thread is currently waiting on.",
          default: "any",
        },
        unreadOnly: {
          type: "boolean",
          description: "Prefer threads with unread messages only.",
          default: true,
        },
        limit: { type: "number", description: "Maximum threads to return.", default: 50 },
        syncBefore: {
          type: "boolean",
          description: "Refresh the local mailbox index from IMAP before ranking threads.",
          default: false,
        },
      },
    },
  },
  {
    name: "get_inbox_digest",
    description: "Return a structured inbox digest with counts, top actionable threads, and stale waiting-on-you threads.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum threads per digest section.", default: 10 },
        minAgeHours: {
          type: "number",
          description: "How old a thread must be before it is considered stale waiting on you.",
          default: 24,
        },
        syncBefore: {
          type: "boolean",
          description: "Refresh the local mailbox index from IMAP before building the digest.",
          default: false,
        },
      },
    },
  },
  {
    name: "get_follow_up_candidates",
    description: "Return threads that look like follow-up candidates based on age and pending-on state.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum candidate threads to return.", default: 25 },
        minAgeHours: { type: "number", description: "Minimum thread age in hours.", default: 24 },
        pendingOn: {
          type: "string",
          enum: ["you", "them", "any"],
          description: "Which side the candidate thread should be waiting on.",
          default: "you",
        },
        syncBefore: {
          type: "boolean",
          description: "Refresh the local mailbox index from IMAP before selecting candidates.",
          default: false,
        },
      },
    },
  },
  {
    name: "get_thread_by_id",
    description: "Fetch a normalized mailbox thread from the local mailbox index.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread id from get_threads." },
      },
      required: ["threadId"],
    },
  },
  {
    name: "create_thread_reply_draft",
    description:
      "Create a reply draft from a normalized thread id, choosing the latest inbound message by default.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread id from get_threads or get_actionable_threads." },
        body: { type: "string", description: "Reply body to prepend." },
        replyAll: { type: "boolean", description: "Reply to all original recipients.", default: false },
        preferLatestInbound: {
          type: "boolean",
          description: "Prefer replying to the latest inbound message in the thread.",
          default: true,
        },
        isHtml: { type: "boolean", description: "Store body as HTML.", default: false },
        cc: { type: "string", description: "Additional CC recipients, comma-separated." },
        bcc: { type: "string", description: "Additional BCC recipients, comma-separated." },
        notes: { type: "string", description: "Optional local note for the draft." },
        syncBefore: {
          type: "boolean",
          description: "Refresh the local mailbox index from IMAP before resolving the thread.",
          default: false,
        },
        syncToRemote: {
          type: "boolean",
          description: "Whether to sync the draft to the Proton Drafts mailbox when IMAP is available.",
          default: true,
        },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string", description: "Base64 content." },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
      },
      required: ["threadId", "body"],
    },
  },
  {
    name: "list_attachments",
    description: "List attachments for a specific email, with stable attachment ids.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        includeInline: { type: "boolean", description: "Include inline attachments.", default: true },
        filenameContains: { type: "string", description: "Optional filename substring filter." },
        contentType: { type: "string", description: "Optional exact content type filter." },
      },
      required: ["emailId"],
    },
  },
  {
    name: "get_attachment_content",
    description: "Fetch attachment metadata and optionally inline base64 content.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        attachmentId: { type: "string" },
        includeBase64: { type: "boolean", description: "Include base64 payload in the response.", default: false },
      },
      required: ["emailId", "attachmentId"],
    },
  },
  {
    name: "save_attachments",
    description: "Save multiple attachments from an email to disk with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        outputPath: { type: "string", description: "Optional target directory or file path." },
        includeInline: { type: "boolean", description: "Include inline attachments.", default: false },
        filenameContains: { type: "string", description: "Optional filename substring filter." },
        contentType: { type: "string", description: "Optional exact content type filter." },
      },
      required: ["emailId"],
    },
  },
  {
    name: "save_attachment",
    description: "Save an email attachment to disk and return the written path.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        attachmentId: { type: "string" },
        outputPath: { type: "string", description: "Optional file or directory path to write to." },
      },
      required: ["emailId", "attachmentId"],
    },
  },
  {
    name: "clear_cache",
    description: "Clear in-memory folder, message, and analytics caches.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "clear_index",
    description: "Delete the persistent on-disk mailbox index.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_logs",
    description: "Return recent in-memory server logs.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["debug", "info", "warn", "error"] },
        limit: { type: "number", default: 100 },
      },
    },
  },
  {
    name: "get_audit_logs",
    description: "Return recent persistent audit log entries for production review.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 100 },
      },
    },
  },
] as const;

function citationToResourceLink(source: CitationSource): ToolResult["content"][number] {
  return {
    type: "resource_link",
    uri: source.uri,
    name: source.name,
    title: source.title,
    description: source.description,
    mimeType: source.mimeType,
  };
}

function normalizeStructuredContent(value: unknown): Record<string, unknown> | undefined {
  const normalized = normalizeJsonValue(value);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return undefined;
  }
  return normalized as Record<string, unknown>;
}

function withSources<T>(value: T, sources: CitationSource[]): T | (T & { sources: CitationSource[] }) {
  if (sources.length === 0 || !value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return {
    ...(value as Record<string, unknown>),
    sources,
  } as T & { sources: CitationSource[] };
}

function createTextResult(
  value: unknown,
  isError = false,
  sources: CitationSource[] = [],
): ToolResult {
  const payload = withSources(value, sources);
  return {
    content: [
      { type: "text", text: typeof payload === "string" ? payload : stringifyForJson(payload) },
      ...sources.map(citationToResourceLink),
    ],
    structuredContent: normalizeStructuredContent(payload),
    ...(isError ? { isError: true } : {}),
  };
}

function sanitizeAuditValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditValue(item));
  }

  if (typeof value === "string") {
    return value.length > 300 ? `[redacted:${value.length} chars]` : value;
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => {
        if (
          key === "body" ||
          key === "html" ||
          key === "text" ||
          key === "base64" ||
          key === "customMessage" ||
          /password|secret|token/i.test(key)
        ) {
          return [key, "[redacted]"];
        }

        if (key === "attachments" && Array.isArray(entryValue)) {
          return [
            key,
            entryValue.map((attachment) => {
              const object = asObject(attachment);
              return {
                filename: object.filename,
                contentType: object.contentType,
                cid: object.cid,
              };
            }),
          ];
        }

        return [key, sanitizeAuditValue(entryValue)];
      }),
    );
  }

  return value;
}

async function withAudit<T>(
  auditService: AuditService,
  tool: string,
  input: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    await auditService.record({
      timestamp: new Date().toISOString(),
      tool,
      status: "success",
      durationMs: Date.now() - startedAt,
      input: sanitizeAuditValue(input),
      result: sanitizeAuditValue(result),
    });
    return result;
  } catch (error) {
    await auditService.record({
      timestamp: new Date().toISOString(),
      tool,
      status: "error",
      durationMs: Date.now() - startedAt,
      input: sanitizeAuditValue(input),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new McpError(ErrorCode.InvalidParams, `${key} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseListValues(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function requireEmailAction(args: Record<string, unknown>, key = "action"): EmailAction {
  const value = requireString(args, key);
  switch (value) {
    case "mark_read":
    case "mark_unread":
    case "star":
    case "unstar":
    case "archive":
    case "trash":
    case "restore":
      return value;
    default:
      throw new McpError(ErrorCode.InvalidParams, `${key} must be a supported email action.`);
  }
}

function optionalAttachmentList(value: unknown): EmailAttachmentInput[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new McpError(ErrorCode.InvalidParams, "attachments must be an array.");
  }

  return value.map((item, index) => {
    const attachment = asObject(item);
    const filename = requireString(attachment, "filename");
    const content = requireString(attachment, "content");
    const contentType = optionalString(attachment, "contentType");
    const cid = optionalString(attachment, "cid");
    const contentDisposition = optionalString(attachment, "contentDisposition");

    if (!filename || !content) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `attachments[${index}] must contain filename and content.`,
      );
    }

    return {
      filename,
      content,
      contentType,
      cid,
      contentDisposition,
    };
  });
}

function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const address of addresses) {
    const normalized = lowerCaseAddress(address);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(address.trim());
  }

  return result;
}

function addressValues(addresses: EmailAddress[]): string[] {
  return uniqueAddresses(
    addresses
      .map((value) => value.address?.trim())
      .filter((value): value is string => Boolean(value)),
  );
}

function prefixedSubject(subject: string, prefix: "Re:" | "Fwd:"): string {
  const trimmed = subject.trim();
  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    return trimmed;
  }
  return `${prefix} ${trimmed}`;
}

function formatAddressList(addresses: EmailAddress[]): string {
  return addresses
    .map((value) => {
      if (value.name && value.address) {
        return `${value.name} <${value.address}>`;
      }
      return value.address || value.name || "";
    })
    .filter(Boolean)
    .join(", ");
}

function quotePlainText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function buildReplyText(detail: EmailDetail, body: string): string {
  const originalText = detail.text || detail.preview || "";
  const fromText = formatAddressList(detail.from);
  const dateText = detail.date || detail.internalDate || "an unknown date";

  return [
    body.trim(),
    "",
    `On ${dateText}, ${fromText || "the sender"} wrote:`,
    quotePlainText(originalText),
  ].join("\n");
}

function buildForwardText(detail: EmailDetail, body?: string): string {
  const originalText = detail.text || detail.preview || "";

  return [
    body?.trim() || "",
    body?.trim() ? "" : "",
    "---------- Forwarded message ---------",
    `From: ${formatAddressList(detail.from)}`,
    `Date: ${detail.date || detail.internalDate || ""}`,
    `Subject: ${detail.subject}`,
    `To: ${formatAddressList(detail.to)}`,
    detail.cc.length > 0 ? `Cc: ${formatAddressList(detail.cc)}` : "",
    "",
    originalText,
  ]
    .filter((line, index, array) => line !== "" || (index > 0 && array[index - 1] !== ""))
    .join("\n");
}

function getReplyRecipients(
  detail: EmailDetail,
  ownerEmail: string,
  replyAll: boolean,
): { to: string[]; cc: string[] } {
  const owner = lowerCaseAddress(ownerEmail);
  const primary = addressValues(detail.replyTo).length > 0 ? detail.replyTo : detail.from;
  const to = uniqueAddresses(addressValues(primary).filter((address) => lowerCaseAddress(address) !== owner));

  if (!replyAll) {
    return { to, cc: [] };
  }

  const ccPool = uniqueAddresses([
    ...addressValues(detail.to),
    ...addressValues(detail.cc),
  ]).filter((address) => {
    const normalized = lowerCaseAddress(address);
    return normalized !== owner && !to.some((recipient) => lowerCaseAddress(recipient) === normalized);
  });

  return { to, cc: ccPool };
}

function buildEmailResourceUri(emailId: string): string {
  return `${RESOURCE_SCHEME}://email/${encodeURIComponent(emailId)}`;
}

function buildThreadResourceUri(threadId: string): string {
  return `${RESOURCE_SCHEME}://thread/${encodeURIComponent(threadId)}`;
}

function buildDraftResourceUri(draftId: string): string {
  return `${RESOURCE_SCHEME}://draft/${encodeURIComponent(draftId)}`;
}

function buildAttachmentResourceUri(emailId: string, attachmentId: string): string {
  return `${RESOURCE_SCHEME}://attachment/${encodeURIComponent(emailId)}/${encodeURIComponent(attachmentId)}`;
}

function emailSource(
  email: Pick<EmailSummary, "id" | "subject" | "folder"> &
    Partial<Pick<EmailSummary, "date" | "internalDate" | "messageId" | "threadId" | "preview" | "from">>,
): CitationSource {
  const fromText = email.from && email.from.length > 0 ? formatAddressList(email.from) : undefined;
  return {
    uri: buildEmailResourceUri(email.id),
    name: email.id,
    title: email.subject,
    description: [email.folder, email.internalDate || email.date || "undated", fromText].filter(Boolean).join(" · "),
    mimeType: "message/rfc822",
    provider: "proton-bridge-imap",
    snippet: email.preview,
    locator: {
      kind: "email",
      emailId: email.id,
      folder: email.folder,
      messageId: email.messageId,
      threadId: email.threadId,
      from: fromText,
      subject: email.subject,
      date: email.internalDate || email.date,
    },
  };
}

function threadSource(thread: {
  id: string;
  subject: string;
  latestDate?: string;
  messageCount: number;
  normalizedLabels?: string[];
  participants?: EmailAddress[];
}): CitationSource {
  return {
    uri: buildThreadResourceUri(thread.id),
    name: thread.id,
    title: thread.subject,
    description: `${thread.messageCount} message(s) · ${thread.latestDate || "undated"}`,
    mimeType: "text/markdown",
    provider: "local-index",
    snippet: thread.participants && thread.participants.length > 0 ? formatAddressList(thread.participants) : undefined,
    locator: {
      kind: "thread",
      threadId: thread.id,
      normalizedLabels: thread.normalizedLabels,
      participants: thread.participants?.map((entry) => entry.address || entry.name).filter(Boolean),
    },
  };
}

function draftSource(draft: DraftRecord): CitationSource {
  return {
    uri: buildDraftResourceUri(draft.id),
    name: draft.id,
    title: draft.subject,
    description: `${draft.status} · updated ${draft.updatedAt}`,
    mimeType: "text/markdown",
    provider: "local-draft-store",
    locator: {
      kind: "draft",
      draftId: draft.id,
      remoteEmailId: draft.remoteDraft?.emailId,
    },
  };
}

function attachmentSource(
  emailId: string,
  attachment: NonNullable<EmailDetail["attachments"]>[number],
): CitationSource {
  const attachmentId = attachment.id || attachment.filename || "attachment";
  return {
    uri: buildAttachmentResourceUri(emailId, attachmentId),
    name: attachmentId,
    title: attachment.filename || attachmentId,
    description: `${attachment.contentType || "application/octet-stream"} · ${attachment.size || 0} bytes`,
    mimeType: attachment.contentType || "application/octet-stream",
    provider: "proton-bridge-imap",
    locator: {
      kind: "attachment",
      emailId,
      attachmentId,
      filename: attachment.filename,
    },
  };
}

function formatEmailResource(detail: EmailDetail): string {
  return [
    `# ${detail.subject}`,
    "",
    `- Email ID: ${detail.id}`,
    detail.messageId ? `- Message-ID: ${detail.messageId}` : "",
    detail.threadId ? `- Thread ID: ${detail.threadId}` : "",
    detail.references && detail.references.length > 0 ? `- References: ${detail.references.join(", ")}` : "",
    `- Folder: ${detail.folder}`,
    `- Date: ${detail.internalDate || detail.date || "unknown"}`,
    `- From: ${formatAddressList(detail.from) || "unknown"}`,
    `- To: ${formatAddressList(detail.to) || "unknown"}`,
    detail.cc.length > 0 ? `- Cc: ${formatAddressList(detail.cc)}` : "",
    "",
    detail.text || detail.preview || "(no body text available)",
    detail.attachmentText ? "" : "",
    detail.attachmentText ? "## Attachment Text" : "",
    detail.attachmentText || "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatThreadResource(thread: {
  id: string;
  subject: string;
  latestDate?: string;
  normalizedLabels: string[];
  messages: Array<Pick<EmailDetail, "id" | "subject" | "from" | "date" | "internalDate" | "preview">>;
}): string {
  return [
    `# ${thread.subject}`,
    "",
    `- Thread ID: ${thread.id}`,
    `- Latest: ${thread.latestDate || "unknown"}`,
    `- Labels: ${thread.normalizedLabels.join(", ") || "(none)"}`,
    "",
    ...thread.messages.flatMap((message) => [
      `## ${message.subject}`,
      `- Email ID: ${message.id}`,
      `- From: ${formatAddressList(message.from) || "unknown"}`,
      `- Date: ${message.internalDate || message.date || "unknown"}`,
      "",
      message.preview || "(no preview)",
      "",
    ]),
  ].join("\n");
}

function formatDraftResource(draft: DraftRecord): string {
  return [
    `# ${draft.subject}`,
    "",
    `- Draft ID: ${draft.id}`,
    `- Status: ${draft.status}`,
    `- Mode: ${draft.mode}`,
    `- Updated: ${draft.updatedAt}`,
    `- Remote Sync: ${draft.remoteSyncState}`,
    draft.remoteDraft?.emailId ? `- Remote Email ID: ${draft.remoteDraft.emailId}` : "",
    `- To: ${draft.to.join(", ") || "(none)"}`,
    draft.cc.length > 0 ? `- Cc: ${draft.cc.join(", ")}` : "",
    draft.bcc.length > 0 ? `- Bcc: ${draft.bcc.join(", ")}` : "",
    "",
    draft.body,
  ]
    .filter(Boolean)
    .join("\n");
}

type ParsedResourceUri =
  | { kind: "email"; emailId: string }
  | { kind: "thread"; threadId: string }
  | { kind: "draft"; draftId: string }
  | { kind: "attachment"; emailId: string; attachmentId: string };

function parseResourceUri(uri: string): ParsedResourceUri {
  const parsed = new URL(uri);
  if (parsed.protocol !== `${RESOURCE_SCHEME}:`) {
    throw new Error(`Unsupported resource URI: ${uri}`);
  }

  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  switch (parsed.hostname) {
    case "email":
      if (segments.length !== 1) {
        break;
      }
      return { kind: "email", emailId: segments[0] };
    case "thread":
      if (segments.length !== 1) {
        break;
      }
      return { kind: "thread", threadId: segments[0] };
    case "draft":
      if (segments.length !== 1) {
        break;
      }
      return { kind: "draft", draftId: segments[0] };
    case "attachment":
      if (segments.length !== 2) {
        break;
      }
      return { kind: "attachment", emailId: segments[0], attachmentId: segments[1] };
    default:
      break;
  }

  throw new Error(`Unsupported resource URI: ${uri}`);
}

async function syncDraftToRemote(
  draftStore: DraftStoreService,
  smtpService: SMTPService,
  imapService: SimpleIMAPService,
  draft: DraftRecord,
): Promise<{
  draft: DraftRecord;
  remoteSync: { ok: boolean; emailId?: string; message?: string };
}> {
  try {
    const raw = await smtpService.buildRawMessage({
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      body: draft.body,
      isHtml: draft.isHtml,
      priority: draft.priority,
      replyTo: draft.replyTo,
      inReplyTo: draft.inReplyTo,
      references: draft.references,
      messageId: draft.draftMessageId,
      attachments: draft.attachments,
    });

    const remoteDraft = await imapService.upsertRemoteDraft({
      raw,
      messageId: draft.draftMessageId,
      existingEmailId: draft.remoteDraft?.emailId,
    });

    return {
      draft: await draftStore.markRemoteSynced(draft.id, remoteDraft),
      remoteSync: {
        ok: true,
        emailId: remoteDraft.emailId,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Draft remote sync failed", "MCPServer", { draftId: draft.id, error });
    return {
      draft: await draftStore.markRemoteSyncError(draft.id, message),
      remoteSync: {
        ok: false,
        message,
      },
    };
  }
}

async function clearRemoteDraft(
  draftStore: DraftStoreService,
  imapService: SimpleIMAPService,
  draft: DraftRecord,
): Promise<{
  draft: DraftRecord;
  remoteDelete?: { ok: boolean; message?: string };
}> {
  if (!draft.remoteDraft?.emailId) {
    return {
      draft,
    };
  }

  try {
    await imapService.deleteRemoteDraft(draft.remoteDraft.emailId);
    return {
      draft: await draftStore.clearRemoteSync(draft.id),
      remoteDelete: {
        ok: true,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Remote draft cleanup failed", "MCPServer", { draftId: draft.id, error });
    return {
      draft,
      remoteDelete: {
        ok: false,
        message,
      },
    };
  }
}

async function ensureFreshLocalIndex(
  imapService: SimpleIMAPService,
  localIndexService: LocalIndexService,
  input: {
    folder?: string;
    full?: boolean;
    limitPerFolder?: number;
  } = {},
) {
  const checkpoints = await localIndexService.getSyncCheckpointMap();
  const snapshot = await imapService.collectEmailsForIndex({
    folder: input.folder,
    full: input.full ?? false,
    limitPerFolder: input.limitPerFolder,
    includeAttachmentText: true,
    checkpoints,
  });

  const indexStatus = await localIndexService.recordSnapshot({
    folders: snapshot.folders,
    emails: snapshot.emails,
    syncedAt: snapshot.syncedAt,
    folderStats: snapshot.folderStats,
  });

  return {
    snapshot,
    indexStatus,
  };
}

async function maybeRefreshLocalIndex(
  imapService: SimpleIMAPService,
  localIndexService: LocalIndexService,
  input: {
    force?: boolean;
    folder?: string;
    full?: boolean;
    limitPerFolder?: number;
  } = {},
) {
  const status = await localIndexService.getStatus();
  if (!input.force && status.storedMessageCount > 0 && !status.isStale) {
    return undefined;
  }

  return ensureFreshLocalIndex(imapService, localIndexService, {
    folder: input.folder,
    full: input.full,
    limitPerFolder: input.limitPerFolder,
  });
}

async function runEmailAction(
  imapService: SimpleIMAPService,
  emailId: string,
  action: EmailAction,
  targetFolder?: string,
): Promise<unknown> {
  switch (action) {
    case "mark_read":
      return imapService.markEmailRead(emailId, true);
    case "mark_unread":
      return imapService.markEmailRead(emailId, false);
    case "star":
      return imapService.starEmail(emailId, true);
    case "unstar":
      return imapService.starEmail(emailId, false);
    case "archive":
      return imapService.archiveEmail(emailId);
    case "trash":
      return imapService.trashEmail(emailId);
    case "restore":
      return imapService.restoreEmail(emailId, targetFolder);
  }
}

function emailSourceFromActionResult(result: unknown): CitationSource[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return [];
  }

  const candidateKeys = ["targetEmailId", "emailId"] as const;
  const emailIds = new Set<string>();

  for (const key of candidateKeys) {
    const value = (result as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) {
      emailIds.add(value.trim());
    }
  }

  return [...emailIds].map((emailId) => ({
    uri: buildEmailResourceUri(emailId),
    name: emailId,
    title: `Email ${emailId}`,
    mimeType: "message/rfc822",
  }));
}

async function applyBatchEmailAction(
  imapService: SimpleIMAPService,
  entries: BatchActionEntry[],
  input: {
    emailIds: string[];
    action: EmailAction;
    targetFolder?: string;
    continueOnError: boolean;
  },
): Promise<BatchActionResult> {
  for (const emailId of input.emailIds) {
    try {
      const result = await runEmailAction(imapService, emailId, input.action, input.targetFolder);
      entries.push({
        emailId,
        ok: true,
        action: input.action,
        result,
      });
    } catch (error) {
      entries.push({
        emailId,
        ok: false,
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
      });

      if (!input.continueOnError) {
        break;
      }
    }
  }

  const succeeded = entries.filter((entry) => entry.ok).length;
  return {
    action: input.action,
    total: input.emailIds.length,
    succeeded,
    failed: entries.length - succeeded,
    results: entries,
  };
}

function pickReplyTargetFromThread(
  thread: Awaited<ReturnType<LocalIndexService["getThreadById"]>>,
  ownerEmail: string,
  preferLatestInbound: boolean,
) {
  const messages = [...thread.messages];
  if (preferLatestInbound) {
    const inbound = [...messages]
      .reverse()
      .find(
        (message) =>
          !message.from.some((address) => lowerCaseAddress(address.address) === lowerCaseAddress(ownerEmail)),
      );
    if (inbound) {
      return inbound;
    }
  }

  return messages[messages.length - 1];
}

function readEnvValue(name: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) {
    return direct;
  }

  const command = process.env[`${name}_COMMAND`]?.trim();
  if (command) {
    return execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: "/bin/sh",
    }).trim();
  }

  const filePath = process.env[`${name}_FILE`]?.trim();
  if (!filePath) {
    return undefined;
  }

  return readFileSync(filePath, "utf8").trim();
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  return defaultValue;
}

function parseIntegerEnv(
  name: string,
  defaultValue: number,
  min = 1,
  max = 10_000,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }

  return Math.min(max, Math.max(min, parsed));
}

function parseAllowedActionsEnv(name: string): EmailAction[] {
  const configured = parseListValues(process.env[name]);
  if (configured.length === 0) {
    return [...ALL_EMAIL_ACTIONS];
  }

  const allowed = configured.filter((value): value is EmailAction =>
    ALL_EMAIL_ACTIONS.includes(value as EmailAction),
  );

  return allowed.length > 0 ? allowed : [...ALL_EMAIL_ACTIONS];
}

export function buildConfigFromEnv(): ProtonMailConfig {
  const username = readEnvValue("PROTONMAIL_USERNAME");
  const password = readEnvValue("PROTONMAIL_PASSWORD");

  if (!username || !password) {
    throw new Error(
      "Missing required environment variables or secret sources: PROTONMAIL_USERNAME and PROTONMAIL_PASSWORD.",
    );
  }

  const smtpPort = parseIntegerEnv("PROTONMAIL_SMTP_PORT", 587, 1, 65_535);
  const imapPort = parseIntegerEnv("PROTONMAIL_IMAP_PORT", 1143, 1, 65_535);
  const debug = parseBooleanEnv("DEBUG", false);
  const readOnly = parseBooleanEnv("PROTONMAIL_READ_ONLY", false);
  const allowSend = parseBooleanEnv("PROTONMAIL_ALLOW_SEND", !readOnly);
  const allowRemoteDraftSync = parseBooleanEnv(
    "PROTONMAIL_ALLOW_REMOTE_DRAFT_SYNC",
    !readOnly,
  );
  const autoSync = parseBooleanEnv("PROTONMAIL_AUTO_SYNC", true);
  const syncInterval = parseIntegerEnv("PROTONMAIL_SYNC_INTERVAL_MINUTES", 5, 1, 24 * 60);
  const idleWatchEnabled = parseBooleanEnv("PROTONMAIL_IDLE_WATCH", autoSync);
  const idleMaxSeconds = parseIntegerEnv("PROTONMAIL_IDLE_MAX_SECONDS", 30, 5, 300);

  logger.setDebugMode(debug);

  return {
    smtp: {
      host: process.env.PROTONMAIL_SMTP_HOST || "smtp.protonmail.ch",
      port: smtpPort,
      secure: smtpPort === 465,
      username,
      password,
    },
    imap: {
      host: process.env.PROTONMAIL_IMAP_HOST || "localhost",
      port: imapPort,
      secure: parseBooleanEnv("PROTONMAIL_IMAP_SECURE", false),
      username,
      password,
    },
    dataDir: process.env.PROTONMAIL_DATA_DIR || join(homedir(), ".proton-mail-bridge-mcp"),
    debug,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync,
    syncInterval,
    runtime: {
      readOnly,
      allowSend,
      allowRemoteDraftSync,
      allowedActions: parseAllowedActionsEnv("PROTONMAIL_ALLOWED_ACTIONS"),
      startupSync: parseBooleanEnv("PROTONMAIL_STARTUP_SYNC", autoSync),
      autoSyncFolder: process.env.PROTONMAIL_AUTO_SYNC_FOLDER?.trim() || "INBOX",
      autoSyncFull: parseBooleanEnv("PROTONMAIL_AUTO_SYNC_FULL", false),
      autoSyncLimitPerFolder: parseIntegerEnv("PROTONMAIL_AUTO_SYNC_LIMIT_PER_FOLDER", 100, 1, 500),
      idleWatchEnabled,
      idleMaxSeconds,
    },
  };
}

export function createServer(
  config: ProtonMailConfig,
  options: {
    startBackgroundSync?: boolean;
  } = {},
) {
  const smtpService = new SMTPService(config);
  const imapService = new SimpleIMAPService(config, logger);
  const analyticsService = new AnalyticsService();
  const auditService = new AuditService(config);
  const localIndexService = new LocalIndexService(config, logger);
  const draftStore = new DraftStoreService(config, logger);
  const backgroundSyncService = new BackgroundSyncService(
    config,
    imapService,
    localIndexService,
    logger,
  );

  if (options.startBackgroundSync) {
    backgroundSyncService.start();
  }

  const server = new Server(
    {
      name: "proton-mail-bridge-mcp",
      version: "1.3.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOLS] }));

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const cursor = request.params?.cursor ? Number.parseInt(request.params.cursor, 10) : 0;
    const [drafts, threadsResult, messages] = await Promise.all([
      draftStore.listDrafts(false),
      localIndexService.getThreads({ limit: 25 }),
      localIndexService.listRecentMessages(25),
    ]);

    const resources = [
      ...drafts.map((draft) => ({
        uri: buildDraftResourceUri(draft.id),
        name: draft.id,
        title: draft.subject,
        description: `${draft.status} · updated ${draft.updatedAt}`,
        mimeType: "text/markdown",
      })),
      ...threadsResult.threads.map((thread) => ({
        uri: buildThreadResourceUri(thread.id),
        name: thread.id,
        title: thread.subject,
        description: `${thread.messageCount} message(s)`,
        mimeType: "text/markdown",
      })),
      ...messages.map((message) => ({
        uri: buildEmailResourceUri(message.primaryEmailId),
        name: message.primaryEmailId,
        title: message.subject,
        description: `${message.folder} · ${message.internalDate || message.date || "undated"}`,
        mimeType: "message/rfc822",
      })),
    ];

    const pageSize = 50;
    const nextCursor =
      cursor + pageSize < resources.length ? String(cursor + pageSize) : undefined;

    return {
      resources: resources.slice(cursor, cursor + pageSize),
      nextCursor,
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const target = parseResourceUri(request.params.uri);

    switch (target.kind) {
      case "email": {
        const detail = await imapService.getEmailById(target.emailId);
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "text/markdown",
              text: formatEmailResource(detail),
            },
          ],
        };
      }
      case "thread": {
        const thread = await localIndexService.getThreadById(target.threadId);
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "text/markdown",
              text: formatThreadResource({
                id: thread.id,
                subject: thread.subject,
                latestDate: thread.latestDate,
                normalizedLabels: thread.normalizedLabels,
                messages: thread.messages.map((message) => ({
                  id: message.primaryEmailId,
                  subject: message.subject,
                  from: message.from,
                  date: message.date,
                  internalDate: message.internalDate,
                  preview: message.preview,
                })),
              }),
            },
          ],
        };
      }
      case "draft": {
        const draft = await draftStore.getDraft(target.draftId);
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "text/markdown",
              text: formatDraftResource(draft),
            },
          ],
        };
      }
      case "attachment": {
        const attachment = await imapService.getAttachmentContent(
          target.emailId,
          target.attachmentId,
          true,
        );
        const mimeType = attachment.attachment.contentType || "application/octet-stream";
        if (attachment.text && isTextLikeMimeType(mimeType)) {
          return {
            contents: [
              {
                uri: request.params.uri,
                mimeType,
                text: attachment.text,
              },
            ],
          };
        }

        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType,
              blob: attachment.base64 || "",
            },
          ],
        };
      }
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = asObject(request.params.arguments);
    logger.debug("Handling tool call", "MCPServer", { name, args });

    try {
      switch (name) {
        case "send_email": {
          ensureSendAllowed(config.runtime);
          const to = parseEmails(requireString(args, "to"));
          const cc = parseEmails(optionalString(args, "cc"));
          const bcc = parseEmails(optionalString(args, "bcc"));
          const subject = requireString(args, "subject");
          const body = requireString(args, "body");
          const isHtml = normalizeBoolean(args.isHtml, false);
          const priority = optionalString(args, "priority");
          const replyTo = optionalString(args, "replyTo");
          const attachments = optionalAttachmentList(args.attachments);

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(bcc, "bcc");
          if (replyTo && !isValidEmail(replyTo)) {
            throw new McpError(ErrorCode.InvalidParams, "replyTo must be a valid email address.");
          }

          const result = await withAudit(auditService, name, args, async () =>
            smtpService.sendEmail({
              to,
              cc,
              bcc,
              subject,
              body,
              isHtml,
              priority:
                priority === "high" || priority === "low" || priority === "normal"
                  ? priority
                  : "normal",
              replyTo,
              attachments,
            }),
          );

          return createTextResult({
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            response: result.response,
          });
        }

        case "send_test_email": {
          ensureSendAllowed(config.runtime);
          const to = requireString(args, "to");
          if (!isValidEmail(to)) {
            throw new McpError(ErrorCode.InvalidParams, "to must be a valid email address.");
          }

          const result = await withAudit(auditService, name, args, async () =>
            smtpService.sendTestEmail(to, optionalString(args, "customMessage")),
          );
          return createTextResult({
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            response: result.response,
          });
        }

        case "reply_to_email": {
          ensureSendAllowed(config.runtime);
          const detail = await imapService.getEmailById(requireString(args, "emailId"));
          const body = requireString(args, "body");
          const isHtml = normalizeBoolean(args.isHtml, false);
          const replyAll = normalizeBoolean(args.replyAll, false);
          const attachments = optionalAttachmentList(args.attachments);
          const extraCc = parseEmails(optionalString(args, "cc"));
          const extraBcc = parseEmails(optionalString(args, "bcc"));
          const recipients = getReplyRecipients(detail, config.smtp.username, replyAll);
          const cc = uniqueAddresses([...recipients.cc, ...extraCc]);
          const to = uniqueAddresses(recipients.to);

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(extraBcc, "bcc");

          if (to.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "Unable to infer reply recipient.");
          }

          const result = await withAudit(auditService, name, args, async () =>
            smtpService.sendEmail({
              to,
              cc,
              bcc: extraBcc,
              subject: prefixedSubject(detail.subject, "Re:"),
              body: buildReplyText(detail, body),
              isHtml,
              inReplyTo: detail.messageId,
              references: detail.messageId ? [detail.messageId] : undefined,
              attachments,
            }),
          );

          return createTextResult({
            repliedTo: detail.id,
            to,
            cc,
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            response: result.response,
          }, false, [emailSource(detail)]);
        }

        case "forward_email": {
          ensureSendAllowed(config.runtime);
          const detail = await imapService.getEmailById(requireString(args, "emailId"));
          const to = parseEmails(requireString(args, "to"));
          const cc = parseEmails(optionalString(args, "cc"));
          const bcc = parseEmails(optionalString(args, "bcc"));
          const body = optionalString(args, "body");
          const isHtml = normalizeBoolean(args.isHtml, false);
          const attachments = optionalAttachmentList(args.attachments);

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(bcc, "bcc");

          const result = await withAudit(auditService, name, args, async () =>
            smtpService.sendEmail({
              to,
              cc,
              bcc,
              subject: prefixedSubject(detail.subject, "Fwd:"),
              body: buildForwardText(detail, body),
              isHtml,
              attachments,
            }),
          );

          return createTextResult({
            forwardedMessage: detail.id,
            to,
            cc,
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            response: result.response,
          }, false, [emailSource(detail)]);
        }

        case "create_draft": {
          const to = parseEmails(optionalString(args, "to"));
          const cc = parseEmails(optionalString(args, "cc"));
          const bcc = parseEmails(optionalString(args, "bcc"));
          const subject = requireString(args, "subject");
          const body = requireString(args, "body");
          const replyTo = optionalString(args, "replyTo");
          const attachments = optionalAttachmentList(args.attachments);
          const priority = optionalString(args, "priority");

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(bcc, "bcc");
          if (replyTo && !isValidEmail(replyTo)) {
            throw new McpError(ErrorCode.InvalidParams, "replyTo must be a valid email address.");
          }

          const result = await withAudit(auditService, name, args, async () => {
            const draft = await draftStore.createDraft({
              mode: "compose",
              to,
              cc,
              bcc,
              subject,
              body,
              isHtml: normalizeBoolean(args.isHtml, false),
              priority:
                priority === "high" || priority === "low" || priority === "normal"
                  ? priority
                  : undefined,
              replyTo,
              notes: optionalString(args, "notes"),
              attachments,
            });

            const remoteSyncDecision = resolveRemoteDraftSync(
              config.runtime,
              normalizeBoolean(args.syncToRemote, true),
            );
            const synced = remoteSyncDecision.enabled
              ? await syncDraftToRemote(draftStore, smtpService, imapService, draft)
              : { draft, remoteSync: undefined };
            const remoteSync =
              synced.remoteSync ??
              (remoteSyncDecision.reason
                ? {
                    ok: false,
                    skipped: true,
                    message: remoteSyncDecision.reason,
                  }
                : undefined);

            return remoteSync ? { ...synced.draft, remoteSync } : synced.draft;
          });

          return createTextResult(
            result,
            false,
            [
              draftSource(result),
              ...(result.remoteDraft?.emailId
                ? [
                    emailSource({
                      id: result.remoteDraft.emailId,
                      subject: result.subject,
                      folder: result.remoteDraft.folder,
                    })
                  ]
                : []),
            ],
          );
        }

        case "create_reply_draft": {
          const detail = await imapService.getEmailById(requireString(args, "emailId"));
          const body = requireString(args, "body");
          const isHtml = normalizeBoolean(args.isHtml, false);
          const replyAll = normalizeBoolean(args.replyAll, false);
          const attachments = optionalAttachmentList(args.attachments);
          const extraCc = parseEmails(optionalString(args, "cc"));
          const extraBcc = parseEmails(optionalString(args, "bcc"));
          const recipients = getReplyRecipients(detail, config.smtp.username, replyAll);
          const cc = uniqueAddresses([...recipients.cc, ...extraCc]);
          const to = uniqueAddresses(recipients.to);

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(extraBcc, "bcc");

          if (to.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "Unable to infer reply recipient.");
          }

          const result = await withAudit(auditService, name, args, async () => {
            const draft = await draftStore.createDraft({
              mode: "reply",
              to,
              cc,
              bcc: extraBcc,
              subject: prefixedSubject(detail.subject, "Re:"),
              body: buildReplyText(detail, body),
              isHtml,
              inReplyTo: detail.messageId,
              references: detail.messageId ? [detail.messageId] : undefined,
              attachments,
              sourceEmailId: detail.id,
              sourceMessageId: detail.messageId,
              notes: optionalString(args, "notes"),
            });

            const remoteSyncDecision = resolveRemoteDraftSync(
              config.runtime,
              normalizeBoolean(args.syncToRemote, true),
            );
            const synced = remoteSyncDecision.enabled
              ? await syncDraftToRemote(draftStore, smtpService, imapService, draft)
              : { draft, remoteSync: undefined };
            const remoteSync =
              synced.remoteSync ??
              (remoteSyncDecision.reason
                ? {
                    ok: false,
                    skipped: true,
                    message: remoteSyncDecision.reason,
                  }
                : undefined);

            return remoteSync ? { ...synced.draft, remoteSync } : synced.draft;
          });

          return createTextResult(
            result,
            false,
            [
              draftSource(result),
              emailSource(detail),
              ...(result.remoteDraft?.emailId
                ? [
                    emailSource({
                      id: result.remoteDraft.emailId,
                      subject: result.subject,
                      folder: result.remoteDraft.folder,
                    })
                  ]
                : []),
            ],
          );
        }

        case "create_forward_draft": {
          const detail = await imapService.getEmailById(requireString(args, "emailId"));
          const to = parseEmails(requireString(args, "to"));
          const cc = parseEmails(optionalString(args, "cc"));
          const bcc = parseEmails(optionalString(args, "bcc"));
          const attachments = optionalAttachmentList(args.attachments);

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(bcc, "bcc");

          const result = await withAudit(auditService, name, args, async () => {
            const draft = await draftStore.createDraft({
              mode: "forward",
              to,
              cc,
              bcc,
              subject: prefixedSubject(detail.subject, "Fwd:"),
              body: buildForwardText(detail, optionalString(args, "body")),
              isHtml: normalizeBoolean(args.isHtml, false),
              attachments,
              sourceEmailId: detail.id,
              sourceMessageId: detail.messageId,
              notes: optionalString(args, "notes"),
            });

            const remoteSyncDecision = resolveRemoteDraftSync(
              config.runtime,
              normalizeBoolean(args.syncToRemote, true),
            );
            const synced = remoteSyncDecision.enabled
              ? await syncDraftToRemote(draftStore, smtpService, imapService, draft)
              : { draft, remoteSync: undefined };
            const remoteSync =
              synced.remoteSync ??
              (remoteSyncDecision.reason
                ? {
                    ok: false,
                    skipped: true,
                    message: remoteSyncDecision.reason,
                  }
                : undefined);

            return remoteSync ? { ...synced.draft, remoteSync } : synced.draft;
          });

          return createTextResult(
            result,
            false,
            [
              draftSource(result),
              emailSource(detail),
              ...(result.remoteDraft?.emailId
                ? [
                    emailSource({
                      id: result.remoteDraft.emailId,
                      subject: result.subject,
                      folder: result.remoteDraft.folder,
                    })
                  ]
                : []),
            ],
          );
        }

        case "list_drafts": {
          const drafts = await draftStore.listDrafts(normalizeBoolean(args.includeSent, false));
          return createTextResult(
            {
              total: drafts.length,
              drafts,
            },
            false,
            drafts.map(draftSource),
          );
        }

        case "list_remote_drafts": {
          const result = await imapService.listRemoteDrafts(
            normalizeLimit(args.limit, 50),
            normalizeLimit(args.offset, 0, 0, 10_000),
          );
          return createTextResult(result, false, result.emails.map(emailSource));
        }

        case "get_draft": {
          const draft = await draftStore.getDraft(requireString(args, "draftId"));
          return createTextResult(
            draft,
            false,
            [
              draftSource(draft),
              ...(draft.remoteDraft?.emailId
                ? [
                    emailSource({
                      id: draft.remoteDraft.emailId,
                      subject: draft.subject,
                      folder: draft.remoteDraft.folder,
                    })
                  ]
                : []),
            ],
          );
        }

        case "update_draft": {
          const draftId = requireString(args, "draftId");
          const to = args.to === undefined ? undefined : parseEmails(optionalString(args, "to"));
          const cc = args.cc === undefined ? undefined : parseEmails(optionalString(args, "cc"));
          const bcc = args.bcc === undefined ? undefined : parseEmails(optionalString(args, "bcc"));
          const replyTo = optionalString(args, "replyTo");
          const priority = optionalString(args, "priority");
          const attachments = args.attachments === undefined ? undefined : optionalAttachmentList(args.attachments);

          if (to) {
            ensureValidEmails(to, "to");
          }
          if (cc) {
            ensureValidEmails(cc, "cc");
          }
          if (bcc) {
            ensureValidEmails(bcc, "bcc");
          }
          if (replyTo && !isValidEmail(replyTo)) {
            throw new McpError(ErrorCode.InvalidParams, "replyTo must be a valid email address.");
          }

          const result = await withAudit(auditService, name, args, async () => {
            const draft = await draftStore.updateDraft(draftId, {
              to,
              cc,
              bcc,
              subject: optionalString(args, "subject"),
              body: optionalString(args, "body"),
              isHtml: typeof args.isHtml === "boolean" ? args.isHtml : undefined,
              priority:
                priority === "high" || priority === "low" || priority === "normal"
                  ? priority
                  : undefined,
              replyTo,
              attachments,
              notes: optionalString(args, "notes"),
            });

            const remoteSyncDecision = resolveRemoteDraftSync(
              config.runtime,
              normalizeBoolean(args.syncToRemote, true),
            );
            const synced = remoteSyncDecision.enabled
              ? await syncDraftToRemote(draftStore, smtpService, imapService, draft)
              : { draft, remoteSync: undefined };
            const remoteSync =
              synced.remoteSync ??
              (remoteSyncDecision.reason
                ? {
                    ok: false,
                    skipped: true,
                    message: remoteSyncDecision.reason,
                  }
                : undefined);

            return remoteSync ? { ...synced.draft, remoteSync } : synced.draft;
          });

          return createTextResult(
            result,
            false,
            [
              draftSource(result),
              ...(result.remoteDraft?.emailId
                ? [
                    emailSource({
                      id: result.remoteDraft.emailId,
                      subject: result.subject,
                      folder: result.remoteDraft.folder,
                    })
                  ]
                : []),
            ],
          );
        }

        case "sync_draft_to_remote": {
          ensureRemoteDraftSyncAllowed(config.runtime);
          const draft = await draftStore.getDraft(requireString(args, "draftId"));
          const synced = await withAudit(auditService, name, args, async () =>
            syncDraftToRemote(draftStore, smtpService, imapService, draft),
          );
          return createTextResult(
            { ...synced.draft, remoteSync: synced.remoteSync },
            false,
            [
              draftSource(synced.draft),
              ...(synced.draft.remoteDraft?.emailId
                ? [
                    emailSource({
                      id: synced.draft.remoteDraft.emailId,
                      subject: synced.draft.subject,
                      folder: synced.draft.remoteDraft.folder,
                    })
                  ]
                : []),
            ],
          );
        }

        case "send_draft": {
          ensureSendAllowed(config.runtime);
          const draft = await draftStore.getDraft(requireString(args, "draftId"));
          ensureValidEmails(draft.to, "to");
          ensureValidEmails(draft.cc, "cc");
          ensureValidEmails(draft.bcc, "bcc");
          if (draft.replyTo && !isValidEmail(draft.replyTo)) {
            throw new McpError(ErrorCode.InvalidParams, "replyTo must be a valid email address.");
          }

          const result = await withAudit(auditService, name, args, async () =>
            smtpService.sendEmail({
              to: draft.to,
              cc: draft.cc,
              bcc: draft.bcc,
              subject: draft.subject,
              body: draft.body,
              isHtml: draft.isHtml,
              priority: draft.priority,
              replyTo: draft.replyTo,
              inReplyTo: draft.inReplyTo,
              references: draft.references,
              attachments: draft.attachments,
            }),
          );

          let sentDraft = await draftStore.markSent(draft.id, {
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            response: result.response,
          });
          const remoteCleanup = resolveRemoteDraftSync(config.runtime, true).enabled
            ? await clearRemoteDraft(draftStore, imapService, sentDraft)
            : {
                draft: sentDraft,
                remoteDelete: sentDraft.remoteDraft?.emailId
                  ? {
                      ok: false,
                      skipped: true,
                      message: "Remote draft cleanup skipped by runtime policy.",
                    }
                  : undefined,
              };
          sentDraft = remoteCleanup.draft;

          const sources = [draftSource(sentDraft)];
          if (sentDraft.sourceEmailId) {
            sources.push(emailSource(await imapService.getEmailById(sentDraft.sourceEmailId)));
          }

          return createTextResult(
            {
              draftId: sentDraft.id,
              status: sentDraft.status,
              messageId: result.messageId,
              accepted: result.accepted,
              rejected: result.rejected,
              response: result.response,
              remoteDelete: remoteCleanup.remoteDelete,
            },
            false,
            sources,
          );
        }

        case "delete_draft": {
          const draft = await draftStore.getDraft(requireString(args, "draftId"));
          const deleted = await withAudit(auditService, name, args, async () => {
            const remoteCleanup = resolveRemoteDraftSync(config.runtime, true).enabled
              ? await clearRemoteDraft(draftStore, imapService, draft)
              : {
                  draft,
                  remoteDelete: draft.remoteDraft?.emailId
                    ? {
                        ok: false,
                        skipped: true,
                        message: "Remote draft cleanup skipped by runtime policy.",
                      }
                    : undefined,
                };
            return {
              ...(await draftStore.deleteDraft(draft.id)),
              remoteDelete: remoteCleanup.remoteDelete,
            };
          });
          return createTextResult(deleted);
        }

        case "get_emails": {
          const result = await imapService.getEmails({
            folder: optionalString(args, "folder"),
            limit: typeof args.limit === "number" ? args.limit : undefined,
            offset: typeof args.offset === "number" ? args.offset : undefined,
          });
          return createTextResult(result, false, result.emails.map(emailSource));
        }

        case "get_email_by_id": {
          const detail = await imapService.getEmailById(requireString(args, "emailId"));
          return createTextResult(
            detail,
            false,
            [emailSource(detail), ...detail.attachments.map((attachment) => attachmentSource(detail.id, attachment))],
          );
        }

        case "search_emails": {
          const result = await imapService.searchEmails({
            query: optionalString(args, "query"),
            folder: optionalString(args, "folder"),
            label: optionalString(args, "label"),
            threadId: optionalString(args, "threadId"),
            from: optionalString(args, "from"),
            to: optionalString(args, "to"),
            subject: optionalString(args, "subject"),
            hasAttachment:
              typeof args.hasAttachment === "boolean" ? args.hasAttachment : undefined,
            attachmentName: optionalString(args, "attachmentName"),
            isRead: typeof args.isRead === "boolean" ? args.isRead : undefined,
            isStarred: typeof args.isStarred === "boolean" ? args.isStarred : undefined,
            dateFrom: optionalString(args, "dateFrom"),
            dateTo: optionalString(args, "dateTo"),
            limit: typeof args.limit === "number" ? args.limit : undefined,
          });
          return createTextResult(result, false, result.emails.map(emailSource));
        }

        case "get_folders":
          return createTextResult(await imapService.getFolders());

        case "sync_folders":
          return createTextResult(await imapService.syncFolders());

        case "mark_email_read":
          ensureEmailActionAllowed(
            config.runtime,
            normalizeBoolean(args.isRead, true) ? "mark_read" : "mark_unread",
          );
          return createTextResult(
            await withAudit(auditService, name, args, async () =>
              imapService.markEmailRead(
                requireString(args, "emailId"),
                normalizeBoolean(args.isRead, true),
              ),
            ),
          );

        case "star_email":
          ensureEmailActionAllowed(
            config.runtime,
            normalizeBoolean(args.isStarred, true) ? "star" : "unstar",
          );
          return createTextResult(
            await withAudit(auditService, name, args, async () =>
              imapService.starEmail(
                requireString(args, "emailId"),
                normalizeBoolean(args.isStarred, true),
              ),
            ),
          );

        case "move_email":
        {
          ensureMailboxWriteAllowed(config.runtime);
          const result = await withAudit(auditService, name, args, async () =>
            imapService.moveEmail(
              requireString(args, "emailId"),
              requireString(args, "targetFolder"),
            ),
          );
          const sources = result.targetEmailId
            ? [
                {
                  uri: buildEmailResourceUri(result.targetEmailId),
                  name: result.targetEmailId,
                  title: `Moved email ${result.targetEmailId}`,
                  description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
                  mimeType: "message/rfc822",
                },
              ]
            : [];
          return createTextResult(result, false, sources);
        }

        case "archive_email":
        {
          ensureEmailActionAllowed(config.runtime, "archive");
          const result = await withAudit(auditService, name, args, async () =>
            imapService.archiveEmail(requireString(args, "emailId")),
          );
          const sources = result.targetEmailId
            ? [
                {
                  uri: buildEmailResourceUri(result.targetEmailId),
                  name: result.targetEmailId,
                  title: `Archived email ${result.targetEmailId}`,
                  description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
                  mimeType: "message/rfc822",
                },
              ]
            : [];
          return createTextResult(result, false, sources);
        }

        case "trash_email":
        {
          ensureEmailActionAllowed(config.runtime, "trash");
          const result = await withAudit(auditService, name, args, async () =>
            imapService.trashEmail(requireString(args, "emailId")),
          );
          const sources = result.targetEmailId
            ? [
                {
                  uri: buildEmailResourceUri(result.targetEmailId),
                  name: result.targetEmailId,
                  title: `Trashed email ${result.targetEmailId}`,
                  description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
                  mimeType: "message/rfc822",
                },
              ]
            : [];
          return createTextResult(result, false, sources);
        }

        case "restore_email":
        {
          ensureEmailActionAllowed(config.runtime, "restore");
          const result = await withAudit(auditService, name, args, async () =>
            imapService.restoreEmail(
              requireString(args, "emailId"),
              optionalString(args, "targetFolder"),
            ),
          );
          const sources = result.targetEmailId
            ? [
                {
                  uri: buildEmailResourceUri(result.targetEmailId),
                  name: result.targetEmailId,
                  title: `Restored email ${result.targetEmailId}`,
                  description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
                  mimeType: "message/rfc822",
                },
              ]
            : [];
          return createTextResult(result, false, sources);
        }

        case "delete_email":
          ensureMailboxWriteAllowed(config.runtime);
          return createTextResult(
            await withAudit(auditService, name, args, async () =>
              imapService.deleteEmail(requireString(args, "emailId")),
            ),
          );

        case "batch_email_action":
        {
          const emailIds = [...new Set(parseListValues(requireString(args, "emailIds")))];
          if (emailIds.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
          }
          const action = requireEmailAction(args);
          ensureEmailActionAllowed(config.runtime, action);
          const result = await withAudit(auditService, name, args, async () =>
            applyBatchEmailAction(imapService, [], {
              emailIds,
              action,
              targetFolder: optionalString(args, "targetFolder"),
              continueOnError: normalizeBoolean(args.continueOnError, true),
            }),
          );

          const sources = result.results.flatMap((entry) =>
            entry.ok ? emailSourceFromActionResult(entry.result) : [],
          );
          return createTextResult(result, false, sources);
        }

        case "get_email_stats": {
          const folders = await imapService.getFolders();
          const sample = await imapService.getAnalyticsSample(30, 100);
          return createTextResult(
            analyticsService.getEmailStats(sample, folders, config.smtp.username),
          );
        }

        case "get_email_analytics": {
          const sample = await imapService.getAnalyticsSample(30, 100);
          return createTextResult(
            analyticsService.getEmailAnalytics(sample, config.smtp.username),
          );
        }

        case "get_contacts": {
          const limit = normalizeLimit(args.limit, 100);
          const sample = await imapService.getAnalyticsSample(30, limit);
          return createTextResult(
            analyticsService.getContacts(sample, limit, config.smtp.username),
          );
        }

        case "get_volume_trends": {
          const days = normalizeLimit(args.days, 30, 1, 365);
          const sample = await imapService.getAnalyticsSample(days, 150);
          return createTextResult(analyticsService.getVolumeTrends(sample, days));
        }

        case "get_connection_status": {
          const [smtpStatus, imapStatus] = await Promise.allSettled([
            smtpService.verifyConnection(),
            imapService.ping(),
          ]);

          return createTextResult({
            checkedAt: new Date().toISOString(),
            smtp: {
              ok: smtpStatus.status === "fulfilled",
              message:
                smtpStatus.status === "fulfilled"
                  ? "SMTP connection verified."
                  : smtpStatus.reason instanceof Error
                    ? smtpStatus.reason.message
                    : String(smtpStatus.reason),
            },
            imap: {
              ok: imapStatus.status === "fulfilled",
              connected: imapService.isConnected(),
              idle: imapService.getIdleStatus(),
              message:
                imapStatus.status === "fulfilled"
                  ? "IMAP connection verified."
                  : imapStatus.reason instanceof Error
                    ? imapStatus.reason.message
                    : String(imapStatus.reason),
            },
          });
        }

        case "run_doctor": {
          const includeSmtp = normalizeBoolean(args.includeSmtp, true);
          const includeImap = normalizeBoolean(args.includeImap, true);
          const includeIdleProbe = normalizeBoolean(args.includeIdleProbe, false);
          const idleTimeoutSeconds = normalizeLimit(args.idleTimeoutSeconds, 5, 1, 60);
          const [smtpStatus, imapStatus, indexStatus, integrity] = await Promise.all([
            includeSmtp
              ? Promise.allSettled([smtpService.verifyConnection()]).then(([result]) => result)
              : Promise.resolve({ status: "fulfilled", value: undefined } as const),
            includeImap
              ? Promise.allSettled([imapService.ping()]).then(([result]) => result)
              : Promise.resolve({ status: "fulfilled", value: undefined } as const),
            localIndexService.getStatus(),
            localIndexService.runIntegrityCheck(),
          ]);

          const idleProbe = includeIdleProbe
            ? await Promise.allSettled([
                imapService.waitForMailboxChanges({
                  folder: config.runtime.autoSyncFolder,
                  timeoutMs: idleTimeoutSeconds * 1000,
                }),
              ]).then(([result]) => result)
            : undefined;

          return createTextResult({
            checkedAt: new Date().toISOString(),
            runtime: sanitizeRuntimeConfig(config.runtime),
            smtp: {
              ok: smtpStatus.status === "fulfilled",
              enabled: includeSmtp,
              message:
                smtpStatus.status === "fulfilled"
                  ? "SMTP connection verified."
                  : smtpStatus.reason instanceof Error
                    ? smtpStatus.reason.message
                    : String(smtpStatus.reason),
            },
            imap: {
              ok: imapStatus.status === "fulfilled",
              enabled: includeImap,
              idle: imapService.getIdleStatus(),
              message:
                imapStatus.status === "fulfilled"
                  ? "IMAP connection verified."
                  : imapStatus.reason instanceof Error
                    ? imapStatus.reason.message
                    : String(imapStatus.reason),
            },
            idleProbe:
              idleProbe === undefined
                ? { skipped: true }
                : idleProbe.status === "fulfilled"
                  ? idleProbe.value
                  : {
                      ok: false,
                      error: idleProbe.reason instanceof Error ? idleProbe.reason.message : String(idleProbe.reason),
                    },
            backgroundSync: backgroundSyncService.getStatus(),
            index: indexStatus,
            integrity,
            audit: {
              path: auditService.getPath(),
            },
          });
        }

        case "get_runtime_status": {
          const [indexStatus, drafts] = await Promise.all([
            localIndexService.getStatus(),
            draftStore.listDrafts(true),
          ]);
          return createTextResult({
            checkedAt: new Date().toISOString(),
            runtime: sanitizeRuntimeConfig(config.runtime),
            backgroundSync: backgroundSyncService.getStatus(),
            imapIdle: imapService.getIdleStatus(),
            index: indexStatus,
            audit: {
              path: auditService.getPath(),
            },
            drafts: {
              total: drafts.length,
              active: drafts.filter((draft) => draft.status === "draft").length,
              remoteSynced: drafts.filter((draft) => draft.remoteSyncState === "synced").length,
              syncFailed: drafts.filter((draft) => draft.remoteSyncState === "sync_failed").length,
            },
          });
        }

        case "run_background_sync":
          return createTextResult({
            checkedAt: new Date().toISOString(),
            backgroundSync: await backgroundSyncService.runNow(),
            index: await localIndexService.getStatus(),
          });

        case "wait_for_mailbox_changes":
          return createTextResult(
            await imapService.waitForMailboxChanges({
              folder: optionalString(args, "folder"),
              timeoutMs: normalizeLimit(args.timeoutSeconds, 15, 1, 300) * 1000,
            }),
          );

        case "sync_emails":
        {
          const checkpoints = await localIndexService.getSyncCheckpointMap();
          const snapshot = await imapService.collectEmailsForIndex({
              folder: optionalString(args, "folder"),
              full: normalizeBoolean(args.full, false),
              limitPerFolder: typeof args.limitPerFolder === "number" ? args.limitPerFolder : undefined,
              includeAttachmentText: normalizeBoolean(args.includeAttachmentText, true),
              checkpoints,
            });

          const indexStatus = await localIndexService.recordSnapshot({
            folders: snapshot.folders,
            emails: snapshot.emails,
            syncedAt: snapshot.syncedAt,
            folderStats: snapshot.folderStats,
          });

          return createTextResult({
            syncedAt: snapshot.syncedAt,
            full: snapshot.full,
            folders: snapshot.folderStats,
            cachedMessages: snapshot.emails.length,
            index: {
              updatedAt: indexStatus.updatedAt,
              storedMessageCount: indexStatus.storedMessageCount,
              dedupedMessageCount: indexStatus.dedupedMessageCount,
              path: indexStatus.path,
            },
          });
        }

        case "get_index_status":
          return createTextResult(await localIndexService.getStatus());

        case "search_indexed_emails":
        {
          const result = await localIndexService.search({
            query: optionalString(args, "query"),
            folder: optionalString(args, "folder"),
            label: optionalString(args, "label"),
            threadId: optionalString(args, "threadId"),
            from: optionalString(args, "from"),
            to: optionalString(args, "to"),
            subject: optionalString(args, "subject"),
            hasAttachment:
              typeof args.hasAttachment === "boolean" ? args.hasAttachment : undefined,
            attachmentName: optionalString(args, "attachmentName"),
            isRead: typeof args.isRead === "boolean" ? args.isRead : undefined,
            isStarred: typeof args.isStarred === "boolean" ? args.isStarred : undefined,
            dateFrom: optionalString(args, "dateFrom"),
            dateTo: optionalString(args, "dateTo"),
            limit: typeof args.limit === "number" ? args.limit : undefined,
          });
          return createTextResult(result, false, result.emails.map(emailSource));
        }

        case "get_labels":
        {
          const labels = await localIndexService.getLabels(normalizeLimit(args.limit, 250));
          return createTextResult({
            total: labels.length,
            labels,
          });
        }

        case "get_threads":
        {
          await maybeRefreshLocalIndex(imapService, localIndexService, {
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await localIndexService.getThreads({
            query: optionalString(args, "query"),
            label: optionalString(args, "label"),
            limit: typeof args.limit === "number" ? args.limit : undefined,
          });
          return createTextResult(result, false, result.threads.map(threadSource));
        }

        case "get_actionable_threads":
        {
          const refresh = await maybeRefreshLocalIndex(imapService, localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await localIndexService.getActionableThreads({
            query: optionalString(args, "query"),
            label: optionalString(args, "label"),
            pendingOn:
              args.pendingOn === "you" || args.pendingOn === "them" || args.pendingOn === "any"
                ? args.pendingOn
                : undefined,
            unreadOnly: normalizeBoolean(args.unreadOnly, true),
            limit: typeof args.limit === "number" ? args.limit : undefined,
          });
          return createTextResult(
            refresh ? { ...result, indexUpdatedAt: refresh.indexStatus.updatedAt } : result,
            false,
            result.threads.map(threadSource),
          );
        }

        case "get_inbox_digest":
        {
          await maybeRefreshLocalIndex(imapService, localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await localIndexService.getInboxDigest({
            limit: typeof args.limit === "number" ? args.limit : undefined,
            minAgeHours: typeof args.minAgeHours === "number" ? args.minAgeHours : undefined,
          });
          const topThreads = Array.isArray(result.topThreads) ? result.topThreads : [];
          const staleThreads = Array.isArray(result.staleAwaitingYou) ? result.staleAwaitingYou : [];
          return createTextResult(
            result,
            false,
            [...topThreads, ...staleThreads]
              .filter((thread): thread is { id: string; subject: string; latestDate?: string; messageCount: number; normalizedLabels?: string[]; participants?: EmailAddress[] } =>
                Boolean(thread && typeof thread === "object" && "id" in thread),
              )
              .map(threadSource),
          );
        }

        case "get_follow_up_candidates":
        {
          await maybeRefreshLocalIndex(imapService, localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await localIndexService.getFollowUpCandidates({
            limit: typeof args.limit === "number" ? args.limit : undefined,
            minAgeHours: typeof args.minAgeHours === "number" ? args.minAgeHours : undefined,
            pendingOn:
              args.pendingOn === "you" || args.pendingOn === "them" || args.pendingOn === "any"
                ? args.pendingOn
                : undefined,
          });
          return createTextResult(
            result,
            false,
            Array.isArray(result.threads)
              ? result.threads
                  .filter((thread): thread is { id: string; subject: string; latestDate?: string; messageCount: number; normalizedLabels?: string[]; participants?: EmailAddress[] } =>
                    Boolean(thread && typeof thread === "object" && "id" in thread),
                  )
                  .map(threadSource)
              : [],
          );
        }

        case "get_thread_by_id":
        {
          await maybeRefreshLocalIndex(imapService, localIndexService, {
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await localIndexService.getThreadById(requireString(args, "threadId"));
          return createTextResult(
            result,
            false,
            [threadSource(result), ...result.messages.map((message) => emailSource({
              id: message.primaryEmailId,
              subject: message.subject,
              folder: message.folder,
              date: message.date,
              internalDate: message.internalDate,
            }))],
          );
        }

        case "create_thread_reply_draft":
        {
          await maybeRefreshLocalIndex(imapService, localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });

          const thread = await localIndexService.getThreadById(requireString(args, "threadId"));
          const targetMessage = pickReplyTargetFromThread(
            thread,
            config.smtp.username,
            normalizeBoolean(args.preferLatestInbound, true),
          );

          if (!targetMessage?.primaryEmailId) {
            throw new McpError(ErrorCode.InvalidParams, "Unable to resolve a reply target from the thread.");
          }

          const detail = await imapService.getEmailById(targetMessage.primaryEmailId);
          const body = requireString(args, "body");
          const isHtml = normalizeBoolean(args.isHtml, false);
          const replyAll = normalizeBoolean(args.replyAll, false);
          const attachments = optionalAttachmentList(args.attachments);
          const extraCc = parseEmails(optionalString(args, "cc"));
          const extraBcc = parseEmails(optionalString(args, "bcc"));
          const recipients = getReplyRecipients(detail, config.smtp.username, replyAll);
          const cc = uniqueAddresses([...recipients.cc, ...extraCc]);
          const to = uniqueAddresses(recipients.to);

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(extraBcc, "bcc");

          if (to.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "Unable to infer reply recipient.");
          }

          const result = await withAudit(auditService, name, args, async () => {
            const draft = await draftStore.createDraft({
              mode: "reply",
              to,
              cc,
              bcc: extraBcc,
              subject: prefixedSubject(detail.subject, "Re:"),
              body: buildReplyText(detail, body),
              isHtml,
              inReplyTo: detail.messageId,
              references: detail.messageId ? [detail.messageId] : undefined,
              attachments,
              sourceEmailId: detail.id,
              sourceMessageId: detail.messageId,
              notes: optionalString(args, "notes"),
            });

            const remoteSyncDecision = resolveRemoteDraftSync(
              config.runtime,
              normalizeBoolean(args.syncToRemote, true),
            );
            const synced = remoteSyncDecision.enabled
              ? await syncDraftToRemote(draftStore, smtpService, imapService, draft)
              : { draft, remoteSync: undefined };
            const remoteSync =
              synced.remoteSync ??
              (remoteSyncDecision.reason
                ? {
                    ok: false,
                    skipped: true,
                    message: remoteSyncDecision.reason,
                  }
                : undefined);

            return remoteSync
              ? { ...synced.draft, remoteSync, threadId: thread.id }
              : { ...synced.draft, threadId: thread.id };
          });

          return createTextResult(
            result,
            false,
            [
              draftSource(result),
              threadSource(thread),
              emailSource(detail),
              ...(result.remoteDraft?.emailId
                ? [
                    emailSource({
                      id: result.remoteDraft.emailId,
                      subject: result.subject,
                      folder: result.remoteDraft.folder,
                    })
                  ]
                : []),
            ],
          );
        }

        case "apply_thread_action":
        {
          await maybeRefreshLocalIndex(imapService, localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });

          const thread = await localIndexService.getThreadById(requireString(args, "threadId"));
          const action = requireEmailAction(args);
          ensureEmailActionAllowed(config.runtime, action);
          const unreadOnly = normalizeBoolean(args.unreadOnly, false);
          const emailIds = [...new Set(
            thread.messages
              .filter((message) => !unreadOnly || !message.isRead)
              .map((message) => message.primaryEmailId),
          )];

          const result = await withAudit(auditService, name, args, async () =>
            applyBatchEmailAction(imapService, [], {
              emailIds,
              action,
              targetFolder: optionalString(args, "targetFolder"),
              continueOnError: normalizeBoolean(args.continueOnError, true),
            }),
          );

          const sources = [
            threadSource(thread),
            ...result.results.flatMap((entry) => (entry.ok ? emailSourceFromActionResult(entry.result) : [])),
          ];

          return createTextResult(
            {
              threadId: thread.id,
              unreadOnly,
              ...result,
            },
            false,
            sources,
          );
        }

        case "list_attachments":
        {
          const attachmentList = await imapService.listAttachments(requireString(args, "emailId"));
          const includeInline = normalizeBoolean(args.includeInline, true);
          const filenameContains = optionalString(args, "filenameContains");
          const contentType = optionalString(args, "contentType");
          const filtered = attachmentList.attachments.filter((attachment) => {
            if (!includeInline && attachment.isInline) {
              return false;
            }
            if (
              filenameContains &&
              !(attachment.filename || "").toLowerCase().includes(filenameContains.toLowerCase())
            ) {
              return false;
            }
            if (
              contentType &&
              (attachment.contentType || "").toLowerCase() !== contentType.toLowerCase()
            ) {
              return false;
            }
            return true;
          });
          const result = {
            emailId: attachmentList.emailId,
            attachments: filtered,
          };
          return createTextResult(
            result,
            false,
            result.attachments.map((attachment) => attachmentSource(result.emailId, attachment)),
          );
        }

        case "get_attachment_content":
        {
          const result = await imapService.getAttachmentContent(
            requireString(args, "emailId"),
            requireString(args, "attachmentId"),
            normalizeBoolean(args.includeBase64, false),
          );
          return createTextResult(result, false, [attachmentSource(result.emailId, result.attachment)]);
        }

        case "save_attachment":
        {
          const result = await imapService.saveAttachment(
            requireString(args, "emailId"),
            requireString(args, "attachmentId"),
            optionalString(args, "outputPath"),
          );
          return createTextResult(result, false, [attachmentSource(result.emailId, result.attachment)]);
        }

        case "save_attachments":
        {
          const result = await imapService.saveAttachments({
            emailId: requireString(args, "emailId"),
            outputPath: optionalString(args, "outputPath"),
            includeInline: normalizeBoolean(args.includeInline, false),
            filenameContains: optionalString(args, "filenameContains"),
            contentType: optionalString(args, "contentType"),
          });
          return createTextResult(
            result,
            false,
            result.saved.map((entry) => attachmentSource(result.emailId, entry.attachment)),
          );
        }

        case "clear_cache":
          analyticsService.clearCache();
          return createTextResult({
            clearedAt: new Date().toISOString(),
            ...imapService.clearCache(),
          });

        case "clear_index":
          return createTextResult({
            clearedAt: new Date().toISOString(),
            ...(await localIndexService.clear()),
          });

        case "get_logs":
          return createTextResult(
            logger.getLogs({
              level:
                args.level === "debug" ||
                args.level === "info" ||
                args.level === "warn" ||
                args.level === "error"
                  ? args.level
                  : undefined,
              limit: normalizeLimit(args.limit, 100),
            }),
          );

        case "get_audit_logs":
          return createTextResult(
            await auditService.list(normalizeLimit(args.limit, 100)),
          );

        default:
          throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
      }
    } catch (error) {
      logger.error("Tool call failed", "MCPServer", { name, error });
      if (error instanceof McpError) {
        return createTextResult(error.message, true);
      }
      return createTextResult(error instanceof Error ? error.message : String(error), true);
    }
  });

  return {
    server,
    smtpService,
    imapService,
    localIndexService,
    draftStore,
    backgroundSyncService,
    auditService,
  };
}

export async function main(): Promise<void> {
  const config = buildConfigFromEnv();
  const { server, smtpService, imapService, backgroundSyncService } = createServer(config, {
    startBackgroundSync: true,
  });

  logger.info("Starting ProtonMail MCP server", "MCPServer");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("ProtonMail MCP server ready", "MCPServer");

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down`, "MCPServer");
    backgroundSyncService.stop();
    await Promise.allSettled([imapService.disconnect(), smtpService.close()]);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", "MCPServer", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", "MCPServer", reason);
  process.exit(1);
});

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    logger.error("Fatal server error", "MCPServer", error);
    process.exit(1);
  });
}
