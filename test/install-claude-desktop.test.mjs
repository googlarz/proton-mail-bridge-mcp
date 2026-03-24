import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  buildClaudeDesktopServerConfig,
  collectInstallEnv,
  mergeClaudeDesktopConfig,
  resolveClaudeDesktopConfigPath,
} from "../dist/scripts/install-claude-desktop.js";

test("collectInstallEnv keeps only PROTONMAIL_* and DEBUG keys", () => {
  const env = collectInstallEnv({
    PROTONMAIL_USERNAME_FILE: "/run/secrets/user",
    PROTONMAIL_PASSWORD_COMMAND: "security find-generic-password ...",
    DEBUG: "true",
    HOME: "/Users/example",
  });

  assert.deepEqual(env, {
    PROTONMAIL_USERNAME_FILE: "/run/secrets/user",
    PROTONMAIL_PASSWORD_COMMAND: "security find-generic-password ...",
    DEBUG: "true",
  });
});

test("buildClaudeDesktopServerConfig points Claude Desktop at dist/index.js", () => {
  const { serverName, serverConfig } = buildClaudeDesktopServerConfig({
    cwd: "/tmp/protonmail-pro-mcp",
    command: "/usr/local/bin/node",
    env: { PROTONMAIL_USERNAME_FILE: "/run/secrets/user" },
  });

  assert.equal(serverName, "proton-mail-bridge");
  assert.equal(serverConfig.command, "/usr/local/bin/node");
  assert.deepEqual(serverConfig.args, ["/tmp/protonmail-pro-mcp/dist/index.js"]);
  assert.equal(serverConfig.cwd, "/tmp/protonmail-pro-mcp");
  assert.equal(serverConfig.env.PROTONMAIL_USERNAME_FILE, "/run/secrets/user");
});

test("mergeClaudeDesktopConfig preserves existing servers", () => {
  const merged = mergeClaudeDesktopConfig(
    {
      theme: "dark",
      mcpServers: {
        existing: {
          command: "node",
          args: ["dist/existing.js"],
          cwd: "/tmp/existing",
        },
      },
    },
    "proton-mail-bridge",
    {
      command: "node",
      args: ["dist/index.js"],
      cwd: "/tmp/protonmail-pro-mcp",
    },
  );

  assert.equal(merged.theme, "dark");
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ["existing", "proton-mail-bridge"]);
});

test("resolveClaudeDesktopConfigPath honors explicit paths", () => {
  const resolved = resolveClaudeDesktopConfigPath(join("/tmp", "claude.json"));
  assert.equal(resolved, "/tmp/claude.json");
});
