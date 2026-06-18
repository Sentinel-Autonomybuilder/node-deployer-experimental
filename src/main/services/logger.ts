import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import winston from 'winston';

/**
 * File-based logger.
 *
 * Rolling file transport, 10 MB × 5 files under userData/logs/app.log.
 * Every service writes here via `log.info / log.warn / log.error`. On
 * startup we also pipe uncaught exceptions + unhandled rejections in.
 */

let _logger: winston.Logger | null = null;

export function logDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

function ensureDir(): void {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
  } catch (err) {
    // Cannot use `log` here — it would recurse through build()→ensureDir().
    // recursive:true makes EEXIST impossible, so any throw is a real problem
    // (EACCES, ENOSPC, read-only volume). Surface to stderr at least.
    // eslint-disable-next-line no-console
    console.error('[logger] could not create log dir', logDir(), String(err));
  }
}

// Redactor format: scrubs any field whose key matches a secret-name
// regex, replaces value with '[redacted]'. Walks plain objects only —
// anything more exotic (Buffer, Map, Date) is left alone.
const SECRET_KEY_RE = /(mnemonic|password|privateKey|private[_\-]?key|passphrase|seed|secret|token|backup)/i;
function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) out[k] = '[redacted]';
    else out[k] = redactDeep(v, depth + 1);
  }
  return out;
}
const redactFormat = winston.format((info) => {
  for (const k of Object.keys(info)) {
    if (k === 'level' || k === 'message' || k === 'timestamp' || k === 'stack') continue;
    (info as Record<string, unknown>)[k] = redactDeep((info as Record<string, unknown>)[k]);
  }
  return info;
});

function build(): winston.Logger {
  ensureDir();
  const fmt = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    redactFormat(),
    winston.format.printf((info) => {
      const level = info.level.padEnd(5);
      const meta = Object.keys(info).filter((k) => !['level', 'message', 'timestamp', 'stack'].includes(k));
      const metaStr = meta.length ? ' ' + JSON.stringify(Object.fromEntries(meta.map((k) => [k, (info as Record<string, unknown>)[k]]))) : '';
      const stack = info.stack ? '\n' + String(info.stack) : '';
      return `[${info.timestamp}] ${level} ${info.message}${metaStr}${stack}`;
    }),
  );
  const transports: winston.transport[] = [
    new winston.transports.File({
      filename: path.join(logDir(), 'app.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ];
  // Console transport only in dev. In packaged Electron stdout is detached
  // on Windows, so writes EPIPE → winston emits 'error' → uncaughtException
  // handler re-enters log.error → infinite recursion → process crash.
  if (!app.isPackaged) {
    transports.push(
      new winston.transports.Console({
        format: winston.format.combine(winston.format.colorize(), fmt),
      }),
    );
  }
  const log = winston.createLogger({
    level: process.env['SENTINEL_LOG_LEVEL'] ?? 'info',
    format: fmt,
    transports,
  });
  // Swallow transport errors so a broken sink can never crash the app.
  log.on('error', () => {
    /* never throw from the logger */
  });
  return log;
}

export const log = new Proxy({} as winston.Logger, {
  get(_t, key: keyof winston.Logger) {
    if (!_logger) _logger = build();
    return _logger[key];
  },
});

export function attachGlobalHandlers(): void {
  process.on('uncaughtException', (err) => {
    try {
      log.error('uncaughtException', { message: err.message, stack: err.stack });
    } catch {
      /* logger itself failed — never re-throw from a top-level handler */
    }
  });
  process.on('unhandledRejection', (reason) => {
    try {
      log.error('unhandledRejection', { reason: String(reason) });
    } catch {
      /* logger itself failed — never re-throw from a top-level handler */
    }
  });
}
