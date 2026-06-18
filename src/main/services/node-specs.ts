import { safeStorage } from 'electron';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import type { Client } from 'ssh2';
import { addEvent } from './events';
import { DENOM } from './chain';
import { dockerOverview } from './docker';
import { log } from './logger';
import { signClient } from './sentinel-client';
import { getSettings } from './settings';
import { buildLocalSystemReport } from './system-report';
import { readStore, writeStore } from './store';
import { signerFromMnemonic } from './wallet';
import { withSSH, runRemote } from './ssh';
import type { DeployedNode, NodeSpecsSnapshot, SSHCredentials } from '../../shared/types';
import { getNode, getSSH, updateNode } from './node-manager';

/**
 * On-chain hardware specs reporting (specs:v1).
 *
 * After a fresh node lands its first chain registration, the manager
 * broadcasts a self-MsgSend (operator → operator, 1 udvpn) carrying a
 * tagged memo with the node's hardware snapshot. The tx is trivially
 * identifiable on any explorer:
 *
 *   from == to                        // self-send
 *   memo.startsWith('specs:v1:')      // tagged
 *
 * This is operator-reported, NOT consensus-validated — CQAP attestation
 * supersedes it once that lands.
 *
 * Memo schema v1 (compact JSON, ≤ 240 bytes after `specs:v1:`):
 *   { cpu, c, cr, r, rr }
 *     cpu  – CPU model string, truncated to 64 chars
 *     c    – total logical cores on the host
 *     cr   – cores AVAILABLE to the dvpn-node container (Docker/WSL2 VM)
 *     r    – total host RAM (MiB)
 *     rr   – RAM AVAILABLE to the dvpn-node container (Docker/WSL2 VM, MiB)
 *
 * NOTE on `cr`/`rr` semantics: the node container is launched with no CPU or
 * memory cap (see docker.ts HostConfig — no Memory/NanoCpus), so nothing is
 * "reserved". On Windows the container runs inside the WSL2 VM, which the
 * Docker engine sizes BELOW the host (default RAM = min(50% host, 8 GB)).
 * `docker info` NCPU/MemTotal report that VM allocation — the real ceiling a
 * container can draw from — which is why `cr`/`rr` mean "available to the
 * container", not "reserved for it". On a single-purpose Linux VPS the VM ==
 * host, so cr==c and rr==r there. If we ever set real HostConfig limits, these
 * become true reservations and the schema should bump to v2.
 */

const MEMO_PREFIX = 'specs:v1:';
const MEMO_MAX_BYTES = 240;
const CPU_MAX_CHARS = 64;

// Same regex updateNodePricing uses — chain-pool-down errors that clear
// in seconds shouldn't be treated as terminal. We additionally treat
// fresh-account errors as transient: the operator was just funded and
// it can take 10–20s for every RPC peer to see the account exist.
const TRANSIENT_ERR =
  /timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo|EAI_AGAIN|Could not connect to the Sentinel network|none responded|sequence mismatch|account .* does not exist|account .* not found|unknown account|insufficient fund|tx already in mempool|tx already exists in cache|mempool is full/i;

// "tx already exists in cache" / "tx already in mempool" mean the broadcast
// was a duplicate — the previous attempt is still pending in the node's
// mempool and will land. Treat as success: clear pending, no retry storm.
const ALREADY_PENDING_ERR = /tx already exists in cache|tx already in mempool/i;

function accountToNodeAddr(accountAddr: string): string {
  try {
    const { data } = fromBech32(accountAddr);
    return toBech32('sentnode', data);
  } catch {
    return accountAddr;
  }
}

/** Capture the host's hardware snapshot. Used for `target: 'local'` deploys. */
export async function captureLocalSpecs(): Promise<NodeSpecsSnapshot> {
  const report = await buildLocalSystemReport();
  let dockerNcpu: number | undefined;
  let dockerMemMb: number | undefined;
  try {
    const overview = await dockerOverview();
    dockerNcpu = overview.ncpu;
    dockerMemMb = overview.totalMemoryMb;
  } catch (err) {
    log.debug('dockerOverview failed during specs capture', { err: String(err) });
  }
  return {
    cpu: truncateCpu(report.cpuModel),
    c: report.cpuCores,
    // `cr`/`rr` = resources AVAILABLE to the container, not reserved for it.
    // The node container runs with no CPU/memory cap, so its real ceiling is
    // whatever the Docker engine exposes. On Windows that's the WSL2 VM
    // allocation (docker info NCPU/MemTotal), which sits below the host total
    // (default RAM = min(50% host, 8 GB)) — so `rr` < `r` there and the two
    // fields carry distinct, meaningful info. Fall back to host totals only if
    // the docker info probe failed (engine down), since on a single-purpose
    // box the VM == host anyway.
    cr: dockerNcpu ?? report.cpuCores,
    r: report.memoryMb,
    rr: dockerMemMb ?? report.memoryMb,
  };
}

