import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getClaudeDesktopInstallStatus } from "../dist/scripts/check-claude-desktop.js";

test("getClaudeDesktopInstallStatus reports not installed when config is missing", async () => {
  const configPath = join(tmpdir(), `claude-missing-${Date.now()}.json`);
  const status = await getClaudeDesktopInstallStatus({ configPath });

  assert.equal(status.configExists, false);
  assert.equal(status.installed, false);
});

test("getClaudeDesktopInstallStatus reports installed runtime details", async () => {
  const baseDir = join(tmpdir(), `claude-install-${Date.now()}`);
  const runtimeDir = join(baseDir, "runtime");
  const distDir = join(runtimeDir, "dist");
  const nodeModulesDir = join(runtimeDir, "node_modules");
  const configPath = join(baseDir, "claude.json");

  await mkdir(distDir, { recursive: true });
  await mkdir(nodeModulesDir, { recursive: true });
  await writeFile(join(distDir, "index.js"), "console.log('ok');\n", "utf8");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          "proton-mail-bridge": {
            command: "node",
            args: [join(runtimeDir, "dist", "index.js")],
            cwd: runtimeDir,
            env: {
              PROTONMAIL_USERNAME: "user@proton.me",
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const status = await getClaudeDesktopInstallStatus({ configPath });

  assert.equal(status.configExists, true);
  assert.equal(status.installed, true);
  assert.equal(status.runtimeDir, runtimeDir);
  assert.equal(status.runtimeEntryExists, true);
  assert.equal(status.runtimeNodeModulesExists, true);
  assert.equal(status.hasEnvConfig, true);
});
