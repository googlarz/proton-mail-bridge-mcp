#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildConfigFromEnv, createServer } from "./index.js";
import type { EmailAddress, EmailDetail, EmailSummary, ProtonMailConfig, SearchEmailsInput } from "./types/index.js";
import { ensureMailboxWriteAllowed, ensureSendAllowed, sanitizeRuntimeConfig } from "./utils/runtime-policy.js";
import { isValidEmail, lowerCaseAddress, parseEmails, ensureValidEmails } from "./utils/helpers.js";
import { getClaudeDesktopInstallStatus } from "./scripts/check-claude-desktop.js";
import { installClaudeDesktopConfig } from "./scripts/install-claude-desktop.js";
import { runClaudeDesktopSetupWizard } from "./scripts/setup-claude-desktop.js";

type CliFlags = Record<string, string | boolean>;

export interface ParsedCliArgs {
  command: string;
  subcommand?: string;
  positionals: string[];
  flags: CliFlags;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const flags: CliFlags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  const command = positionals[0] || "help";
  const subcommand = command === "claude" ? positionals[1] : undefined;
  const consumed = command === "claude" ? 2 : 1;

  return {
    command,
    subcommand,
    positionals: positionals.slice(consumed),
    flags,
  };
}

function cliEntryPath(): string {
  return fileURLToPath(new URL("./index.js", import.meta.url));
}

function printHelp(): void {
  process.stdout.write(
    [
      "  ____  ____   ___ _____ ___  _   _   __  __    _    ___ _     ",
      " |  _ \\|  _ \\ / _ \\_   _/ _ \\| \\ | | |  \\/  |  / \\  |_ _| |    ",
      " | |_) | |_) | | | || || | | |  \\| | | |\\/| | / _ \\  | || |    ",
      " |  __/|  _ <| |_| || || |_| | |\\  | | |  | |/ ___ \\ | || |___",
      " |_|   |_| \\_\\\\___/ |_| \\___/|_| \\_| |_|  |_/_/   \\_\\___|_____|",
      "  Bridge MCP  ·  Claude-native email automation",
      "",
      "Usage:",
      "  proton-mail-bridge <command> [options]",
      "",
      "Commands:",
      "  status                 Show local config, index, runtime, and Claude Desktop status",
      "  doctor                 Verify IMAP, SMTP, and Claude Desktop wiring",
      "  connection-status      Show live IMAP/SMTP connectivity state",
      "  runtime-status         Show runtime policy and background sync state",
      "  sync                   Refresh the local index from Proton Bridge",
      "  index-status           Show local index health and freshness",
      "  folders                List available folders from Proton Bridge",
      "  create-folder <path>   Create a mailbox folder (e.g. Folders/Receipts)",
      "  rename-folder <p> <p2> Rename a folder (or use --to <newPath>)",
      "  delete-folder <path>   Delete an empty folder",
      "  labels                 List normalized labels from the local index",
      "  threads [query]        List normalized threads from the local index",
      "  digest                 Show inbox digest and top actionable threads",
      "  followups              Show follow-up candidates from the local index",
      "  emails                 List emails from a folder (--folder --limit --offset)",
      "  attachments <emailId>  List attachments for one message",
      "  search [query]         Search indexed mail (default) or live mail with --live",
      "  read <emailId>         Read one email by composite email id",
      "  move <emailId> <fldr>  Move an email to another folder",
      "  archive <emailId>      Archive an email",
      "  trash <emailId>        Move an email to Trash",
      "  restore <emailId>      Restore an email from Trash to Inbox",
      "  mark-read <emailId>    Mark read (--unread to flip)",
      "  star <emailId>         Star an email (--unstar to flip)",
      "  delete <emailId>       Permanently delete an email",
      "  batch <action> <ids…>  Apply action to multiple emails (or --ids)",
      "  send                   Send an email (--to --subject --body or stdin)",
      "  reply <emailId>        Reply to an email (--body or stdin, --reply-all)",
      "  forward <emailId>      Forward an email (--to, optional --body or stdin)",
      "  test-email <addr>      Send a test email to verify SMTP",
      "  thread <id>            Fetch a full thread by id",
      "  thread-brief <id>      Summarise a thread (latest in/out, next action)",
      "  thread-action <id> <a> Apply action to all messages in a thread",
      "  actionable             List actionable threads",
      "  document-threads       Find threads with important attachments",
      "  meeting-context <who>  Prep context for a meeting (--domain also accepted)",
      "  stats                  Mailbox counts and analytics sample",
      "  analytics              Detailed mailbox analytics (top senders, busy hours)",
      "  contacts               Contacts ranked by interaction volume",
      "  volume-trends          Daily message counts (--days, default 30)",
      "  watch                  Wait for mailbox changes via IMAP IDLE (--timeout)",
      "  drafts                 List local drafts",
      "  remote-drafts          List drafts in the Proton Drafts mailbox",
      "  draft-create           Create a draft (--to --subject --body or stdin)",
      "  draft-read <id>        Read a saved draft",
      "  draft-update <id>      Update a draft (--subject --body --to etc.)",
      "  draft-reply <emailId>  Create a reply draft (--body or stdin, --reply-all)",
      "  draft-forward <id>     Create a forward draft (--to, --body or stdin)",
      "  draft-sync <id>        Sync a local draft to the Proton Drafts mailbox",
      "  draft-send <id>        Send a saved draft",
      "  draft-delete <id>      Delete a saved draft",
      "  draft-thread-reply <id> Create a reply draft for a thread",
      "  tools                  List every MCP tool exposed by the server",
      "  tool <name>            Call any MCP tool with JSON arguments",
      "  claude setup           Run the interactive Claude Desktop setup wizard",
      "  claude install         Install or update the Claude Desktop runtime",
      "  claude check           Check Claude Desktop integration status",
      "  claude update          Alias for claude install",
      "",
      "Global flags:",
      "  --json                 Print machine-readable JSON",
      "",
      "Search flags:",
      "  --folder <name>        Limit to one folder",
      "  --limit <n>            Limit results",
      "  --live                 Use live IMAP search instead of the local index",
      "  --sync                 Refresh the local index before indexed search",
      "  --label <name>         Filter by normalized label",
      "  --from <value>         Filter by sender",
      "  --to <value>           Filter by recipient",
      "  --subject <value>      Filter by subject",
      "  --domain <value>       Filter by sender domain",
      "  --read / --unread      Filter by read state",
      "  --starred / --unstarred Filter by star state",
      "",
      "Examples:",
      "  proton-mail-bridge doctor",
      "  proton-mail-bridge sync --folder INBOX --limit 150",
      "  proton-mail-bridge folders --json",
      "  proton-mail-bridge digest --json",
      "  proton-mail-bridge attachments INBOX::25642 --json",
      "  proton-mail-bridge search \"label:inbox invoice\"",
      "  proton-mail-bridge search --live --from openai.com",
      "  proton-mail-bridge read INBOX::25642",
      "  proton-mail-bridge tools",
      "  proton-mail-bridge tool get_connection_status",
      "  proton-mail-bridge tool search_indexed_emails --args '{\"query\":\"invoice\",\"limit\":3}'",
      "  proton-mail-bridge claude check",
    ].join("\n"),
  );
}