/**
 * Probe a remote host for hardware specs over an existing SSH session
 * (`ssh2.Client`). All commands are read-only and bail-safe — if any
 * single probe fails we still return what we managed to capture.
 *
 * Throws only if every probe fails, in which case the caller should log
 * a warning and skip publishing for this node. Deploy itself does not
 * fail just because the spec probe couldn't run.
 */
export async function captureRemoteSpecs(creds: SSHCredentials): Promise<NodeSpecsSnapshot> {
  return withSSH(creds, async (client: Client) => {
    const cores = await sshOne(client, 'nproc');
    const memInfo = await sshOne(client, 'cat /proc/meminfo');
    const cpuInfo = await sshOne(client, 'cat /proc/cpuinfo');

    const c = parseInt(cores.trim(), 10);
    const memTotalKb = matchKv(memInfo, /^MemTotal:\s+(\d+)\s*kB/m);
    const cpuModel = matchKv(cpuInfo, /^model name\s*:\s*(.+)$/m) ?? 'Unknown CPU';

    if (!Number.isFinite(c) || c <= 0) {
      throw new Error('remote nproc returned no cores');
    }
    if (!memTotalKb) {
      throw new Error('remote /proc/meminfo missing MemTotal');
    }
    const r = Math.round(parseInt(memTotalKb, 10) / 1024);

    // Probe the remote Docker engine for what it actually exposes to
    // containers (NCPU / MemTotal), mirroring what local does via
    // dockerOverview(). `docker info` emits stable Go-template keys, so we
    // ask for exactly the two values and parse them line-by-line. This is
    // bail-safe: if Docker isn't reachable over SSH (not installed, perms,
    // daemon down) we fall back to host totals — on a single-purpose VPS the
    // engine == host, so cr==c / rr==r is the right default there anyway.
    let dockerNcpu: number | undefined;
    let dockerMemMb: number | undefined;
    try {
      // {{.NCPU}} = logical CPUs the engine sees; {{.MemTotal}} = bytes.
      const info = await sshOne(
        client,
        'docker info --format "{{.NCPU}}|{{.MemTotal}}"',
      );
      const [ncpuStr, memBytesStr] = info.trim().split('|');
      const ncpu = parseInt(ncpuStr, 10);
      const memBytes = parseInt(memBytesStr, 10);
      if (Number.isFinite(ncpu) && ncpu > 0) dockerNcpu = ncpu;
      if (Number.isFinite(memBytes) && memBytes > 0) {
        dockerMemMb = Math.round(memBytes / (1024 * 1024));
      }
    } catch (err) {
      log.debug('remote docker info probe failed during specs capture', {
        err: String(err),
      });
    }

    return {
      cpu: truncateCpu(cpuModel),
      c,
      // `cr`/`rr` = resources AVAILABLE to the container (Docker engine view),
      // not reserved. Falls back to host totals when the engine probe fails.
      cr: dockerNcpu ?? c,
      r,
      rr: dockerMemMb ?? r,
    };
  });
}

async function sshOne(client: Client, cmd: string): Promise<string> {
  const res = await runRemote(client, cmd, undefined, { timeoutMs: 15_000 });
  if (res.code !== 0) {
    throw new Error(`'${cmd}' exited ${res.code}: ${(res.stderr || res.stdout).slice(-200)}`);
  }
  return res.stdout;
}

function matchKv(haystack: string, re: RegExp): string | undefined {
  const m = haystack.match(re);
  return m ? m[1].trim() : undefined;
}

function truncateCpu(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, CPU_MAX_CHARS);
}

/**
 * Build the memo string. Asserts the result fits the Cosmos default
 * 256-byte memo cap with a 16-byte safety margin.
 */
