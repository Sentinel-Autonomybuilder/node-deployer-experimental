import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

/**
 * `better-sqlite3` is a native addon whose compiled `.node` is built for ONE
 * NODE_MODULE_VERSION at a time. The shipping app runs on Electron (ABI 140
 * for Electron 39), so `npm run rebuild:electron` produces an Electron-ABI
 * binary — which the vitest runner (plain Node, ABI 137) physically cannot
 * `dlopen`. When that's the case the metrics store correctly degrades to a
 * no-op (see metrics.ts getDB() catch), so these assertions can't run.
 *
 * Rather than silently pass against a disabled store (which would hide real
 * regressions) we probe the binding once and skip the suite WITH A REASON
 * when it can't load under the current runtime. The full logic is still
 * exercised whenever the runner ABI matches the built binary (e.g. after
 * `npm rebuild better-sqlite3` for Node, or when run under Electron).
 */
function sqliteLoadsUnderRunner(): { ok: boolean; reason?: string } {
  try {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    // require() returns the JS wrapper without dlopen'ing the addon — force
    // the native bindings to load by actually opening an in-memory DB.
    new Database(':memory:').close();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message.split('\n')[0] };
  }
}

const sqlite = sqliteLoadsUnderRunner();
if (!sqlite.ok) {
  // Surfaced in the vitest run so the skip is never silent.
  console.warn(
    `[metrics.test] SKIPPING — better-sqlite3 native binding unavailable under this runtime ` +
      `(node ABI ${process.versions.modules}). The shipping app builds it for Electron's ABI ` +
      `via \`npm run rebuild:electron\`; to run these tests under vitest run ` +
      `\`npm rebuild better-sqlite3\` first. Reason: ${sqlite.reason}`,
  );
}

const describeMaybe = sqlite.ok ? describe : describe.skip;

// `electron` is a native module we don't have in test — stub it.
vi.mock('electron', () => ({
  app: {
    getPath: () => {
      // Each test case gets its own temp dir via beforeEach(), but electron
      // itself calls through getPath('userData'); we keep a single dir.
      const dir = process.env['SENTINEL_TEST_USERDATA'];
      if (!dir) throw new Error('SENTINEL_TEST_USERDATA not set');
      return dir;
    },
  },
}));

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-metrics-'));
  process.env['SENTINEL_TEST_USERDATA'] = tmp;
  // Force fresh DB instance per test — reset module cache.
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  delete process.env['SENTINEL_TEST_USERDATA'];
});

describeMaybe('metrics store', () => {
  it('records and queries samples for a node within the window', async () => {
    const { recordSample, history } = await import('../../src/main/services/metrics');
    const now = Date.now();
    recordSample({
      nodeId: 'n1',
      ts: now - 10_000,
      peers: 4,
      bytesIn: 1000,
      bytesOut: 2000,
      earningsUdvpn: 123,
      chainHeight: 100,
      reachable: true,
    });
    recordSample({
      nodeId: 'n1',
      ts: now,
      peers: 5,
      bytesIn: 1500,
      bytesOut: 3000,
      earningsUdvpn: 200,
      chainHeight: 101,
      reachable: true,
    });
    const rows = history('n1', '1h');
    expect(rows.length).toBe(2);
    expect(rows[0].peers).toBe(4);
    expect(rows[1].peers).toBe(5);
  });

  it('purges samples when a node is removed', async () => {
    const { recordSample, history, purgeNode } = await import('../../src/main/services/metrics');
    recordSample({
      nodeId: 'n2',
      ts: Date.now(),
      peers: 1,
      bytesIn: 0,
      bytesOut: 0,
      earningsUdvpn: 0,
      reachable: true,
    });
    expect(history('n2', '1h').length).toBe(1);
    purgeNode('n2');
    expect(history('n2', '1h').length).toBe(0);
  });

  it('filters out samples older than the window', async () => {
    const { recordSample, history } = await import('../../src/main/services/metrics');
    const old = Date.now() - 2 * 60 * 60 * 1000;
    recordSample({
      nodeId: 'n3',
      ts: old,
      peers: 9,
      bytesIn: 0,
      bytesOut: 0,
      earningsUdvpn: 0,
      reachable: true,
    });
    expect(history('n3', '1h').length).toBe(0);
    expect(history('n3', '24h').length).toBe(1);
  });
});