function isTruthyFlag(value: string | boolean | undefined): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  return ["1", "true", "yes", "y"].includes(value.trim().toLowerCase());
}

function getStringFlag(flags: CliFlags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getNumberFlag(flags: CliFlags, key: string, fallback: number): number {
  const value = flags[key];
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${key} must be a positive integer.`);
  }
  return parsed;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function tableEmails(emails: EmailSummary[]): string {
  if (emails.length === 0) {
    return "No results.\n";
  }

  return [
    "Results:",
    ...emails.map((email, index) => {
      const from = Array.isArray(email.from)
        ? (email.from as Array<{ address?: string; name?: string }>).map((entry) => entry.address || entry.name || "").filter(Boolean).join(", ")
        : "";
      return `${index + 1}. ${email.id} | ${email.subject || "(no subject)"} | ${from} | ${email.date || email.internalDate || ""}`;
    }),
  ].join("\n") + "\n";
}

function summarizeThreadList(value: Record<string, unknown>): string {
  const threads = Array.isArray(value.threads) ? value.threads as Array<Record<string, unknown>> : [];
  if (threads.length === 0) {
    return "No threads.\n";
  }

  return [
    `Threads: ${value.total ?? value.totalThreads ?? threads.length}`,
    ...threads.map((thread, index) => {
      const subject = String(thread.subject || "(no subject)");
      const count = thread.messageCount ?? "?";
      const pending = thread.pendingOn ? ` | pending: ${thread.pendingOn}` : "";
      const latest = thread.latestDate ? ` | ${thread.latestDate}` : "";
      return `${index + 1}. ${thread.id} | ${subject} | messages: ${count}${pending}${latest}`;
    }),
  ].join("\n") + "\n";
}

function printToolCallResult(result: Record<string, unknown>, wantJson: boolean): void {
  if (wantJson) {
    process.stdout.write(json(result));
    return;
  }

  if (typeof result.structuredContent === "object" && result.structuredContent) {
    process.stdout.write(`${JSON.stringify(result.structuredContent, null, 2)}\n`);
    return;
  }

  const content = Array.isArray(result.content) ? result.content : [];
  if (content.length === 0) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const rendered = content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return String(entry);
      }
      if ("type" in entry && entry.type === "text" && "text" in entry) {
        return String(entry.text);
      }
      if ("type" in entry && entry.type === "resource" && "resource" in entry) {
        const resource = entry.resource;
        if (resource && typeof resource === "object") {
          if ("text" in resource) {
            return String(resource.text);
          }
          if ("blob" in resource) {
            return `[resource blob] ${String(resource.uri ?? "")}`;
          }
        }
      }
      if ("type" in entry && entry.type === "resource_link") {
        return `${String(entry.title || entry.name || entry.uri || "resource")} -> ${String(entry.uri || "")}`;
      }
      return JSON.stringify(entry, null, 2);
    })
    .filter(Boolean)
    .join("\n\n");

  process.stdout.write(`${rendered}\n`);
}

async function withMcpClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntryPath()],
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    stderr: "ignore",
  });

  const client = new Client(
    {
      name: "proton-mail-bridge-cli",
      version: "1.6.0",
    },
    {
      capabilities: {},
    },
  );

  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await Promise.allSettled([client.close(), transport.close()]);
  }
}

async function parseToolArgs(parsed: ParsedCliArgs): Promise<Record<string, unknown> | undefined> {
  const inline = getStringFlag(parsed.flags, "args");
  if (inline) {
    const parsedInline = JSON.parse(inline) as unknown;
    if (!parsedInline || typeof parsedInline !== "object" || Array.isArray(parsedInline)) {
      throw new Error("--args must be a JSON object.");
    }
    return parsedInline as Record<string, unknown>;
  }

  const file = getStringFlag(parsed.flags, "args-file");
  if (file) {
    const raw = await readFile(file, "utf8");
    const parsedFile = JSON.parse(raw) as unknown;
    if (!parsedFile || typeof parsedFile !== "object" || Array.isArray(parsedFile)) {
      throw new Error("--args-file must contain a JSON object.");
    }
    return parsedFile as Record<string, unknown>;
  }

  return undefined;
}

function summarizeDigest(value: Record<string, unknown>): string {
  const counts = (value.counts && typeof value.counts === "object") ? value.counts as Record<string, unknown> : {};
  const topThreads = Array.isArray(value.topThreads) ? value.topThreads as Array<Record<string, unknown>> : [];
  const stale = Array.isArray(value.staleAwaitingYou) ? value.staleAwaitingYou as Array<Record<string, unknown>> : [];

  return [
    "Inbox digest",
    `Total threads: ${counts.totalThreads ?? 0}`,
    `Unread threads: ${counts.unreadThreads ?? 0}`,
    `Pending on you: ${counts.pendingOnYou ?? 0}`,
    `Pending on them: ${counts.pendingOnThem ?? 0}`,
    `Stale awaiting you: ${counts.staleAwaitingYou ?? 0}`,
    "",
    "Top threads:",
    ...(topThreads.length > 0
      ? topThreads.map((thread, index) => `${index + 1}. ${thread.subject || "(no subject)"} | ${thread.latestDate || ""}`)
      : ["None"]),
    "",
    "Stale awaiting you:",
    ...(stale.length > 0
      ? stale.map((thread, index) => `${index + 1}. ${thread.subject || "(no subject)"} | ${thread.latestDate || ""}`)
      : ["None"]),
  ].join("\n") + "\n";
}

async function withServices<T>(run: (context: ReturnType<typeof createServer> & { config: ProtonMailConfig }) => Promise<T>): Promise<T> {
  const config = buildConfigFromEnv();
  const services = createServer(config, { startBackgroundSync: false });

  try {
    return await run({ config, ...services });
  } finally {
    services.backgroundSyncService.stop();
    await Promise.allSettled([services.imapService.disconnect(), services.smtpService.close()]);
  }
}

async function syncIndex(context: ReturnType<typeof createServer>, input: {
  folder?: string;
  full?: boolean;
  limitPerFolder?: number;
  includeAttachmentText?: boolean;
}) {
  const snapshot = await context.imapService.collectEmailsForIndex({
    ...input,
    checkpoints: await context.localIndexService.getSyncCheckpointMap(),
  });
  const index = await context.localIndexService.recordSnapshot({
    folders: snapshot.folders,
    emails: snapshot.emails,
    syncedAt: snapshot.syncedAt,
    folderStats: snapshot.folderStats,
  });

  return {
    syncedAt: snapshot.syncedAt,
    full: Boolean(input.full),
    folders: snapshot.folderStats,
    cachedMessages: snapshot.emails.length,
    index,
  };
}

function renderStatus(status: Record<string, unknown>): string {
  const lines = [
    "Proton Mail Bridge status",
    `Account: ${status.account || "unknown"}`,
    `IMAP: ${status.imapHost}:${status.imapPort}`,
    `SMTP: ${status.smtpHost}:${status.smtpPort}`,
  ];

  const index = status.index as Record<string, unknown> | undefined;
  if (index) {
    lines.push(`Index path: ${index.path || "unknown"}`);
    lines.push(`Indexed messages: ${index.dedupedMessageCount || 0}`);
    lines.push(`Index updated: ${index.updatedAt || "never"}`);
  }

  const claude = status.claudeDesktop as Record<string, unknown> | undefined;
  if (claude) {
    lines.push(`Claude Desktop installed: ${claude.installed ? "yes" : "no"}`);
    if (claude.runtimeDir) {
      lines.push(`Claude runtime: ${String(claude.runtimeDir)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function buildSearchFilters(parsed: ParsedCliArgs): SearchEmailsInput {
  return {
    query: parsed.positionals.join(" ") || undefined,
    folder: getStringFlag(parsed.flags, "folder"),
    label: getStringFlag(parsed.flags, "label"),
    from: getStringFlag(parsed.flags, "from"),
    to: getStringFlag(parsed.flags, "to"),
    subject: getStringFlag(parsed.flags, "subject"),
    senderDomain: getStringFlag(parsed.flags, "domain"),
    limit: getNumberFlag(parsed.flags, "limit", 25),
    isRead: isTruthyFlag(parsed.flags.read) ? true : isTruthyFlag(parsed.flags.unread) ? false : undefined,
    isStarred: isTruthyFlag(parsed.flags.starred) ? true : isTruthyFlag(parsed.flags.unstarred) ? false : undefined,
  };
}

async function runStatus(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, localIndexService, backgroundSyncService }) => {
    const [index, claudeDesktop] = await Promise.all([
      localIndexService.getStatus(),
      getClaudeDesktopInstallStatus(),
    ]);

    const result = {
      account: config.smtp.username,
      imapHost: config.imap.host,
      imapPort: config.imap.port,
      smtpHost: config.smtp.host,
      smtpPort: config.smtp.port,
      runtime: sanitizeRuntimeConfig(config.runtime),
      index,
      backgroundSync: backgroundSyncService.getStatus(),
      claudeDesktop,
    };

    process.stdout.write(wantJson ? json(result) : renderStatus(result));
  });
}