export function buildSpecsMemo(snapshot: NodeSpecsSnapshot): string {
  const compact = {
    cpu: snapshot.cpu.slice(0, CPU_MAX_CHARS),
    c: snapshot.c,
    cr: snapshot.cr,
    r: snapshot.r,
    rr: snapshot.rr,
  };
  const memo = `${MEMO_PREFIX}${JSON.stringify(compact)}`;
  const bytes = Buffer.byteLength(memo, 'utf8');
  if (bytes > MEMO_MAX_BYTES) {
    // Defensive truncation: shrink cpu until it fits. We never broadcast
    // a memo that would be rejected on-chain.
    const overflow = bytes - MEMO_MAX_BYTES;
    compact.cpu = compact.cpu.slice(0, Math.max(0, compact.cpu.length - overflow - 1));
    return `${MEMO_PREFIX}${JSON.stringify(compact)}`;
  }
  return memo;
}

/**
 * Sign and broadcast the specs:v1 self-MsgSend for a given node. Persists
 * the resulting txHash on the DeployedNode and surfaces an Activity event.
 *
 * Returns `{ ok, txHash, error }` — the caller decides whether to retry
 * later (we already store `specsPublishPending`).
 */
export async function publishNodeSpecs(
  nodeId: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  const node = await getNode(nodeId);
  if (!node) return { ok: false, error: 'Node not found' };

  // Default: idempotent — if we already have a tx hash on this node, don't
  // re-broadcast. `force: true` is used by the per-start republish path so
  // every on/off cycle gets a fresh on-chain attestation.
  if (!opts.force && node.specsTxHash) {
    return { ok: true, txHash: node.specsTxHash };
  }

  let snapshot: NodeSpecsSnapshot | undefined = node.specs;
  if (!snapshot) {
    // Late capture — happens on the replay path if specs were never
    // persisted for some reason. Local nodes can re-capture cheaply;
    // remote nodes need stored credentials.
    try {
      if (node.target === 'local') {
        snapshot = await captureLocalSpecs();
      } else {
        const creds = getSSH(nodeId);
        if (!creds) {
          return {
            ok: false,
            error: 'No SSH credentials cached for this remote node — cannot probe specs.',
          };
        }
        snapshot = await captureRemoteSpecs(creds);
      }
      await updateNode(nodeId, { specs: snapshot });
    } catch (probeErr) {
      const msg = (probeErr as Error).message ?? 'unknown';
      log.warn('specs probe failed', { nodeId, err: msg });
      return { ok: false, error: `specs probe failed: ${msg}` };
    }
  }

  const memo = buildSpecsMemo(snapshot);

  const store = await readStore();
  const backup = store.nodeBackups[nodeId];
  if (!backup) {
    return { ok: false, error: 'No encrypted backup of this node mnemonic.' };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'OS keychain unavailable — cannot decrypt backup.' };
  }

  let mnemonic: string;
  try {
    mnemonic = safeStorage.decryptString(Buffer.from(backup, 'base64'));
  } catch (err) {
    return { ok: false, error: `Could not decrypt backup: ${(err as Error).message}` };
  }

  try {
    const signer = await signerFromMnemonic(mnemonic);
    const [{ address: from }] = await signer.getAccounts();
    if (from !== node.operatorAddress) {
      log.warn('specs publish: signer != stored operator', {
        nodeId,
        signer: from,
        stored: node.operatorAddress,
      });
    }

    const settings = await getSettings();
    // 120K is short for Sentinel's MsgSend (ante handlers consume ~120.8K
    // of gas before our message even runs — observed 120850 used for a
    // 120000 wanted broadcast, code 11). Match the wallet send path's
    // GAS_FALLBACK = 250000 so the tx actually lands.
    const gas = 250_000;
    const feeUdvpn = String(Math.max(1, Math.ceil(gas * Number(settings.gasPriceUdvpn))));
    const fee = { amount: [{ denom: DENOM, amount: feeUdvpn }], gas: String(gas) };

    // Self-send 1 udvpn (the smallest indivisible unit). Detection rule:
    // from == to + memo prefix `specs:v1:` ⇒ specs report.
    const sendMsg = {
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: {
        fromAddress: from,
        toAddress: from,
        amount: [{ denom: DENOM, amount: '1' }],
      },
    };

    const MAX_ATTEMPTS = 6;
    const RETRY_DELAY_MS = 6_000;
    type BroadcastResult = { code: number; rawLog?: string; transactionHash: string };
    let result: BroadcastResult | null = null;
    let lastErr = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let opened: Awaited<ReturnType<typeof signClient>> | null = null;
      try {
        opened = await signClient(signer);
      } catch (connErr) {
        lastErr = (connErr as Error).message;
        if (!TRANSIENT_ERR.test(lastErr) || attempt === MAX_ATTEMPTS) break;
        log.warn('specs publish signClient failed, retrying', {
          attempt,
          err: lastErr.slice(0, 160),
        });
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      try {
        result = (await opened.client.signAndBroadcast(
          from,
          [sendMsg as never],
          fee,
          memo,
        )) as BroadcastResult;
      } catch (bcErr) {
        lastErr = (bcErr as Error).message;
        result = null;
        if (!TRANSIENT_ERR.test(lastErr) || attempt === MAX_ATTEMPTS) break;
        log.warn('specs publish broadcast threw, retrying', {
          attempt,
          err: lastErr.slice(0, 160),
        });
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      } finally {
        opened.disconnect();
      }
      if (result.code === 0) break;
      lastErr = result.rawLog ?? `code ${result.code}`;
      if (!TRANSIENT_ERR.test(lastErr) || attempt === MAX_ATTEMPTS) break;
      log.warn('specs publish chain rejected, retrying', {
        attempt,
        err: lastErr.slice(0, 160),
      });
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    if (!result || result.code !== 0) {
      const errMsg = lastErr || 'Broadcast rejected';
      // Duplicate broadcast — the previous attempt is sitting in the
      // mempool and will land. Don't flag as failed or trigger replay.
      if (ALREADY_PENDING_ERR.test(errMsg)) {
        await updateNode(nodeId, { specsPublishPending: false });
        log.info('specs publish duplicate, prior tx still pending', {
          nodeId,
          err: errMsg.slice(0, 160),
        });
        return { ok: true };
      }
      // Mark for replay — startup poller will try again next session.
      await updateNode(nodeId, { specsPublishPending: true });
      await addEvent({
        kind: 'specs-publish-failed',
        title: `Specs publish failed: ${node.moniker}`,
        subtitle: errMsg.slice(0, 180),
        relatedNodeId: nodeId,
      });
      return { ok: false, error: errMsg };
    }

    const txHash = result.transactionHash;
    await updateNode(nodeId, {
      specsTxHash: txHash,
      specsPublishedAt: Date.now(),
      specsPublishPending: false,
    });
    await addEvent({
      kind: 'specs-reported',
      title: `Specs reported on-chain: ${node.moniker}`,
      subtitle: `${snapshot.c} cores · ${snapshot.r} MiB RAM · ${snapshot.cpu}`.slice(0, 180),
      relatedNodeId: nodeId,
      txHash,
    });
    return { ok: true, txHash };
  } catch (err) {
    await updateNode(nodeId, { specsPublishPending: true });
    const errMsg = (err as Error).message;
    await addEvent({
      kind: 'specs-publish-failed',
      title: `Specs publish failed: ${node.moniker}`,
      subtitle: errMsg.slice(0, 180),
      relatedNodeId: nodeId,
    });
    return { ok: false, error: errMsg };
  }
}

