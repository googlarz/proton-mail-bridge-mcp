import type { LogEntry } from "../types/index.js";

type LogLevel = LogEntry["level"];

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeData(data: unknown): unknown {
  if (data instanceof Error) {
    return {
      name: data.name,
      message: data.message,
      stack: data.stack,
    };
  }

  if (Array.isArray(data)) {
    return data.map((value) => normalizeData(value));
  }

  if (data instanceof Set) {
    return [...data].map((value) => normalizeData(value));
  }

  if (data instanceof Map) {
    return Object.fromEntries(
      [...data.entries()].map(([key, value]) => [String(key), normalizeData(value)]),
    );
  }

  if (typeof data === "bigint") {
    return data.toString();
  }

  if (data && typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, normalizeData(value)]),
    );
  }

  return data;
}

export class Logger {
  private readonly entries: LogEntry[] = [];
  private debugMode = false;
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  debug(message: string, context?: string, data?: unknown): void {
    this.log("debug", message, context, data);
  }

  info(message: string, context?: string, data?: unknown): void {
    this.log("info", message, context, data);
  }

  warn(message: string, context?: string, data?: unknown): void {
    this.log("warn", message, context, data);
  }

  error(message: string, context?: string, data?: unknown): void {
    this.log("error", message, context, data);
  }

  getLogs(options?: { level?: LogLevel; limit?: number }): LogEntry[] {
    const levelThreshold = options?.level ? LEVEL_ORDER[options.level] : 0;
    const limit = options?.limit ?? 100;

    return this.entries
      .filter((entry) => LEVEL_ORDER[entry.level] >= levelThreshold)
      .slice(-limit);
  }

  clear(): void {
    this.entries.length = 0;
  }

  private log(level: LogLevel, message: string, context?: string, data?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      context,
      message,
      data: normalizeData(data),
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    if (level === "debug" && !this.debugMode) {
      return;
    }

    const parts = [entry.timestamp, level.toUpperCase()];
    if (context) {
      parts.push(`[${context}]`);
    }
    parts.push(message);

    if (entry.data !== undefined) {
      parts.push(JSON.stringify(entry.data));
    }

    process.stderr.write(`${parts.join(" ")}\n`);
  }
}

export const logger = new Logger();