async function runDoctor(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, smtpService, imapService, localIndexService }) => {
    const [claudeDesktop, index] = await Promise.all([
      getClaudeDesktopInstallStatus(),
      localIndexService.getStatus(),
    ]);

    let imapOk = false;
    let smtpOk = false;
    let folderCount = 0;
    let error: string | undefined;

    try {
      await imapService.ping();
      imapOk = true;
      folderCount = (await imapService.getFolders(true)).length;
      await smtpService.verifyConnection();
      smtpOk = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const result = {
      ok: imapOk && smtpOk,
      account: config.smtp.username,
      imapOk,
      smtpOk,
      folderCount,
      indexUpdatedAt: index.updatedAt,
      claudeDesktopInstalled: claudeDesktop.installed,
      error,
    };

    process.stdout.write(wantJson ? json(result) : `${result.ok ? "Doctor OK" : "Doctor failed"}\n${json(result)}`);
  });
}

async function runConnectionStatus(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, smtpService, imapService }) => {
    let imapOk = false;
    let smtpOk = false;
    let error: string | undefined;
    try {
      await imapService.ping();
      imapOk = true;
      await smtpService.verifyConnection();
      smtpOk = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const result = {
      account: config.smtp.username,
      imap: {
        host: config.imap.host,
        port: config.imap.port,
        ok: imapOk,
      },
      smtp: {
        host: config.smtp.host,
        port: config.smtp.port,
        ok: smtpOk,
      },
      idle: imapService.getIdleStatus(),
      error,
    };

    process.stdout.write(wantJson ? json(result) : `${JSON.stringify(result, null, 2)}\n`);
  });
}