/**
 * Replay specs publishing on app startup for any nodes flagged as
 * `specsPublishPending`. Sequential with a small delay so we don't bombard
 * the RPC pool from a fleet that came back online together.
 */
export async function replayPendingSpecs(): Promise<void> {
  const store = await readStore();
  // A node is "pending" if specsPublishPending is true — regardless of
  // whether it already has a prior specsTxHash. The per-start republish
  // path sets pending=true on every start; if that broadcast failed we
  // need to retry on next launch even though an older tx hash is still
  // recorded from a previous start. Use force=true so the idempotency
  // short-circuit in publishNodeSpecs doesn't no-op us.
  const candidates: DeployedNode[] = store.nodes.filter(
    (n) => n.specsPublishPending,
  );
  if (candidates.length === 0) return;
  log.info('replaying pending specs publishes', { count: candidates.length });
  for (const node of candidates) {
    try {
      const res = await publishNodeSpecs(node.id, { force: true });
      if (!res.ok) {
        log.warn('specs replay still pending', { nodeId: node.id, err: res.error?.slice(0, 160) });
      }
    } catch (err) {
      log.warn('specs replay threw', { nodeId: node.id, err: (err as Error).message });
    }
    // Keep the cadence gentle — chain-test guidance is 7s between TXs.
    await new Promise((r) => setTimeout(r, 7_000));
  }
}

// Test hook
export const _internals = { buildSpecsMemo, MEMO_PREFIX, MEMO_MAX_BYTES };
