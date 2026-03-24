import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SERVER_NAME = "proton-mail-bridge";

export interface ClaudeDesktopServerConfig {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface InstallOptions {
  configPath?: string;
  serverName?: string;
  cwd?: string;
  command?: string;
  includeEnv?: boolean;
  env?: Record<string, string>;
}

function parseCliArgs(argv: string[]): InstallOptions {
  const options: InstallOptions = {};

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
      case "--cwd":
        if (!next) {
          throw new Error("--cwd requires a value.");
        }
        options.cwd = next;
        index += 1;
        break;
      case "--command":
        if (!next) {
          throw new Error("--command requires a value.");
        }
        options.command = next;
        index += 1;
        break;
      case "--no-env":
        options.includeEnv = false;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: node dist/scripts/install-claude-desktop.js [options]",
      "",
      "Options:",
      "  --config-path <path>  Override Claude Desktop config path",
      "  --server-name <name>  MCP server key to write (default: proton-mail-bridge)",
      "  --cwd <path>          Repo root to use as the MCP cwd",
      "  --command <path>      Node executable to use (default: current process.execPath)",
      "  --no-env              Do not copy current PROTONMAIL_* / DEBUG env into config",
    ].join("\n"),
  );
}

export function resolveClaudeDesktopConfigPath(explicitPath?: string): string {
  if (explicitPath?.trim()) {
    return resolve(explicitPath);
  }

  const fromEnv = process.env.CLAUDE_DESKTOP_CONFIG_PATH?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }

  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}

export function collectInstallEnv(sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sourceEnv).filter(
      ([key, value]) => Boolean(value) && (key.startsWith("PROTONMAIL_") || key === "DEBUG"),
    ) as Array<[string, string]>,
  );
}

export function buildClaudeDesktopServerConfig(
  options: InstallOptions = {},
): { serverName: string; serverConfig: ClaudeDesktopServerConfig } {
  const cwd = resolve(options.cwd || join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const command = options.command || process.execPath;
  const env =
    options.includeEnv === false
      ? undefined
      : {
          ...collectInstallEnv(),
          ...(options.env ?? {}),
        };

  return {
    serverName: options.serverName || DEFAULT_SERVER_NAME,
    serverConfig: {
      command,
      args: [join(cwd, "dist", "index.js")],
      cwd,
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
    },
  };
}

export function mergeClaudeDesktopConfig(
  existing: Record<string, unknown>,
  serverName: string,
  serverConfig: ClaudeDesktopServerConfig,
): Record<string, unknown> {
  const existingServers =
    existing.mcpServers && typeof existing.mcpServers === "object" && !Array.isArray(existing.mcpServers)
      ? (existing.mcpServers as Record<string, unknown>)
      : {};

  return {
    ...existing,
    mcpServers: {
      ...existingServers,
      [serverName]: serverConfig,
    },
  };
}

async function readExistingConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Claude Desktop config at ${configPath} must contain a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function backupConfigIfPresent(configPath: string): Promise<string | undefined> {
  try {
    await access(configPath, fsConstants.F_OK);
    const backupPath = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(configPath, backupPath);
    return backupPath;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function installClaudeDesktopConfig(options: InstallOptions = {}): Promise<{
  configPath: string;
  backupPath?: string;
  serverName: string;
  serverConfig: ClaudeDesktopServerConfig;
}> {
  const configPath = resolveClaudeDesktopConfigPath(options.configPath);
  const existing = await readExistingConfig(configPath);
  const { serverName, serverConfig } = buildClaudeDesktopServerConfig(options);
  const merged = mergeClaudeDesktopConfig(existing, serverName, serverConfig);

  await mkdir(dirname(configPath), { recursive: true });
  const backupPath = await backupConfigIfPresent(configPath);
  await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  return {
    configPath,
    backupPath,
    serverName,
    serverConfig,
  };
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const result = await installClaudeDesktopConfig(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
