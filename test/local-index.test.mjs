import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndexService } from "../dist/services/local-index-service.js";

function createConfig(dataDir) {
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
    dataDir,
    debug: false,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync: false,
    syncInterval: 5,
    runtime: {
      readOnly: false,
      allowSend: true,
      allowRemoteDraftSync: true,
      allowedActions: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore"],
      startupSync: false,
      autoSyncFolder: "INBOX",
      autoSyncFull: false,
      autoSyncLimitPerFolder: 100,
      idleWatchEnabled: true,
      idleMaxSeconds: 30,
    },
  };
}

test("local index groups replies by In-Reply-To even when subject changes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-index-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
      syncedAt: "2026-03-24T12:00:00.000Z",
      folders: [
        {
          path: "INBOX",
          name: "INBOX",
          delimiter: "/",
          specialUse: "\\Inbox",
          listed: true,
          subscribed: true,
          flags: [],
          messages: 2,
          unseen: 1,
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: 2, total: 2 }],
      emails: [
        {
          id: "INBOX::1",
          folder: "INBOX",
          uid: 1,
          seq: 1,
          messageId: "<root@example.com>",
          subject: "Quarterly update",
          from: [{ address: "alice@example.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-24T11:00:00.000Z",
          internalDate: "2026-03-24T11:00:00.000Z",
          isRead: false,
          isStarred: false,
          flags: [],
          preview: "Initial note",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
        {
          id: "INBOX::2",
          folder: "INBOX",
          uid: 2,
          seq: 2,
          messageId: "<reply@example.com>",
          inReplyTo: "<root@example.com>",
          subject: "Thanks",
          from: [{ address: "owner@example.com" }],
          to: [{ address: "alice@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-24T11:05:00.000Z",
          internalDate: "2026-03-24T11:05:00.000Z",
          isRead: true,
          isStarred: false,
          flags: ["\\Seen"],
          preview: "Thanks for the update",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
      ],
    });

    const threads = await service.getThreads({ limit: 10 });
    assert.equal(threads.total, 1);
    assert.equal(threads.threads[0].messageCount, 2);

    const detail = await service.getThreadById(threads.threads[0].id);
    assert.deepEqual(
      detail.messages.map((message) => message.primaryEmailId),
      ["INBOX::1", "INBOX::2"],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("local index groups siblings by References when the parent message is missing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-thread-ref-test-"));
  const service = new LocalIndexService(createConfig(dataDir));

  try {
    await service.recordSnapshot({
      syncedAt: "2026-03-24T12:00:00.000Z",
      folders: [
        {
          path: "INBOX",
          name: "INBOX",
          delimiter: "/",
          specialUse: "\\Inbox",
          listed: true,
          subscribed: true,
          flags: [],
          messages: 2,
          unseen: 2,
        },
      ],
      folderStats: [{ folder: "INBOX", fetched: 2, total: 2, strategy: "recent" }],
      emails: [
        {
          id: "INBOX::10",
          folder: "INBOX",
          uid: 10,
          seq: 10,
          messageId: "<child-a@example.com>",
          inReplyTo: "<missing-root@example.com>",
          references: ["<missing-root@example.com>"],
          subject: "Re: Project status",
          from: [{ address: "alice@example.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-24T11:00:00.000Z",
          internalDate: "2026-03-24T11:00:00.000Z",
          isRead: false,
          isStarred: false,
          flags: [],
          preview: "First reply",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
        {
          id: "INBOX::11",
          folder: "INBOX",
          uid: 11,
          seq: 11,
          messageId: "<child-b@example.com>",
          inReplyTo: "<missing-root@example.com>",
          references: ["<missing-root@example.com>"],
          subject: "Re: Project status",
          from: [{ address: "bob@example.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-24T11:05:00.000Z",
          internalDate: "2026-03-24T11:05:00.000Z",
          isRead: false,
          isStarred: false,
          flags: [],
          preview: "Second reply",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
      ],
    });

    const threads = await service.getThreads({ limit: 10 });
    assert.equal(threads.total, 1);
    assert.equal(threads.threads[0].messageCount, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("local index imports a legacy JSON snapshot into SQLite once", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-legacy-index-test-"));
  const legacyPath = join(dataDir, "mail-index.json");
  await writeFile(
    legacyPath,
    JSON.stringify({
      version: 1,
      ownerEmail: "owner@example.com",
      updatedAt: "2026-03-24T12:00:00.000Z",
      folders: [
        {
          path: "INBOX",
          name: "INBOX",
          delimiter: "/",
          specialUse: "\\Inbox",
          listed: true,
          subscribed: true,
          flags: [],
          messages: 1,
          unseen: 0,
        },
      ],
      indexedFolders: {
        INBOX: {
          path: "INBOX",
          messages: 1,
          unseen: 0,
          specialUse: "\\Inbox",
          lastIndexedAt: "2026-03-24T12:00:00.000Z",
          lastIndexedCount: 1,
        },
      },
      messages: {
        "INBOX::1": {
          id: "INBOX::1",
          folder: "INBOX",
          uid: 1,
          seq: 1,
          messageId: "<root@example.com>",
          subject: "Imported",
          from: [{ address: "alice@example.com" }],
          to: [{ address: "owner@example.com" }],
          cc: [],
          bcc: [],
          replyTo: [],
          date: "2026-03-24T11:00:00.000Z",
          internalDate: "2026-03-24T11:00:00.000Z",
          isRead: true,
          isStarred: false,
          flags: ["\\Seen"],
          preview: "Imported preview",
          hasAttachments: false,
          attachments: [],
          labels: [],
        },
      },
    }),
    "utf8",
  );

  const service = new LocalIndexService(createConfig(dataDir));

  try {
    const status = await service.getStatus();
    assert.equal(status.storedMessageCount, 1);

    const result = await service.search({ query: "Imported", limit: 10 });
    assert.equal(result.total, 1);
    assert.equal(result.emails[0].id, "INBOX::1");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