async function runRuntimeStatus(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, backgroundSyncService, draftStore, localIndexService }) => {
    const result = {
      account: config.smtp.username,
      runtime: sanitizeRuntimeConfig(config.runtime),
      backgroundSync: backgroundSyncService.getStatus(),
      localIndex: await localIndexService.getStatus(),
      drafts: {
        total: (await draftStore.listDrafts(true)).length,
        active: (await draftStore.listDrafts(false)).length,
      },
    };
    process.stdout.write(wantJson ? json(result) : `${JSON.stringify(result, null, 2)}\n`);
  });
}

async function runSync(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async (context) => {
    const result = await syncIndex(context, {
      folder: getStringFlag(parsed.flags, "folder"),
      full: isTruthyFlag(parsed.flags.full),
      limitPerFolder: getNumberFlag(parsed.flags, "limit", 100),
      includeAttachmentText: !isTruthyFlag(parsed.flags["no-attachment-text"]),
    });
    process.stdout.write(wantJson ? json(result) : `${JSON.stringify(result, null, 2)}\n`);
  });
}

async function runIndexStatus(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ localIndexService }) => {
    const result = await localIndexService.getStatus();
    if (wantJson) {
      process.stdout.write(json(result));
      return;
    }
    process.stdout.write(
      [
        "Index status",
        `Path: ${result.path}`,
        `Updated: ${result.updatedAt || "never"}`,
        `Messages: ${result.dedupedMessageCount}`,
        `Threads: ${result.threadCount}`,
        `Labels: ${result.labelCount}`,
        `Stale: ${result.isStale ? "yes" : "no"}`,
      ].join("\n") + "\n",
    );
  });
}

async function runFolders(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ imapService }) => {
    const folders = await imapService.getFolders(true);
    process.stdout.write(wantJson ? json(folders) : `${JSON.stringify(folders, null, 2)}\n`);
  });
}

async function runLabels(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ localIndexService }) => {
    const result = await localIndexService.getLabels(getNumberFlag(parsed.flags, "limit", 100));
    if (wantJson) {
      process.stdout.write(json(result));
      return;
    }
    process.stdout.write(
      result.length === 0
        ? "No labels.\n"
        : result.map((label, index) => `${index + 1}. ${label.name} | ${label.type} | messages: ${label.messageCount}`).join("\n") + "\n",
    );
  });
}

async function runThreads(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  const syncBefore = isTruthyFlag(parsed.flags.sync);
  await withServices(async (context) => {
    if (syncBefore) {
      await syncIndex(context, {
        folder: getStringFlag(parsed.flags, "folder"),
        limitPerFolder: Math.max(getNumberFlag(parsed.flags, "limit", 25), 100),
        includeAttachmentText: true,
      });
    }
    const result = await context.localIndexService.getThreads({
      query: parsed.positionals.join(" ") || undefined,
      label: getStringFlag(parsed.flags, "label"),
      limit: getNumberFlag(parsed.flags, "limit", 25),
    });
    process.stdout.write(wantJson ? json(result) : summarizeThreadList(result as Record<string, unknown>));
  });
}

async function runDigest(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  const syncBefore = isTruthyFlag(parsed.flags.sync);
  await withServices(async (context) => {
    if (syncBefore) {
      await syncIndex(context, { folder: "INBOX", limitPerFolder: 100, includeAttachmentText: true });
    }
    const result = await context.localIndexService.getInboxDigest({
      limit: getNumberFlag(parsed.flags, "limit", 10),
      minAgeHours: getNumberFlag(parsed.flags, "age-hours", 24),
    });
    process.stdout.write(wantJson ? json(result) : summarizeDigest(result as Record<string, unknown>));
  });
}

async function runFollowups(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  const syncBefore = isTruthyFlag(parsed.flags.sync);
  await withServices(async (context) => {
    if (syncBefore) {
      await syncIndex(context, { folder: "INBOX", limitPerFolder: 100, includeAttachmentText: true });
    }
    const pendingOnRaw = getStringFlag(parsed.flags, "pending");
    const pendingOn =
      pendingOnRaw === "you" || pendingOnRaw === "them" || pendingOnRaw === "any"
        ? pendingOnRaw
        : "you";
    const result = await context.localIndexService.getFollowUpCandidates({
      limit: getNumberFlag(parsed.flags, "limit", 25),
      minAgeHours: getNumberFlag(parsed.flags, "age-hours", 24),
      pendingOn,
    });
    process.stdout.write(wantJson ? json(result) : summarizeThreadList(result as Record<string, unknown>));
  });
}

async function runDrafts(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ draftStore }) => {
    const result = await draftStore.listDrafts(isTruthyFlag(parsed.flags.sent));
    if (wantJson) {
      process.stdout.write(json(result));
      return;
    }
    process.stdout.write(
      result.length === 0
        ? "No drafts.\n"
        : result.map((draft, index) => `${index + 1}. ${draft.id} | ${draft.mode} | ${draft.subject}`).join("\n") + "\n",
    );
  });
}

async function runAttachments(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) {
    throw new Error("attachments requires an emailId, for example: proton-mail-bridge attachments INBOX::123");
  }
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ imapService }) => {
    const result = await imapService.listAttachments(emailId);
    if (wantJson) {
      process.stdout.write(json(result));
      return;
    }
    process.stdout.write(
      result.attachments.length === 0
        ? "No attachments.\n"
        : result.attachments.map((attachment, index) => `${index + 1}. ${attachment.filename || attachment.id || "(unnamed)"} | ${attachment.contentType || "unknown"} | ${attachment.kind || "other"}`).join("\n") + "\n",
    );
  });
}

async function runSearch(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  const live = isTruthyFlag(parsed.flags.live);
  const syncBefore = isTruthyFlag(parsed.flags.sync);
  const filters = buildSearchFilters(parsed);

  await withServices(async (context) => {
    if (!live) {
      const status = await context.localIndexService.getStatus();
      if (syncBefore || !status.updatedAt) {
        await syncIndex(context, {
          folder: filters.folder,
          limitPerFolder: Math.max(filters.limit ?? 25, 100),
          includeAttachmentText: true,
        });
      }
      const result = await context.localIndexService.search(filters);
      process.stdout.write(wantJson ? json(result) : tableEmails(result.emails));
      return;
    }

    const result = await context.imapService.searchEmails(filters);
    process.stdout.write(wantJson ? json(result) : tableEmails(result.emails));
  });
}

