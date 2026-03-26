#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildConfigFromEnv, createServer } from "./index.js";
import type { EmailSummary, ProtonMailConfig, SearchEmailsInput } from "./types/index.js";
import { sanitizeRuntimeConfig } from "./utils/runtime-policy.js";
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
      "Proton Mail Bridge CLI",
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
      "  labels                 List normalized labels from the local index",
      "  threads [query]        List normalized threads from the local index",
      "  digest                 Show inbox digest and top actionable threads",
      "  followups              Show follow-up candidates from the local index",
      "  drafts                 List local drafts",
      "  attachments <emailId>  List attachments for one message",
      "  search [query]         Search indexed mail (default) or live mail with --live",
      "  read <emailId>         Read one email by composite email id",
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
