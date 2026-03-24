import { rm } from "node:fs/promises";
import { join } from "node:path";
import { buildConfigFromEnv, createServer } from "../index.js";
import type { EmailAddress, EmailDetail, ThreadDetail } from "../types/index.js";

function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const address of addresses) {
    const normalized = address.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(address.trim());
  }

  return result;
}

function addressValues(addresses: EmailAddress[]): string[] {
  return uniqueAddresses(
    addresses
      .map((value) => value.address?.trim())
      .filter((value): value is string => Boolean(value)),
  );
}

function formatAddressList(addresses: EmailAddress[]): string {
  return addresses
    .map((value) => {
      if (value.name && value.address) {
        return `${value.name} <${value.address}>`;
      }
      return value.address || value.name || "";
    })
    .filter(Boolean)
    .join(", ");
}

function quotePlainText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function prefixedSubject(subject: string, prefix: "Re:" | "Fwd:"): string {
  const trimmed = subject.trim();
  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    return trimmed;
  }
  return `${prefix} ${trimmed}`;
}

function buildReplyText(detail: EmailDetail, body: string): string {
  const originalText = detail.text || detail.preview || "";
  const fromText = formatAddressList(detail.from);
  const dateText = detail.date || detail.internalDate || "an unknown date";

  return [
    body.trim(),
    "",
    `On ${dateText}, ${fromText || "the sender"} wrote:`,
    quotePlainText(originalText),
  ].join("\n");
}

