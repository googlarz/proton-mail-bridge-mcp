import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureEmailActionAllowed,
  ensureSendAllowed,
  resolveRemoteDraftSync,
  sanitizeRuntimeConfig,
} from "../dist/utils/runtime-policy.js";

function createRuntime(overrides = {}) {
  return {
    readOnly: false,
    allowSend: true,
    allowRemoteDraftSync: true,
    allowedActions: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore"],
    startupSync: true,
    autoSyncFolder: "INBOX",
    autoSyncFull: false,
    autoSyncLimitPerFolder: 100,
    idleWatchEnabled: true,
    idleMaxSeconds: 30,
    ...overrides,
  };
}

test("read-only runtime blocks send and remote mailbox actions", () => {
  const runtime = createRuntime({ readOnly: true, allowSend: false, allowRemoteDraftSync: false });

  assert.throws(() => ensureSendAllowed(runtime), /disabled/i);
  assert.throws(() => ensureEmailActionAllowed(runtime, "archive"), /read-only mode/i);
  assert.deepEqual(resolveRemoteDraftSync(runtime, true), {
    enabled: false,
    reason: "Remote draft sync is disabled because the server is running in read-only mode.",
  });
});

test("allowed actions are enforced explicitly", () => {
  const runtime = createRuntime({ allowedActions: ["mark_read", "mark_unread"] });

  assert.doesNotThrow(() => ensureEmailActionAllowed(runtime, "mark_read"));
  assert.throws(
    () => ensureEmailActionAllowed(runtime, "trash"),
    /disabled by the current runtime policy/i,
  );
});

test("sanitized runtime config excludes secrets and preserves policy flags", () => {
  const runtime = createRuntime({ allowSend: false, autoSyncFolder: "Archive" });
  assert.deepEqual(sanitizeRuntimeConfig(runtime), {
    readOnly: false,
    allowSend: false,
    allowRemoteDraftSync: true,
    allowedActions: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore"],
    startupSync: true,
    autoSyncFolder: "Archive",
    autoSyncFull: false,
    autoSyncLimitPerFolder: 100,
    idleWatchEnabled: true,
    idleMaxSeconds: 30,
  });
});
