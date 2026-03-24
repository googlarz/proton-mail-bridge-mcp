import type { MessageAddressObject, MessageStructureObject } from "imapflow";
import type {
  EmailAddress,
  EmailAttachmentSummary,
  EmailSummary,
  SearchEmailsInput,
} from "../types/index.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_ID_SEPARATOR = "::";

export function parseEmails(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

export function ensureValidEmails(emails: string[], fieldName: string): void {
  const invalid = emails.filter((email) => !isValidEmail(email));
  if (invalid.length > 0) {
    throw new Error(`Invalid ${fieldName} email address(es): ${invalid.join(", ")}`);
  }
}

export function createEmailId(folder: string, uid: number): string {
  return `${encodeURIComponent(folder)}${EMAIL_ID_SEPARATOR}${uid}`;
}

export function parseEmailId(emailId: string): { folder: string; uid: number } {
  const index = emailId.lastIndexOf(EMAIL_ID_SEPARATOR);
  if (index === -1) {
    throw new Error(
      "Invalid emailId. Expected the email identifier returned by get_emails or search_emails.",
    );
  }

  const folder = decodeURIComponent(emailId.slice(0, index));
  const uid = Number(emailId.slice(index + EMAIL_ID_SEPARATOR.length));

  if (!folder || !Number.isInteger(uid) || uid <= 0) {
    throw new Error(
      "Invalid emailId. Expected the email identifier returned by get_emails or search_emails.",
    );
  }

  return { folder, uid };
}

export function mapEnvelopeAddresses(addresses?: MessageAddressObject[]): EmailAddress[] {
  return (addresses ?? []).map((address) => ({
    name: address.name,
    address: address.address,
  }));
}

export function mapParsedAddresses(
  addresses?: { value?: Array<{ name?: string; address?: string }> } | null,
): EmailAddress[] {
  return (addresses?.value ?? []).map((address) => ({
    name: address.name,
    address: address.address,
  }));
}

export function previewText(value?: string, maxLength = 220): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}

export function stripHtmlToText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const withoutTags = value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");

  return previewText(withoutTags, 10_000);
}

export function extractMessageIdList(value?: string | string[]): string[] {
  if (!value) {
    return [];
  }

  const raw = Array.isArray(value) ? value.join(" ") : value;
  const matches = raw.match(/<[^>]+>/g) ?? [];
  const normalized = matches
    .map((entry) => normalizeMessageId(entry))
    .filter((entry): entry is string => Boolean(entry));

  return [...new Set(normalized)];
}

export function extractAttachments(
  structure?: MessageStructureObject,
): EmailAttachmentSummary[] {
  if (!structure) {
    return [];
  }

  const attachments: EmailAttachmentSummary[] = [];

  const visit = (node: MessageStructureObject): void => {
    const filename =
      node.dispositionParameters?.filename ??
      node.parameters?.name ??
      node.parameters?.filename;
    const disposition = node.disposition?.toLowerCase();
    const looksLikeAttachment =
      disposition === "attachment" || (disposition === "inline" && Boolean(filename));

    if (looksLikeAttachment || filename) {
      attachments.push({
        id: node.part,
        filename,
        contentType: node.type,
        size: node.size,
        disposition: node.disposition,
        part: node.part,
        cid: node.id,
        isInline: disposition === "inline",
      });
    }

    for (const child of node.childNodes ?? []) {
      visit(child);
    }
  };

  visit(structure);
  return attachments;
}

export function dedupeEmails(emails: EmailSummary[]): EmailSummary[] {
  const seen = new Set<string>();
  const result: EmailSummary[] = [];

  for (const email of emails) {
    const dedupeKey = email.messageId || email.id;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    result.push(email);
  }

  return result;
}

export function sortEmailsByNewest<T extends Pick<EmailSummary, "date" | "internalDate" | "uid">>(
  emails: T[],
): T[] {
  return [...emails].sort((left, right) => {
    const leftTime = new Date(left.internalDate || left.date || 0).getTime();
    const rightTime = new Date(right.internalDate || right.date || 0).getTime();

    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }

    return right.uid - left.uid;
  });
}

export function normalizeLimit(
  value: unknown,
  defaultValue: number,
  min = 1,
  max = 250,
): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return defaultValue;
  }

  const rounded = Math.trunc(value);
  if (rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}

export function normalizeBoolean(value: unknown, defaultValue: boolean): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

export function parseDateInput(value?: string): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${value}`);
  }

  return date;
}

export function nextDay(date: Date): Date {
  return new Date(date.getTime() + 24 * 60 * 60 * 1000);
}

export function matchesLocalSearchFilters(
  email: EmailSummary,
  filters: SearchEmailsInput,
): boolean {
  if (typeof filters.hasAttachment === "boolean" && email.hasAttachments !== filters.hasAttachment) {
    return false;
  }

  if (filters.threadId && email.threadId !== filters.threadId) {
    return false;
  }

  if (filters.label) {
    const labelNeedle = filters.label.toLowerCase();
    const folderMatch = email.folder.toLowerCase() === labelNeedle;
    const labelMatch = email.labels.some((label) => label.toLowerCase() === labelNeedle);
    if (!folderMatch && !labelMatch) {
      return false;
    }
  }

  if (filters.attachmentName) {
    const attachmentNeedle = filters.attachmentName.toLowerCase();
    const match = email.attachments.some((attachment) =>
      (attachment.filename || "").toLowerCase().includes(attachmentNeedle),
    );
    if (!match) {
      return false;
    }
  }

  return true;
}

export function stringifyForJson(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value), null, 2);
}

export function normalizeJsonValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item));
  }

  if (value instanceof Set) {
    return [...value].map((item) => normalizeJsonValue(item));
  }

  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, mapValue]) => [String(key), normalizeJsonValue(mapValue)]),
    );
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, objectValue]) => {
        const normalized = normalizeJsonValue(objectValue);
        return normalized === undefined ? [] : [[key, normalized]];
      }),
    );
  }

  return String(value);
}

export function lowerCaseAddress(value?: string): string | undefined {
  return value?.trim().toLowerCase();
}

export function normalizeMessageId(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\s+/g, "").toLowerCase();
}

export function extractDomain(address: string): string | undefined {
  const parts = address.split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : undefined;
}

export function normalizeSubjectForThread(subject: string): string {
  const collapsed = subject.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "(no subject)";
  }

  return collapsed.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "").trim() || "(no subject)";
}

export function sanitizeFileName(filename?: string, fallback = "attachment"): string {
  const normalized = (filename || fallback).replace(/[\\/:*?"<>|]+/g, "_").trim();
  return normalized || fallback;
}

export function isTextLikeMimeType(mimeType?: string): boolean {
  if (!mimeType) {
    return false;
  }

  const normalized = mimeType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("csv")
  );
}
