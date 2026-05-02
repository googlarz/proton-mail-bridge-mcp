import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveClaudeDesktopConfigPath,
} from "./install-claude-desktop.js";

const DEFAULT_SERVER_NAME = "proton-mail-bridge";

export interface ClaudeDesktopInstallStatus {
  configPath: string;
  serverName: string;
  configExists: boolean;
  installed: boolean;
  runtimeDir?: string;
  entryCommand?: string;
  entryArgs?: string[];
  runtimeEntryExists: boolean;
  runtimeNodeModulesExists: boolean;
  hasEnvConfig: boolean;
}

function parseCliArgs(argv: string[]): { configPath?: string; serverName?: string; json?: boolean } {
  const options: { configPath?: string; serverName?: string; json?: boolean } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    switch (token) {
      case "--config-path":
        if (!next) {
          throw new Error("--config-path requires a value.");
        }
        options.configPath = next;
        index += 1;
        break;
      case "--server-name":
        if (!next) {
          throw new Error("--server-name requires a value.");
        }
        options.serverName = next;
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          [
            "Usage: node dist/scripts/check-claude-desktop.js [options]",
            "",
            "Options:",
            "  --config-path <path>  Override Claude Desktop config path",
            "  --server-name <name>  MCP server key to inspect (default: proton-mail-bridge)",
            "  --json                Print machine-readable JSON output",
          ].join("\n"),
        );
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

async function pathExists(targetPath: string | undefined): Promise<boolean> {
  if (!targetPath) {
    return false;
  }

  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function getClaudeDesktopInstallStatus(options: {
  configPath?: string;
  serverName?: string;
} = {}): Promise<ClaudeDesktopInstallStatus> {
  const configPath = resolveClaudeDesktopConfigPath(options.configPath);
  const serverName = options.serverName || DEFAULT_SERVER_NAME;

  let configExists = false;
  let parsed: Record<string, unknown> = {};

  try {
    const raw = await readFile(configPath, "utf8");
    parsed = JSON.parse(raw) as Record<string, unknown>;
    configExists = true;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) {
      throw error;
    }
  }

  const servers =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};
  const entry =
    servers[serverName] && typeof servers[serverName] === "object" && !Array.isArray(servers[serverName])
      ? (servers[serverName] as Record<string, unknown>)
      : undefined;

  const runtimeDir = typeof entry?.cwd === "string" ? entry.cwd : undefined;
  const entryArgs = Array.isArray(entry?.args) ? entry.args.filter((value) => typeof value === "string") as string[] : [];
  const runtimeEntry = entryArgs[0];

  return {
    configPath,
    serverName,
    configExists,
    installed: Boolean(entry),
    runtimeDir,
    entryCommand: typeof entry?.command === "string" ? entry.command : undefined,
    entryArgs,
    runtimeEntryExists: await pathExists(runtimeEntry),
    runtimeNodeModulesExists: await pathExists(runtimeDir ? resolve(runtimeDir, "node_modules") : undefined),
    hasEnvConfig: Boolean(entry?.env && typeof entry.env === "object" && !Array.isArray(entry.env)),
  };
}

function renderStatus(status: ClaudeDesktopInstallStatus): string {
  if (!status.configExists) {
    return [
      "Claude Desktop config not found.",
      `Expected config path: ${status.configPath}`,
      "Run npm run setup:claude-desktop to install Proton Mail Bridge Client for Claude Desktop.",
    ].join("\n");
  }

  if (!status.installed) {
    return [
      "Proton Mail Bridge Client is not currently registered in Claude Desktop.",
      `Config path: ${status.configPath}`,
      `Expected server key: ${status.serverName}`,
      "Run npm run setup:claude-desktop to add it.",
    ].join("\n");
  }

  return [
    "Claude Desktop install looks present.",
    `Config path: ${status.configPath}`,
    `Server key: ${status.serverName}`,
    `Runtime dir: ${status.runtimeDir || "unknown"}`,
    `Runtime entry exists: ${status.runtimeEntryExists ? "yes" : "no"}`,
    `Runtime dependencies exist: ${status.runtimeNodeModulesExists ? "yes" : "no"}`,
    `Env config present: ${status.hasEnvConfig ? "yes" : "no"}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const status = await getClaudeDesktopInstallStatus(options);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderStatus(status)}\n`);
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