async function runRead(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) {
    throw new Error("read requires an emailId, for example: proton-mail-bridge read INBOX::123");
  }

  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ imapService }) => {
    const detail = await imapService.getEmailById(emailId);
    if (wantJson) {
      process.stdout.write(json(detail));
      return;
    }

    const lines = [
      `ID: ${detail.id}`,
      `Subject: ${detail.subject}`,
      `From: ${detail.from.map((entry) => entry.address || entry.name || "").filter(Boolean).join(", ")}`,
      `Date: ${detail.date || detail.internalDate || ""}`,
      "",
      detail.text || detail.preview || "(no text body available)",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  });
}

// ── reply/forward helpers (mirrors logic in index.ts) ──────────────────────

function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const address of addresses) {
    const normalized = lowerCaseAddress(address);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(address.trim());
  }
  return result;
}

function addressValues(addresses: EmailAddress[]): string[] {
  return uniqueAddresses(
    addresses.map((a) => a.address?.trim()).filter((a): a is string => Boolean(a)),
  );
}

function prefixedSubject(subject: string, prefix: "Re:" | "Fwd:"): string {
  const trimmed = subject.trim();
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase()) ? trimmed : `${prefix} ${trimmed}`;
}

function formatAddressList(addresses: EmailAddress[]): string {
  return addresses
    .map((a) => (a.name && a.address ? `${a.name} <${a.address}>` : a.address || a.name || ""))
    .filter(Boolean)
    .join(", ");
}

function buildReplyText(detail: EmailDetail, body: string): string {
  const originalText = detail.text || detail.preview || "";
  const fromText = formatAddressList(detail.from);
  const dateText = detail.date || detail.internalDate || "an unknown date";
  return [
    body.trim(),
    "",
    `On ${dateText}, ${fromText || "the sender"} wrote:`,
    originalText.split(/\r?\n/).map((line) => `> ${line}`).join("\n"),
  ].join("\n");
}

function buildForwardText(detail: EmailDetail, body?: string): string {
  const originalText = detail.text || detail.preview || "";
  return [
    body?.trim() || "",
    "",
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
  const to = uniqueAddresses(
    addressValues(primary).filter((address) => lowerCaseAddress(address) !== owner),
  );
  if (!replyAll) return { to, cc: [] };
  const cc = uniqueAddresses([...addressValues(detail.to), ...addressValues(detail.cc)]).filter(
    (address) => {
      const normalized = lowerCaseAddress(address);
      return normalized !== owner && !to.some((r) => lowerCaseAddress(r) === normalized);
    },
  );
  return { to, cc };
}

// ── write commands ──────────────────────────────────────────────────────────

async function runMove(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  const targetFolder = parsed.positionals[1] || getStringFlag(parsed.flags, "folder");
  if (!emailId) throw new Error("move requires an emailId");
  if (!targetFolder) throw new Error("move requires a target folder as a second argument or --folder");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, imapService }) => {
    ensureMailboxWriteAllowed(config.runtime);
    const result = await imapService.moveEmail(emailId, targetFolder);
    process.stdout.write(wantJson ? json(result) : `Moved ${emailId} → ${result.targetFolder}\n`);
  });
}

async function runArchive(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("archive requires an emailId");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, imapService }) => {
    ensureMailboxWriteAllowed(config.runtime);
    const result = await imapService.archiveEmail(emailId);
    process.stdout.write(wantJson ? json(result) : `Archived ${emailId} → ${result.targetFolder}\n`);
  });
}

async function runTrash(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("trash requires an emailId");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, imapService }) => {
    ensureMailboxWriteAllowed(config.runtime);
    const result = await imapService.trashEmail(emailId);
    process.stdout.write(wantJson ? json(result) : `Trashed ${emailId} → ${result.targetFolder}\n`);
  });
}

async function runRestore(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("restore requires an emailId");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, imapService }) => {
    ensureMailboxWriteAllowed(config.runtime);
    const result = await imapService.restoreEmail(emailId, getStringFlag(parsed.flags, "folder"));
    process.stdout.write(wantJson ? json(result) : `Restored ${emailId} → ${result.targetFolder}\n`);
  });
}

async function runMarkRead(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("mark-read requires an emailId");
  const isRead = !isTruthyFlag(parsed.flags.unread);
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, imapService }) => {
    ensureMailboxWriteAllowed(config.runtime);
    const result = await imapService.markEmailRead(emailId, isRead);
    process.stdout.write(wantJson ? json(result) : `Marked ${emailId} as ${result.isRead ? "read" : "unread"}\n`);
  });
}

async function runStar(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("star requires an emailId");
  const isStarred = !isTruthyFlag(parsed.flags.unstar);
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, imapService }) => {
    ensureMailboxWriteAllowed(config.runtime);
    const result = await imapService.starEmail(emailId, isStarred);
    process.stdout.write(wantJson ? json(result) : `${result.isStarred ? "Starred" : "Unstarred"} ${emailId}\n`);
  });
}

async function runDelete(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("delete requires an emailId");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, imapService }) => {
    ensureMailboxWriteAllowed(config.runtime);
    const result = await imapService.deleteEmail(emailId);
    process.stdout.write(wantJson ? json(result) : `Deleted ${emailId}\n`);
  });
}

