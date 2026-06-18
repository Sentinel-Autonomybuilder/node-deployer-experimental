import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from './logger';
import type { AppEvent, DeployedNode, WalletState } from '../../shared/types';

/**
 * Minimal on-disk JSON store.
 *
 * Secrets policy:
 *   - App wallet mnemonic lives at userData/wallet.secret, encrypted by
 *     Electron safeStorage (OS keychain).
 *   - Per-node operator mnemonics live on the node itself (in its own
 *     keyring). If the user opts to back one up in the app, it ends up in
 *     store.nodeBackups, also encrypted by safeStorage.
 *   - SSH credentials are never persisted.
 *
 * Everything else is fine to keep in plain JSON.
 */

interface StoreShape {
  wallet: WalletState | null;
  nodes: DeployedNode[];
  events: AppEvent[];
  logs: Record<string, string[]>;
  /** Base64-encoded safeStorage blobs keyed by node id. Nullable by design. */
  nodeBackups: Record<string, string | undefined>;
  /** SSH creds for remote nodes, held in-memory only at runtime; this field
   *  is always serialized as an empty object. */
  sshKeyring?: Record<string, never>;
}

const DEFAULT_STORE: StoreShape = {
  wallet: null,
  nodes: [],
  events: [],
  logs: {},
  nodeBackups: {},
};

let cached: StoreShape | null = null;
// Dedup concurrent first reads: many IPC handlers call readStore() at once on
// startup. Without this, each would hit disk + JSON.parse independently before
// `cached` is populated. Holding the in-flight promise collapses them to one.
let readInFlight: Promise<StoreShape> | null = null;

function storePath(): string {
  return path.join(app.getPath('userData'), 'store.json');
}

async function loadStore(): Promise<StoreShape> {
  try {
    const raw = await fs.readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    return {
      wallet: parsed.wallet ?? null,
      nodes: parsed.nodes ?? [],
      events: parsed.events ?? [],
      logs: parsed.logs ?? {},
      nodeBackups: parsed.nodeBackups ?? {},
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      // First run — no store yet. Expected, not an error.
      log.info('store.json absent — starting from defaults');
    } else {
      // Corrupt JSON, EACCES, or any other failure. Falling back to defaults
      // here means an unreadable-but-present store would be silently masked and
      // then OVERWRITTEN by the next writeStore. Loud-log so it is recoverable
      // from the diagnostics bundle before that happens.
      log.error('store.json unreadable — falling back to defaults (existing data at risk on next write)', {
        code: code ?? null,
        err: String(err),
      });
    }
    return structuredClone(DEFAULT_STORE);
  }
}

export async function readStore(): Promise<StoreShape> {
  if (cached) return cached;
  if (readInFlight) return readInFlight;
  readInFlight = loadStore()
    .then((s) => {
      cached = s;
      return s;
    })
    .finally(() => {
      readInFlight = null;
    });
  return readInFlight;
}

/** Drop the in-memory cache so the next `readStore()` reads from disk
 *  (or falls back to defaults if the file is gone). Used by full-reset
 *  flows like wallet logout. */
export function resetStoreCache(): void {
  cached = null;
  readInFlight = null;
}

export async function writeStore(next: StoreShape): Promise<void> {
  cached = next;
  const target = storePath();
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  // Atomic write: serialize to a sibling temp file first, then rename. A
  // crash mid-write therefore cannot leave `store.json` truncated — the
  // previous good copy stays intact until the rename completes.
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
