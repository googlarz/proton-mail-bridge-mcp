import type { EmailAction, ProtonRuntimeConfig } from "../types/index.js";

export function sanitizeRuntimeConfig(runtime: ProtonRuntimeConfig): Record<string, unknown> {
  return {
    readOnly: runtime.readOnly,
    allowSend: runtime.allowSend,
    allowRemoteDraftSync: runtime.allowRemoteDraftSync,
    allowedActions: [...runtime.allowedActions],
    startupSync: runtime.startupSync,
    autoSyncFolder: runtime.autoSyncFolder,
    autoSyncFull: runtime.autoSyncFull,
    autoSyncLimitPerFolder: runtime.autoSyncLimitPerFolder,
    idleWatchEnabled: runtime.idleWatchEnabled,
    idleMaxSeconds: runtime.idleMaxSeconds,
  };
}

export function ensureSendAllowed(runtime: ProtonRuntimeConfig): void {
  if (!runtime.allowSend || runtime.readOnly) {
    throw new Error("Send operations are disabled by the current runtime policy.");
  }
}

export function ensureEmailActionAllowed(
  runtime: ProtonRuntimeConfig,
  action: EmailAction,
): void {
  ensureMailboxWriteAllowed(runtime);

  if (!runtime.allowedActions.includes(action)) {
    throw new Error(`Mailbox action ${action} is disabled by the current runtime policy.`);
  }
}

export function resolveRemoteDraftSync(
  runtime: ProtonRuntimeConfig,
  requested: boolean,
): {
  enabled: boolean;
  reason?: string;
} {
  if (!requested) {
    return { enabled: false };
  }

  if (runtime.readOnly) {
    return {
      enabled: false,
      reason: "Remote draft sync is disabled because the server is running in read-only mode.",
    };
  }

  if (!runtime.allowRemoteDraftSync) {
    return {
      enabled: false,
      reason: "Remote draft sync is disabled by the current runtime policy.",
    };
  }

  return { enabled: true };
}

export function ensureRemoteDraftSyncAllowed(runtime: ProtonRuntimeConfig): void {
  const decision = resolveRemoteDraftSync(runtime, true);
  if (!decision.enabled) {
    throw new Error(decision.reason || "Remote draft sync is disabled by the current runtime policy.");
  }
}

export function ensureMailboxWriteAllowed(runtime: ProtonRuntimeConfig): void {
  if (runtime.readOnly) {
    throw new Error("Mailbox write operations are disabled because the server is running in read-only mode.");
  }
}