async function runSend(parsed: ParsedCliArgs): Promise<void> {
  const to = parseEmails(getStringFlag(parsed.flags, "to") || "");
  const cc = parseEmails(getStringFlag(parsed.flags, "cc") || "");
  const bcc = parseEmails(getStringFlag(parsed.flags, "bcc") || "");
  const subject = getStringFlag(parsed.flags, "subject");
  if (to.length === 0) throw new Error("send requires --to");
  if (!subject) throw new Error("send requires --subject");

  let body = getStringFlag(parsed.flags, "body");
  if (!body) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    body = Buffer.concat(chunks).toString("utf8").trim();
  }
  if (!body) throw new Error("send requires --body or body piped via stdin");

  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, smtpService }) => {
    ensureSendAllowed(config.runtime);
    ensureValidEmails(to, "to");
    ensureValidEmails(cc, "cc");
    ensureValidEmails(bcc, "bcc");
    const result = await smtpService.sendEmail({ to, cc, bcc, subject, body: body!, isHtml: isTruthyFlag(parsed.flags.html) });
    process.stdout.write(wantJson ? json(result) : `Sent. messageId=${result.messageId ?? "unknown"} accepted=${result.accepted.join(",")}\n`);
  });
}

async function runReply(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("reply requires an emailId");
  const replyAll = isTruthyFlag(parsed.flags["reply-all"]) || isTruthyFlag(parsed.flags.all);

  let body = getStringFlag(parsed.flags, "body");
  if (!body) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    body = Buffer.concat(chunks).toString("utf8").trim();
  }
  if (!body) throw new Error("reply requires --body or body piped via stdin");

  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, smtpService, imapService }) => {
    ensureSendAllowed(config.runtime);
    const detail = await imapService.getEmailById(emailId);
    const recipients = getReplyRecipients(detail, config.smtp.username, replyAll);
    if (recipients.to.length === 0) throw new Error("Unable to infer reply recipient.");
    const result = await smtpService.sendEmail({
      to: recipients.to,
      cc: recipients.cc,
      subject: prefixedSubject(detail.subject, "Re:"),
      body: buildReplyText(detail, body!),
      inReplyTo: detail.messageId,
      references: detail.messageId ? [detail.messageId] : undefined,
    });
    process.stdout.write(wantJson ? json({ repliedTo: emailId, to: recipients.to, messageId: result.messageId }) : `Reply sent to ${recipients.to.join(", ")}\n`);
  });
}

async function runForward(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0];
  if (!emailId) throw new Error("forward requires an emailId");
  const to = parseEmails(getStringFlag(parsed.flags, "to") || "");
  if (to.length === 0) throw new Error("forward requires --to");

  let body = getStringFlag(parsed.flags, "body");
  if (!body) {
    const stdinChunks: Buffer[] = [];
    for await (const chunk of process.stdin) stdinChunks.push(Buffer.from(chunk));
    const stdinText = Buffer.concat(stdinChunks).toString("utf8").trim();
    if (stdinText) body = stdinText;
  }

  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, smtpService, imapService }) => {
    ensureSendAllowed(config.runtime);
    ensureValidEmails(to, "to");
    const detail = await imapService.getEmailById(emailId);
    const result = await smtpService.sendEmail({
      to,
      subject: prefixedSubject(detail.subject, "Fwd:"),
      body: buildForwardText(detail, body),
    });
    process.stdout.write(wantJson ? json({ forwardedMessage: emailId, to, messageId: result.messageId }) : `Forwarded to ${to.join(", ")}\n`);
  });
}

async function runCreateFolder(parsed: ParsedCliArgs): Promise<void> {
  const path = parsed.positionals[0] || getStringFlag(parsed.flags, "path");
  if (!path) throw new Error("create-folder requires a path argument");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, imapService }) => {
    ensureMailboxWriteAllowed(config.runtime);
    const result = await imapService.createFolder(path);
    process.stdout.write(wantJson ? json(result) : `${result.created ? "Created" : "Already existed"}: ${result.path}\n`);
  });
}

async function runRenameFolder(parsed: ParsedCliArgs): Promise<void> {
  const path = parsed.positionals[0] || getStringFlag(parsed.flags, "path");
  const newPath = parsed.positionals[1] || getStringFlag(parsed.flags, "to") || getStringFlag(parsed.flags, "new-path");
  if (!path) throw new Error("rename-folder requires a source path argument");
  if (!newPath) throw new Error("rename-folder requires a target path as second argument or --to");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, imapService }) => {
    ensureMailboxWriteAllowed(config.runtime);
    const result = await imapService.renameFolder(path, newPath);
    process.stdout.write(wantJson ? json(result) : `Renamed: ${result.path} → ${result.newPath}\n`);
  });
}

async function runDeleteFolder(parsed: ParsedCliArgs): Promise<void> {
  const path = parsed.positionals[0] || getStringFlag(parsed.flags, "path");
  if (!path) throw new Error("delete-folder requires a path argument");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withServices(async ({ config, imapService }) => {
    ensureMailboxWriteAllowed(config.runtime);
    const result = await imapService.deleteFolder(path);
    process.stdout.write(wantJson ? json(result) : `Deleted folder: ${result.path}\n`);
  });
}