function buildForwardText(detail: EmailDetail, body: string): string {
  const originalText = detail.text || detail.preview || "";

  return [
    body.trim(),
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
  const owner = ownerEmail.trim().toLowerCase();
  const primary = addressValues(detail.replyTo).length > 0 ? detail.replyTo : detail.from;
  const to = uniqueAddresses(
    addressValues(primary).filter((address) => address.trim().toLowerCase() !== owner),
  );

  if (!replyAll) {
    return { to, cc: [] };
  }

  const ccPool = uniqueAddresses([...addressValues(detail.to), ...addressValues(detail.cc)]).filter(
    (address) => {
      const normalized = address.trim().toLowerCase();
      return normalized !== owner && !to.some((recipient) => recipient.trim().toLowerCase() === normalized);
    },
  );

  return { to, cc: ccPool };
}

function pickReplyTargetFromThread(
  thread: ThreadDetail,
  ownerEmail: string,
  preferLatestInbound: boolean,
) {
  const messages = [...thread.messages];
  const owner = ownerEmail.trim().toLowerCase();

  if (preferLatestInbound) {
    const inbound = [...messages]
      .reverse()
      .find(
        (message) =>
          !message.from.some((address) => address.address?.trim().toLowerCase() === owner),
      );
    if (inbound) {
      return inbound;
    }
  }

  return messages[messages.length - 1];
}

async function main(): Promise<void> {
  const config = buildConfigFromEnv();
  const { smtpService, imapService, draftStore, localIndexService } = createServer(config, {
    startBackgroundSync: false,
  });
  const selfTo = process.env.PROTONMAIL_SMOKE_SELF_TO || config.smtp.username;
  const forwardTo = process.env.PROTONMAIL_SMOKE_FORWARD_TO || selfTo;
  const allowMutations = process.env.PROTONMAIL_SMOKE_ALLOW_MUTATIONS === "true";
  const mutationEmailId = process.env.PROTONMAIL_SMOKE_MUTATION_EMAIL_ID;
  const unique = new Date().toISOString().replace(/[:.]/g, "-");

  try {
    await Promise.all([smtpService.verifyConnection(), imapService.ping()]);
    const recentInbox = await imapService.getEmails({ folder: "INBOX", limit: 20, offset: 0 });
    const replyTargetSummary = recentInbox.emails.find((email) =>
      !addressValues(email.from).some(
        (address) => address.trim().toLowerCase() === config.smtp.username.trim().toLowerCase(),
      ),
    );

    if (!replyTargetSummary) {
      throw new Error("Unable to find a recent inbound email for reply draft coverage");
    }

    const snapshot = await imapService.collectEmailsForIndex({
      folder: "INBOX",
      limitPerFolder: 100,
      includeAttachmentText: true,
    });
    const indexStatus = await localIndexService.recordSnapshot({
      folders: snapshot.folders,
      emails: snapshot.emails,
      syncedAt: snapshot.syncedAt,
      folderStats: snapshot.folderStats,
    });
    const incrementalSnapshot = await imapService.collectEmailsForIndex({
      folder: "INBOX",
      limitPerFolder: 100,
      includeAttachmentText: true,
      checkpoints: await localIndexService.getSyncCheckpointMap(),
    });
    const incrementalIndexStatus = await localIndexService.recordSnapshot({
      folders: incrementalSnapshot.folders,
      emails: incrementalSnapshot.emails,
      syncedAt: incrementalSnapshot.syncedAt,
      folderStats: incrementalSnapshot.folderStats,
    });
    const incrementalStrategies = incrementalSnapshot.folderStats.map((folder) => folder.strategy);
    if (
      incrementalStrategies.some(
        (strategy) => strategy !== "incremental" && strategy !== "incremental_window",
      )
    ) {
      throw new Error(
        `Expected incremental second-pass sync strategies, received: ${incrementalStrategies.join(", ")}`,
      );
    }

    const indexIntegrity = await localIndexService.runIntegrityCheck();
    if (!indexIntegrity.ok) {
      throw new Error(`SQLite integrity check failed: ${indexIntegrity.integrity}`);
    }

    const inboxDigest = await localIndexService.getInboxDigest({
      limit: 5,
      minAgeHours: 24,
    });
    const followUpCandidates = await localIndexService.getFollowUpCandidates({
      limit: 5,
      minAgeHours: 24,
      pendingOn: "any",
    });
    const idleProbe = await imapService.waitForMailboxChanges({
      folder: "INBOX",
      timeoutMs: 3_000,
    });
    const attachmentTextHits = incrementalSnapshot.emails.filter((email) =>
      Boolean(email.attachmentText?.trim()),
    ).length;

    const actionableThreads = await localIndexService.getActionableThreads({
      limit: 100,
      unreadOnly: false,
    });
    const replyActionableThread = actionableThreads.threads.find((thread) =>
      thread.messageIds.includes(replyTargetSummary.id),
    );
    const indexedThreads = await localIndexService.getThreads({ limit: 250 });
    const replyThreadSummary = replyActionableThread ??
      indexedThreads.threads.find((thread) => thread.messageIds.includes(replyTargetSummary.id));
    if (!replyThreadSummary) {
      throw new Error("Unable to resolve indexed thread coverage for the reply target");
    }

    const replyThread = await localIndexService.getThreadById(replyThreadSummary.id);
    const replyTargetMessage = pickReplyTargetFromThread(replyThread, config.smtp.username, true);
    if (!replyTargetMessage?.primaryEmailId) {
      throw new Error("Actionable thread reply target did not produce a primaryEmailId");
    }

    const replyTarget = await imapService.getEmailById(replyTargetMessage.primaryEmailId);
    const replyRecipients = getReplyRecipients(replyTarget, config.smtp.username, false);
    if (replyRecipients.to.length === 0) {
      throw new Error("Reply draft target did not produce a recipient");
    }

    const replyDraft = await draftStore.createDraft({
      mode: "reply",
      to: replyRecipients.to,
      cc: replyRecipients.cc,
      subject: prefixedSubject(replyTarget.subject, "Re:"),
      body: buildReplyText(replyTarget, "Reply smoke check."),
      isHtml: false,
      inReplyTo: replyTarget.messageId,
      references: replyTarget.messageId ? [replyTarget.messageId] : undefined,
      sourceEmailId: replyTarget.id,
      sourceMessageId: replyTarget.messageId,
      notes: "Created by bridge smoke test",
    });

    const updatedReplyDraft = await draftStore.updateDraft(replyDraft.id, {
      notes: "Updated by bridge smoke test",
    });
    const replyRaw = await smtpService.buildRawMessage({
      to: updatedReplyDraft.to,
      cc: updatedReplyDraft.cc,
      bcc: updatedReplyDraft.bcc,
      subject: updatedReplyDraft.subject,
      body: updatedReplyDraft.body,
      isHtml: updatedReplyDraft.isHtml,
      priority: updatedReplyDraft.priority,
      replyTo: updatedReplyDraft.replyTo,
      inReplyTo: updatedReplyDraft.inReplyTo,
      references: updatedReplyDraft.references,
      messageId: updatedReplyDraft.draftMessageId,
      attachments: updatedReplyDraft.attachments,
    });
    const replyRemoteDraft = await imapService.upsertRemoteDraft({
      raw: replyRaw,
      messageId: updatedReplyDraft.draftMessageId,
    });
    const syncedReplyDraft = await draftStore.markRemoteSynced(updatedReplyDraft.id, replyRemoteDraft);

    const composeDraft = await draftStore.createDraft({
      mode: "compose",
      to: [selfTo],
      subject: `ProtonMail MCP draft smoke ${unique}`,
      body: `Compose draft smoke at ${new Date().toISOString()}.`,
      isHtml: false,
      notes: "Sendable compose draft for smoke coverage",
    });
    const composeRaw = await smtpService.buildRawMessage({
      to: composeDraft.to,
      cc: composeDraft.cc,
      bcc: composeDraft.bcc,
      subject: composeDraft.subject,
      body: composeDraft.body,
      isHtml: composeDraft.isHtml,
      priority: composeDraft.priority,
      replyTo: composeDraft.replyTo,
      inReplyTo: composeDraft.inReplyTo,
      references: composeDraft.references,
      messageId: composeDraft.draftMessageId,
      attachments: composeDraft.attachments,
    });
    const composeRemoteDraft = await imapService.upsertRemoteDraft({
      raw: composeRaw,
      messageId: composeDraft.draftMessageId,
    });
    const syncedComposeDraft = await draftStore.markRemoteSynced(composeDraft.id, composeRemoteDraft);

    const composeSend = await smtpService.sendEmail({
      to: syncedComposeDraft.to,
      cc: syncedComposeDraft.cc,
      bcc: syncedComposeDraft.bcc,
      subject: syncedComposeDraft.subject,
      body: syncedComposeDraft.body,
      isHtml: syncedComposeDraft.isHtml,
      inReplyTo: syncedComposeDraft.inReplyTo,
      references: syncedComposeDraft.references,
      attachments: syncedComposeDraft.attachments,
    });

    let sentComposeDraft = await draftStore.markSent(syncedComposeDraft.id, {
      messageId: composeSend.messageId,
      accepted: composeSend.accepted,
      rejected: composeSend.rejected,
      response: composeSend.response,
    });
    if (sentComposeDraft.remoteDraft?.emailId) {
      await imapService.deleteRemoteDraft(sentComposeDraft.remoteDraft.emailId);
      sentComposeDraft = await draftStore.clearRemoteSync(sentComposeDraft.id);
    }

    const forwardSend = await smtpService.sendEmail({
      to: [forwardTo],
      subject: prefixedSubject(replyTarget.subject, "Fwd:"),
      body: buildForwardText(replyTarget, "Forward smoke check."),
      isHtml: false,
    });

    const replyThreadEmailIds = [...new Set(replyThread.messages.map((message) => message.primaryEmailId))];
    for (const emailId of replyThreadEmailIds) {
      await imapService.starEmail(emailId, true);
    }
    for (const emailId of replyThreadEmailIds) {
      await imapService.starEmail(emailId, false);
    }

    if (syncedReplyDraft.remoteDraft?.emailId) {
      await imapService.deleteRemoteDraft(syncedReplyDraft.remoteDraft.emailId);
      await draftStore.clearRemoteSync(syncedReplyDraft.id);
    }

    const attachmentSample = await imapService.searchEmails({ hasAttachment: true, limit: 10 });
    let attachmentBatch:
      | {
          emailId: string;
          savedCount: number;
        }
      | undefined;

    if (attachmentSample.emails.length > 0) {
      const attachmentOutputPath = join(config.dataDir, "smoke-attachments");
      const savedAttachments = await imapService.saveAttachments({
        emailId: attachmentSample.emails[0].id,
        outputPath: attachmentOutputPath,
        includeInline: true,
      });
      attachmentBatch = {
        emailId: savedAttachments.emailId,
        savedCount: savedAttachments.saved.length,
      };
      await rm(attachmentOutputPath, { recursive: true, force: true });
    }

    const deletedReplyDraft = await draftStore.deleteDraft(syncedReplyDraft.id);
    const deletedComposeDraft = await draftStore.deleteDraft(sentComposeDraft.id);
    const remoteDrafts = await imapService.listRemoteDrafts(10, 0);

    let archiveResult:
      | Awaited<ReturnType<typeof imapService.archiveEmail>>
      | undefined;
    let restoreAfterArchive:
      | Awaited<ReturnType<typeof imapService.restoreEmail>>
      | undefined;
    let trashResult:
      | Awaited<ReturnType<typeof imapService.trashEmail>>
      | undefined;
    let restoreAfterTrash:
      | Awaited<ReturnType<typeof imapService.restoreEmail>>
      | undefined;

    if (allowMutations && mutationEmailId) {
      archiveResult = await imapService.archiveEmail(mutationEmailId);
      if (!archiveResult.targetEmailId) {
        throw new Error("Archive step did not return a targetEmailId");
      }

      restoreAfterArchive = await imapService.restoreEmail(archiveResult.targetEmailId, "INBOX");
      if (!restoreAfterArchive.targetEmailId) {
        throw new Error("Restore-after-archive step did not return a targetEmailId");
      }

      trashResult = await imapService.trashEmail(restoreAfterArchive.targetEmailId);
      if (!trashResult.targetEmailId) {
        throw new Error("Trash step did not return a targetEmailId");
      }

      restoreAfterTrash = await imapService.restoreEmail(trashResult.targetEmailId, "INBOX");
      if (!restoreAfterTrash.targetEmailId) {
        throw new Error("Restore-after-trash step did not return a targetEmailId");
      }
    }

    console.log(
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          index: {
            firstSyncAt: indexStatus.updatedAt,
            updatedAt: incrementalIndexStatus.updatedAt,
            storedMessageCount: incrementalIndexStatus.storedMessageCount,
            dedupedMessageCount: incrementalIndexStatus.dedupedMessageCount,
            threadCount: incrementalIndexStatus.threadCount,
            actionableThreadCount: actionableThreads.total,
          },
          sync: {
            firstPass: snapshot.folderStats,
            secondPass: incrementalSnapshot.folderStats,
            attachmentTextHits,
          },
          diagnostics: {
            integrity: indexIntegrity,
            idleProbe,
            digest: {
              counts:
                typeof inboxDigest.counts === "object" && inboxDigest.counts
                  ? inboxDigest.counts
                  : {},
              topThreadCount: Array.isArray(inboxDigest.topThreads) ? inboxDigest.topThreads.length : 0,
              staleAwaitingYouCount: Array.isArray(inboxDigest.staleAwaitingYou)
                ? inboxDigest.staleAwaitingYou.length
                : 0,
            },
            followUps: {
              total:
                typeof followUpCandidates.total === "number" ? followUpCandidates.total : 0,
              returned: Array.isArray(followUpCandidates.threads)
                ? followUpCandidates.threads.length
                : 0,
            },
          },
          actionableThread: {
            matchedActionableThread: Boolean(replyActionableThread),
            threadId: replyThread.id,
            pendingOn: replyActionableThread?.pendingOn ?? "unknown",
            score: replyActionableThread?.score ?? null,
            latestEmailId: replyActionableThread?.latestEmailId ?? null,
          },
          replyDraft: {
            threadId: replyThread.id,
            targetEmailId: replyTarget.id,
            createdDraftId: replyDraft.id,
            remoteDraftEmailId: replyRemoteDraft.emailId,
            deletedDraft: deletedReplyDraft.removed,
          },
          composeDraft: {
            createdDraftId: composeDraft.id,
            remoteDraftEmailId: composeRemoteDraft.emailId,
            sentMessageId: composeSend.messageId,
            deletedDraft: deletedComposeDraft.removed,
          },
          forward: {
            to: forwardTo,
            sourceEmailId: replyTarget.id,
            messageId: forwardSend.messageId,
          },
          threadActions: {
            threadId: replyThread.id,
            starredThenUnstarred: replyThreadEmailIds.length,
          },
          remoteDrafts: {
            listed: remoteDrafts.emails.length,
          },
          attachments: attachmentBatch || { skipped: true },
          mutations: allowMutations && mutationEmailId
            ? {
                archiveTarget: archiveResult?.targetEmailId,
                restoreAfterArchive: restoreAfterArchive?.targetEmailId,
                trashTarget: trashResult?.targetEmailId,
                restoreAfterTrash: restoreAfterTrash?.targetEmailId,
              }
            : allowMutations
              ? {
                  skipped: true,
                  reason: "PROTONMAIL_SMOKE_MUTATION_EMAIL_ID not set",
                }
            : {
                skipped: true,
              },
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.allSettled([imapService.disconnect(), smtpService.close()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
