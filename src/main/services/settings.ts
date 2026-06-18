import { app } from 'electron';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CHAIN_ID,
  DEFAULT_GAS_PRICE_UDVPN,
  DEFAULT_RPC_POOL,
} from './chain';
import { log } from './logger';
import type { AppSettings } from '../../shared/types';

let cache: AppSettings | null = null;

const emitter = new EventEmitter();

/**
 * Subscribe to settings changes. Fires after `updateSettings` writes the
 * new settings to disk so pollers can react (e.g. re-arm at the new
 * cadence). Returns an unsubscribe function.
 */
export function onSettingsChanged(handler: (next: AppSettings) => void): () => void {
  emitter.on('changed', handler);
  return () => emitter.off('changed', handler);
}

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function defaults(): AppSettings {
  return {
    rpcUrls: [...DEFAULT_RPC_POOL],
    chainId: DEFAULT_CHAIN_ID,
    gasPriceUdvpn: DEFAULT_GAS_PRICE_UDVPN,
    dockerSocket: '',
    seenOnboarding: false,
    minimizeToTrayOnClose: true,
    stopNodesOnQuit: false,
    trayHintShown: false,
    stopCliServerOnQuit: true,
    walletRefreshIntervalSec: 60,
    nodeRefreshIntervalSec: 60,
  };
}

const WALLET_REFRESH_MIN_SEC = 10;
const WALLET_REFRESH_MAX_SEC = 600;
const NODE_REFRESH_MIN_SEC = 15;
const NODE_REFRESH_MAX_SEC = 600;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export async function getSettings(): Promise<AppSettings> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(file(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    cache = { ...defaults(), ...parsed };
    // Normalize: strip empty strings from rpc pool, drop any non-https
    // entries (and any non-loopback http) — defence against a hand-edited
    // settings.json. isValidRpcUrl is defined later but lifted here at runtime.
    cache.rpcUrls = cache.rpcUrls
      .filter((u) => u && u.trim())
      .map((u) => u.trim())
      .filter(isValidRpcUrl);
    if (cache.rpcUrls.length === 0) cache.rpcUrls = [...DEFAULT_RPC_POOL];
    cache.walletRefreshIntervalSec = clampInt(
      cache.walletRefreshIntervalSec,
      WALLET_REFRESH_MIN_SEC,
      WALLET_REFRESH_MAX_SEC,
      defaults().walletRefreshIntervalSec,
    );
    cache.nodeRefreshIntervalSec = clampInt(
      cache.nodeRefreshIntervalSec,
      NODE_REFRESH_MIN_SEC,
      NODE_REFRESH_MAX_SEC,
      defaults().nodeRefreshIntervalSec,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      log.info('settings.json absent — using defaults');
    } else {
      // Corrupt or unreadable settings would otherwise silently revert to
      // defaults and then be overwritten on the next updateSettings call.
      log.error('settings.json unreadable — falling back to defaults', {
        code: code ?? null,
        err: String(err),
      });
    }
    cache = defaults();
  }
  return cache;
}

// Allowed top-level setting keys. Anything not in this set is dropped
// before merging — protects against prototype pollution (`__proto__`,
// `constructor`, `prototype`) and stray fields from a JSON.parse path.
const ALLOWED_SETTINGS_KEYS: ReadonlySet<keyof AppSettings> = new Set([
  'rpcUrls',
  'chainId',
  'gasPriceUdvpn',
  'dockerSocket',
  'seenOnboarding',
  'minimizeToTrayOnClose',
  'stopNodesOnQuit',
  'trayHintShown',
  'stopCliServerOnQuit',
  'walletRefreshIntervalSec',
  'nodeRefreshIntervalSec',
]);

function sanitizeSettingsPatch(raw: Partial<AppSettings>): Partial<AppSettings> {
  const out: Partial<AppSettings> = {};
  for (const k of Object.keys(raw) as Array<keyof AppSettings>) {
    if (ALLOWED_SETTINGS_KEYS.has(k)) {
      // assignment is type-safe per the key constraint above
      (out as Record<string, unknown>)[k] = (raw as Record<string, unknown>)[k];
    }
  }
  return out;
}

function isValidRpcUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  // http:// is allowed only for loopback — never for arbitrary hosts. Plaintext
  // RPC over the open network leaks signed TXs and account-info queries.
  if (parsed.protocol === 'http:') {
    const h = parsed.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  }
  return false;
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const safe = sanitizeSettingsPatch(patch);
  const next: AppSettings = { ...current, ...safe };
  if (safe.rpcUrls) {
    next.rpcUrls = safe.rpcUrls
      .filter((u) => u && u.trim())
      .map((u) => u.trim())
      .filter(isValidRpcUrl);
    if (next.rpcUrls.length === 0) next.rpcUrls = [...DEFAULT_RPC_POOL];
  }
  if (safe.walletRefreshIntervalSec !== undefined) {
    next.walletRefreshIntervalSec = clampInt(
      safe.walletRefreshIntervalSec,
      WALLET_REFRESH_MIN_SEC,
      WALLET_REFRESH_MAX_SEC,
      current.walletRefreshIntervalSec,
    );
  }
  if (safe.nodeRefreshIntervalSec !== undefined) {
    next.nodeRefreshIntervalSec = clampInt(
      safe.nodeRefreshIntervalSec,
      NODE_REFRESH_MIN_SEC,
      NODE_REFRESH_MAX_SEC,
      current.nodeRefreshIntervalSec,
    );
  }
  cache = next;
  const target = file();
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Atomic write (mirrors store.ts): write to a sibling temp file then rename,
  // so a crash mid-write can't leave settings.json truncated → silent revert
  // to defaults on next launch.
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  emitter.emit('changed', next);
  return next;
}