// draft commands go through withMcpClient to reuse policy/remote-sync logic in index.ts
async function runEmails(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "get_emails",
      arguments: {
        folder: getStringFlag(parsed.flags, "folder") || "INBOX",
        limit: getNumberFlag(parsed.flags, "limit", 50),
        offset: getNumberFlag(parsed.flags, "offset", 0),
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runThread(parsed: ParsedCliArgs): Promise<void> {
  const threadId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!threadId) throw new Error("thread requires a threadId");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "get_thread_by_id", arguments: { threadId } });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runThreadBrief(parsed: ParsedCliArgs): Promise<void> {
  const threadId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!threadId) throw new Error("thread-brief requires a threadId");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "get_thread_brief", arguments: { threadId } });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runActionable(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "get_actionable_threads",
      arguments: { limit: getNumberFlag(parsed.flags, "limit", 25) },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDocumentThreads(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "find_document_threads",
      arguments: {
        category: getStringFlag(parsed.flags, "category"),
        query: parsed.positionals.join(" ") || undefined,
        limit: getNumberFlag(parsed.flags, "limit", 25),
        sync: isTruthyFlag(parsed.flags.sync) || undefined,
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runMeetingContext(parsed: ParsedCliArgs): Promise<void> {
  const person = parsed.positionals[0] || getStringFlag(parsed.flags, "person");
  const domain = getStringFlag(parsed.flags, "domain");
  if (!person && !domain) throw new Error("meeting-context requires a person argument or --domain");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "prepare_meeting_context",
      arguments: {
        person,
        domain,
        limit: getNumberFlag(parsed.flags, "limit", 10),
        sync: isTruthyFlag(parsed.flags.sync) || undefined,
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runThreadAction(parsed: ParsedCliArgs): Promise<void> {
  const threadId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  const action = parsed.positionals[1] || getStringFlag(parsed.flags, "action");
  if (!threadId) throw new Error("thread-action requires a threadId");
  if (!action) throw new Error("thread-action requires an action (mark_read|mark_unread|star|unstar|archive|trash|restore)");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "apply_thread_action",
      arguments: {
        threadId,
        action,
        targetFolder: getStringFlag(parsed.flags, "folder"),
        unreadOnly: isTruthyFlag(parsed.flags["unread-only"]) || undefined,
        dryRun: isTruthyFlag(parsed.flags["dry-run"]) || undefined,
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runBatch(parsed: ParsedCliArgs): Promise<void> {
  const action = parsed.positionals[0] || getStringFlag(parsed.flags, "action");
  const emailIds = parsed.positionals.slice(1).join(",") || getStringFlag(parsed.flags, "ids");
  if (!action) throw new Error("batch requires an action (mark_read|mark_unread|star|unstar|archive|trash|restore)");
  if (!emailIds) throw new Error("batch requires email ids as positional args or --ids");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "batch_email_action",
      arguments: {
        emailIds,
        action,
        targetFolder: getStringFlag(parsed.flags, "folder"),
        dryRun: isTruthyFlag(parsed.flags["dry-run"]) || undefined,
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runStats(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "get_email_stats", arguments: {} });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runAnalytics(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "get_email_analytics", arguments: {} });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runContacts(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "get_contacts",
      arguments: { limit: getNumberFlag(parsed.flags, "limit", 100) },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runVolumeTrends(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "get_volume_trends",
      arguments: { days: getNumberFlag(parsed.flags, "days", 30) },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runWatch(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "wait_for_mailbox_changes",
      arguments: {
        folder: getStringFlag(parsed.flags, "folder") || "INBOX",
        timeoutSeconds: getNumberFlag(parsed.flags, "timeout", 15),
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runTestEmail(parsed: ParsedCliArgs): Promise<void> {
  const to = parsed.positionals[0] || getStringFlag(parsed.flags, "to");
  if (!to) throw new Error("test-email requires a recipient address");
  if (!isValidEmail(to)) throw new Error("test-email: invalid email address");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "send_test_email",
      arguments: { to, customMessage: getStringFlag(parsed.flags, "message") },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftCreate(parsed: ParsedCliArgs): Promise<void> {
  const to = getStringFlag(parsed.flags, "to") || "";
  const subject = getStringFlag(parsed.flags, "subject");
  if (!subject) throw new Error("draft-create requires --subject");
  let body = getStringFlag(parsed.flags, "body");
  if (!body) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    body = Buffer.concat(chunks).toString("utf8").trim();
  }
  if (!body) throw new Error("draft-create requires --body or body piped via stdin");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "create_draft",
      arguments: { to, subject, body, cc: getStringFlag(parsed.flags, "cc") || "", bcc: getStringFlag(parsed.flags, "bcc") || "" },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftRead(parsed: ParsedCliArgs): Promise<void> {
  const draftId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!draftId) throw new Error("draft-read requires a draft id");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "get_draft", arguments: { draftId } });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftUpdate(parsed: ParsedCliArgs): Promise<void> {
  const draftId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!draftId) throw new Error("draft-update requires a draft id");
  let body = getStringFlag(parsed.flags, "body");
  if (!body) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (text) body = text;
  }
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "update_draft",
      arguments: {
        draftId,
        to: getStringFlag(parsed.flags, "to"),
        cc: getStringFlag(parsed.flags, "cc"),
        bcc: getStringFlag(parsed.flags, "bcc"),
        subject: getStringFlag(parsed.flags, "subject"),
        body: body || undefined,
        notes: getStringFlag(parsed.flags, "notes"),
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftReply(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!emailId) throw new Error("draft-reply requires an emailId");
  let body = getStringFlag(parsed.flags, "body");
  if (!body) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (text) body = text;
  }
  if (!body) throw new Error("draft-reply requires --body or body piped via stdin");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "create_reply_draft",
      arguments: {
        emailId,
        body,
        replyAll: isTruthyFlag(parsed.flags["reply-all"]) || isTruthyFlag(parsed.flags.all) || undefined,
        cc: getStringFlag(parsed.flags, "cc"),
        bcc: getStringFlag(parsed.flags, "bcc"),
        notes: getStringFlag(parsed.flags, "notes"),
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftForward(parsed: ParsedCliArgs): Promise<void> {
  const emailId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  const to = getStringFlag(parsed.flags, "to");
  if (!emailId) throw new Error("draft-forward requires an emailId");
  if (!to) throw new Error("draft-forward requires --to");
  let body = getStringFlag(parsed.flags, "body");
  if (!body) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (text) body = text;
  }
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "create_forward_draft",
      arguments: { emailId, to, body: body || undefined, cc: getStringFlag(parsed.flags, "cc"), bcc: getStringFlag(parsed.flags, "bcc"), notes: getStringFlag(parsed.flags, "notes") },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftSync(parsed: ParsedCliArgs): Promise<void> {
  const draftId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!draftId) throw new Error("draft-sync requires a draft id");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "sync_draft_to_remote", arguments: { draftId } });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runRemoteDrafts(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "list_remote_drafts",
      arguments: { limit: getNumberFlag(parsed.flags, "limit", 50), offset: getNumberFlag(parsed.flags, "offset", 0) },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftThreadReply(parsed: ParsedCliArgs): Promise<void> {
  const threadId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!threadId) throw new Error("draft-thread-reply requires a threadId");
  let body = getStringFlag(parsed.flags, "body");
  if (!body) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (text) body = text;
  }
  if (!body) throw new Error("draft-thread-reply requires --body or body piped via stdin");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "create_thread_reply_draft",
      arguments: {
        threadId,
        body,
        replyAll: isTruthyFlag(parsed.flags["reply-all"]) || isTruthyFlag(parsed.flags.all) || undefined,
        cc: getStringFlag(parsed.flags, "cc"),
        bcc: getStringFlag(parsed.flags, "bcc"),
        notes: getStringFlag(parsed.flags, "notes"),
      },
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftSend(parsed: ParsedCliArgs): Promise<void> {
  const draftId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!draftId) throw new Error("draft-send requires a draft id");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "send_draft", arguments: { draftId } });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runDraftDelete(parsed: ParsedCliArgs): Promise<void> {
  const draftId = parsed.positionals[0] || getStringFlag(parsed.flags, "id");
  if (!draftId) throw new Error("draft-delete requires a draft id");
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "delete_draft", arguments: { draftId } });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runTools(parsed: ParsedCliArgs): Promise<void> {
  const wantJson = isTruthyFlag(parsed.flags.json);
  await withMcpClient(async (client) => {
    const result = await client.listTools();
    if (wantJson) {
      process.stdout.write(json(result));
      return;
    }
    process.stdout.write(
      result.tools.length === 0
        ? "No MCP tools exposed.\n"
        : result.tools
            .map((tool, index) => `${index + 1}. ${tool.name}${tool.description ? ` | ${tool.description}` : ""}`)
            .join("\n") + "\n",
    );
  });
}

async function runTool(parsed: ParsedCliArgs): Promise<void> {
  const toolName = parsed.positionals[0];
  if (!toolName) {
    throw new Error("tool requires a tool name, for example: proton-mail-bridge tool get_connection_status");
  }

  const wantJson = isTruthyFlag(parsed.flags.json);
  const args = await parseToolArgs(parsed);

  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: toolName,
      arguments: args,
    });
    printToolCallResult(result as Record<string, unknown>, wantJson);
  });
}

async function runClaude(parsed: ParsedCliArgs): Promise<void> {
  switch (parsed.subcommand) {
    case "setup":
      await runClaudeDesktopSetupWizard();
      return;
    case "install":
    case "update": {
      const result = await installClaudeDesktopConfig();
      process.stdout.write(json(result));
      return;
    }
    case "check":
    case "doctor": {
      const result = await getClaudeDesktopInstallStatus();
      process.stdout.write(json(result));
      return;
    }
    default:
      throw new Error("claude requires one of: setup, install, update, check, doctor");
  }
}

export async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));

  switch (parsed.command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "status":
      await runStatus(parsed);
      return;
    case "doctor":
      await runDoctor(parsed);
      return;
    case "connection-status":
      await runConnectionStatus(parsed);
      return;
    case "runtime-status":
      await runRuntimeStatus(parsed);
      return;
    case "sync":
      await runSync(parsed);
      return;
    case "index-status":
      await runIndexStatus(parsed);
      return;
    case "folders":
      await runFolders(parsed);
      return;
    case "create-folder":
      await runCreateFolder(parsed);
      return;
    case "rename-folder":
      await runRenameFolder(parsed);
      return;
    case "delete-folder":
      await runDeleteFolder(parsed);
      return;
    case "labels":
      await runLabels(parsed);
      return;
    case "threads":
      await runThreads(parsed);
      return;
    case "digest":
      await runDigest(parsed);
      return;
    case "followups":
      await runFollowups(parsed);
      return;
    case "drafts":
      await runDrafts(parsed);
      return;
    case "attachments":
      await runAttachments(parsed);
      return;
    case "search":
      await runSearch(parsed);
      return;
    case "read":
      await runRead(parsed);
      return;
    case "move":
      await runMove(parsed);
      return;
    case "archive":
      await runArchive(parsed);
      return;
    case "trash":
      await runTrash(parsed);
      return;
    case "restore":
      await runRestore(parsed);
      return;
    case "mark-read":
      await runMarkRead(parsed);
      return;
    case "star":
      await runStar(parsed);
      return;
    case "delete":
      await runDelete(parsed);
      return;
    case "send":
      await runSend(parsed);
      return;
    case "reply":
      await runReply(parsed);
      return;
    case "forward":
      await runForward(parsed);
      return;
    case "emails":
      await runEmails(parsed);
      return;
    case "thread":
      await runThread(parsed);
      return;
    case "thread-brief":
      await runThreadBrief(parsed);
      return;
    case "actionable":
      await runActionable(parsed);
      return;
    case "document-threads":
      await runDocumentThreads(parsed);
      return;
    case "meeting-context":
      await runMeetingContext(parsed);
      return;
    case "thread-action":
      await runThreadAction(parsed);
      return;
    case "batch":
      await runBatch(parsed);
      return;
    case "stats":
      await runStats(parsed);
      return;
    case "analytics":
      await runAnalytics(parsed);
      return;
    case "contacts":
      await runContacts(parsed);
      return;
    case "volume-trends":
      await runVolumeTrends(parsed);
      return;
    case "watch":
      await runWatch(parsed);
      return;
    case "test-email":
      await runTestEmail(parsed);
      return;
    case "draft-create":
      await runDraftCreate(parsed);
      return;
    case "draft-read":
      await runDraftRead(parsed);
      return;
    case "draft-update":
      await runDraftUpdate(parsed);
      return;
    case "draft-reply":
      await runDraftReply(parsed);
      return;
    case "draft-forward":
      await runDraftForward(parsed);
      return;
    case "draft-sync":
      await runDraftSync(parsed);
      return;
    case "draft-send":
      await runDraftSend(parsed);
      return;
    case "draft-delete":
      await runDraftDelete(parsed);
      return;
    case "remote-drafts":
      await runRemoteDrafts(parsed);
      return;
    case "draft-thread-reply":
      await runDraftThreadReply(parsed);
      return;
    case "tools":
      await runTools(parsed);
      return;
    case "tool":
      await runTool(parsed);
      return;
    case "claude":
      await runClaude(parsed);
      return;
    default:
      throw new Error(`Unknown command: ${parsed.command}`);
  }
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
