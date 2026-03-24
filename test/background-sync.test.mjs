import test from "node:test";
import assert from "node:assert/strict";
import { BackgroundSyncService } from "../dist/services/background-sync-service.js";

function createConfig() {
  return {
    smtp: {
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      username: "owner@example.com",
      password: "secret",
    },
    imap: {
      host: "127.0.0.1",
      port: 1143,
      secure: false,
      username: "owner@example.com",
      password: "secret",
    },
    dataDir: "/tmp/protonmail-pro-mcp-test",
    debug: false,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync: true,
    syncInterval: 5,
    runtime: {
      readOnly: false,
      allowSend: true,
      allowRemoteDraftSync: true,
      allowedActions: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore"],
      startupSync: false,
      autoSyncFolder: "INBOX",
      autoSyncFull: false,
      autoSyncLimitPerFolder: 25,
      idleWatchEnabled: false,
      idleMaxSeconds: 30,
    },
  };
}

test("background sync records success and schedules the next run", async () => {
  const imapService = {
    calls: [],
    async collectEmailsForIndex(input) {
      this.calls.push(input);
      return {
        syncedAt: "2026-03-24T12:00:00.000Z",
        full: false,
        folders: [],
        folderStats: [{ folder: "INBOX", fetched: 0, total: 0 }],
        emails: [],
      };
    },
    async waitForMailboxChanges() {
      return {
        folder: "INBOX",
        timeoutMs: 1000,
        checkedAt: "2026-03-24T12:00:01.000Z",
        changed: false,
        events: [],
      };
    },
  };
  const localIndexService = {
    snapshots: [],
    async getSyncCheckpointMap() {
      return {};
    },
    async recordSnapshot(snapshot) {
      this.snapshots.push(snapshot);
      return {
        path: "/tmp/mail-index.json",
        staleThresholdMinutes: 60,
        isStale: false,
        folderCount: 0,
        labelCount: 0,
        threadCount: 0,
        storedMessageCount: 0,
        dedupedMessageCount: 0,
        syncCheckpoints: [],
        folders: [],
        updatedAt: snapshot.syncedAt,
      };
    },
  };

  const service = new BackgroundSyncService(createConfig(), imapService, localIndexService);
  service.start();

  try {
    const status = await service.runNow("unit-test");
    assert.equal(imapService.calls.length, 1);
    assert.equal(localIndexService.snapshots.length, 1);
    assert.equal(status.lastSuccessAt, "2026-03-24T12:00:00.000Z");
    assert.equal(status.folder, "INBOX");
    assert.equal(status.limitPerFolder, 25);
    assert.equal(status.idleEnabled, false);
    assert.ok(status.nextRunAt);
  } finally {
    service.stop();
  }
});
