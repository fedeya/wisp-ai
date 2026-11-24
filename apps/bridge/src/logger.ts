import { Effect, Layer, Logger, ManagedRuntime, References } from 'effect';
import type * as LogLevel from 'effect/LogLevel';

/**
 * The bridge logs through Effect's Logger. Effect code logs with
 * `Effect.log*` and `Effect.annotateLogs({ event, ... })`; other code uses
 * `bridgeLogger`, which runs the same logger. Each entry is one JSON line on
 * stdout (the desktop app writes it to runtime/bridge.log):
 *
 *   {"level":"INFO","timestamp":"…","component":"bridge","event":"bridge.started",…,"msg":"Wisp started"}
 */

/** One logging call: structured fields and a message, or either alone. */
export type LogCall = (fieldsOrMessage: object | string, message?: string) => void;
/** The logging calls modules receive. */
export interface Logger {
  debug: LogCall;
  info: LogCall;
  warn: LogCall;
  error: LogCall;
  fatal: LogCall;
}

// Fields that never reach the log, at the top level or in headers.
const REDACTED = new Set(['authorization', 'apiKey', 'token', 'password']);

function redact(fields: Record<string, unknown>) {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED.has(key)) {
      continue;
    }
    if (key === 'headers' && value && typeof value === 'object' && !Array.isArray(value)) {
      const { authorization: _, ...headers } = value as Record<string, unknown>;
      kept[key] = headers;
      continue;
    }
    kept[key] = value;
  }
  return kept;
}

const LEVELS: Partial<Record<LogLevel.LogLevel, string>> = {
  Trace: 'TRACE',
  Debug: 'DEBUG',
  Info: 'INFO',
  Warn: 'WARN',
  Error: 'ERROR',
  Fatal: 'FATAL',
};

function serialize(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ ...(value as object), unserializable: true });
  }
}

/** One log entry as the JSON line the bridge writes. */
export function logLine(entry: {
  level: LogLevel.LogLevel;
  date: Date;
  annotations: Record<string, unknown>;
  message: unknown;
}) {
  const parts = Array.isArray(entry.message) ? entry.message : [entry.message];
  const message = parts
    .map((part) => (typeof part === 'string' ? part : serialize(part)))
    .join(' ');
  return serialize({
    level: LEVELS[entry.level] ?? entry.level.toUpperCase(),
    timestamp: entry.date.toISOString(),
    component: 'bridge',
    ...redact(entry.annotations),
    msg: message,
  });
}

/** Writes each entry to stdout as a JSON line. */
export const jsonLineLogger = Logger.make((options) => {
  process.stdout.write(
    logLine({
      level: options.logLevel,
      date: options.date,
      annotations: options.fiber.getRef(References.CurrentLogAnnotations),
      message: options.message,
    }) + '\n',
  );
});

/** Replaces Effect's default console logger with the bridge's JSON lines. */
export const LoggerLive = Logger.layer([jsonLineLogger]);

/** The bridge's Effect runtime: Effect programs run here, with the bridge logger. */
export const bridgeRuntime = ManagedRuntime.make(Layer.mergeAll(LoggerLive));

function logWith(log: (message: string) => Effect.Effect<void>): LogCall {
  return (fieldsOrMessage, message) => {
    const fields = typeof fieldsOrMessage === 'string' ? {} : fieldsOrMessage;
    const text = typeof fieldsOrMessage === 'string' ? fieldsOrMessage : (message ?? '');
    bridgeRuntime.runSync(log(text).pipe(Effect.annotateLogs(fields as Record<string, unknown>)));
  };
}

export const bridgeLogger: Logger = {
  debug: logWith(Effect.logDebug),
  info: logWith(Effect.logInfo),
  warn: logWith(Effect.logWarning),
  error: logWith(Effect.logError),
  fatal: logWith(Effect.logFatal),
};
