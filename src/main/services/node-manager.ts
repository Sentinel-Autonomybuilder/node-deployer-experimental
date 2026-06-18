import { app, BrowserWindow, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  IMAGE_TAG,
  containerLogs,
  containerName,
  getClient as getDockerClient,
  isRunning,
  removeContainer,
  restartContainer,
  runNode,
  setRestartPolicy,
  stopContainer,
  withDockerTimeout,
} from './docker';
import {
  readClients,
  signClient,
  withRpcTimeout,
  RPC_QUERY_TIMEOUT_MS,
} from './sentinel-client';
import { readStore, writeStore } from './store';
import { addEvent } from './events';
import { recordSample, purgeNode, history } from './metrics';
import { DENOM, dvpnToUdvpn, udvpnToDvpn } from './chain';
import { signerFromMnemonic } from './wallet';
import { formatBase } from './price';
import { withSSH, runRemote, shellQuote } from './ssh';
import { GasPrice } from '@cosmjs/stargate';
import { getSettings } from './settings';
import { resolveCountry } from './geoip';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import { BaseSession } from '@sentinel-official/sentinel-js-sdk/dist/protobuf/sentinel/session/v3/session';
import { Status } from '@sentinel-official/sentinel-js-sdk/dist/protobuf/sentinel/types/v1/status';
import type { Plan } from '@sentinel-official/sentinel-js-sdk/dist/protobuf/sentinel/plan/v3/plan';
import type { Node as SentinelNode } from '@sentinel-official/sentinel-js-sdk/dist/protobuf/sentinel/node/v3/node';
import type { SentinelQueryClient } from '@sentinel-official/sentinel-js-sdk';

// Node ids are UUIDv4 generated locally. We validate against this regex
// before interpolating an id into any shell command, even when the id
// also flows through shellQuote — defence in depth.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sentinel stores the *node* identity under a distinct bech32 HRP
 * (`sentnode…`) even though it shares the underlying 20-byte payload with
 * the operator's `sent…` account address. Any chain-side query about the
 * node needs the re-encoded form.
 */
function accountToNodeAddr(accountAddr: string): string {
  try {
    const { data } = fromBech32(accountAddr);
    return toBech32('sentnode', data);
  } catch {
    return accountAddr;
  }
}

/**
 * `sessionsForNode` returns `Any[]` — the concrete session variants
 * (WireGuard / V2Ray) all embed the same `BaseSession` at field tag 1,
 * so decoding the Any bytes as BaseSession gives us every field we show
 * in the "Active Subscriptions" card. The tail bytes (protocol-specific
 * session details) are ignored by the decoder, which is the behaviour we
 * want.
 *
 * Returns `null` for sessions we cannot decode or that aren't actually
 * active on-chain, so the caller can filter them out — previously the
 * code surfaced empty rows and showed them as live subscriptions.
 */
function summarizeSession(raw: unknown): NodeSession | null {
  const decoded = decodeBaseSession(raw);
  if (!decoded) return null;

  // Only STATUS_ACTIVE is a live subscription. INACTIVE_PENDING means
  // the user pressed stop and the session is winding down; INACTIVE
  // means it already ended. Filter both out so the card reflects reality.
  if (decoded.status !== Status.STATUS_ACTIVE) return null;

  const id = decoded.id?.toString?.() ?? String(decoded.id ?? '');
  const accAddress = decoded.accAddress || '';
  // BaseSession upload/download are wire-encoded as string-bigints
  // (cosmos-sdk `sdk.Int`). Safe to Number() — bytes counters won't
  // exceed 2^53 in any realistic session.
  const bytesIn = Number(decoded.downloadBytes || '0');
  const bytesOut = Number(decoded.uploadBytes || '0');
  const durSec = decoded.duration
    ? Number(decoded.duration.seconds?.toString?.() ?? decoded.duration.seconds ?? 0) +
      Math.round((decoded.duration.nanos ?? 0) / 1e6) / 1000
    : 0;
  const short = accAddress
    ? `${accAddress.slice(0, 10)}…${accAddress.slice(-6)}`
    : id.slice(0, 12);

  return {
    id,
    subscriber: accAddress || id,
    subscriberShort: short,
    bytesIn,
    bytesOut,
    durationSeconds: Math.max(0, Math.round(durSec)),
    status: 'STATUS_ACTIVE',
  };
}

/**
 * Discover every plan (across all providers) the given node address is
 * currently linked into. The chain has no inverse "plans for node" query,
 * so we list active plans, then probe each one's `nodesForPlan` to test
 * membership. Bounded by the size of the active-plan set on Sentinel
 * (well under a hundred today).
 *
 * The price field on Plan is `prices[0]` — Sentinel v3 plan pricing is
 * immutable once created. We surface `quoteValue` as the on-chain micro
 * amount and divide by 1e6 for display.
 */
async function discoverPlansForNode(
  sentinel: SentinelQueryClient,
  nodeAddr: string,
): Promise<NodePlanLink[]> {
  let plans: Plan[] = [];
  try {
    const res = await sentinel.plan.plans(Status.STATUS_ACTIVE);
    plans = res.plans ?? [];
  } catch (err) {
    log.debug('plans query failed', { err: (err as Error).message });
    return [];
  }

  const out: NodePlanLink[] = [];
  await Promise.all(
    plans.map(async (plan) => {
      try {
        const r = await sentinel.node.nodesForPlan(plan.id, Status.STATUS_ACTIVE);
        const nodes = (r.nodes ?? []) as SentinelNode[];
        const isMember = nodes.some((n) => n.address === nodeAddr);
        if (!isMember) return;
        const price = plan.prices?.[0];
        const durationSec = plan.duration
          ? Number(plan.duration.seconds?.toString?.() ?? plan.duration.seconds ?? 0)
          : 0;
        out.push({
          id: plan.id.toString(),
          denom: price?.denom ?? '',
          price: price ? Number(price.quoteValue || '0') / 1_000_000 : 0,
          durationDays: Math.round((durationSec / 86_400) * 100) / 100,
        });
      } catch (err) {
        log.debug('nodesForPlan probe failed', {
          planId: plan.id?.toString?.(),
          err: (err as Error).message,
        });
      }
    }),
  );
  // Stable ordering by plan id (numeric).
  out.sort((a, b) => {
    const an = Number(a.id);
    const bn = Number(b.id);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.id.localeCompare(b.id);
  });
  return out;
}

/**
 * Accepts either a raw `{ typeUrl, value: Uint8Array }` Any from the
 * query client, or an already-decoded BaseSession (defensive — some SDK
 * versions auto-decode). Returns undefined when the shape is unknown or
 * the bytes fail to parse, so callers can treat it as "skip this row".
 */
function decodeBaseSession(raw: unknown): BaseSession | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;

  // Already-decoded object (has the fields we expect).
  if (typeof r.accAddress === 'string' && r.id !== undefined) {
    return r as unknown as BaseSession;
  }

  // Protobuf Any: { typeUrl, value: Uint8Array }.
  const value = r.value;
  const typeUrl = typeof r.typeUrl === 'string' ? r.typeUrl : '';
  if (!(value instanceof Uint8Array)) return undefined;
  // Sentinel wraps both wireguard + v2ray session variants in types that
  // embed BaseSession at tag 1 — so decoding the outer bytes directly as
  // BaseSession grabs the shared fields. Unknown tags are skipped.
  try {
    return BaseSession.decode(value);
  } catch (err) {
    log.debug('BaseSession.decode failed', { typeUrl, err: (err as Error).message });
    return undefined;
  }
}
import {
  IPC,
  type DeployedNode,
  type MetricsSample,
  type MetricsWindow,
  type NodeLiveStatus,
  type NodePlanLink,
  type NodeSession,
  type NodeStatus,
  type SSHCredentials,
} from '../../shared/types';
import { log } from './logger';

/**
 * Lifecycle + observability for deployed nodes.
 *
 *   • Local nodes run as Docker containers; we keep the container id in
 *     `node.runtimeId` and hit Docker directly for start/stop/logs/status.
 *   • Remote nodes live on a VPS; we keep their SSH credentials in an
 *     in-memory keyring (never persisted). Commands execute over SSH.
 *   • Every 60s we sample each node (on-chain balance + node registration +
 *     session count where available) and insert into the SQLite time-series.
 *     The renderer's chart reads from `history()`.
 */

// In-memory SSH creds keyed by node id. Lost on app restart — by design.
const sshKeyring = new Map<string, SSHCredentials>();

// Per-node container start timestamp (approx uptime computation).
const startedAt = new Map<string, number>();

let poller: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------------------
// Inventory / lifecycle
// ---------------------------------------------------------------------------

export function nodeDataDir(nodeId: string): string {
  return path.join(app.getPath('userData'), 'nodes', nodeId);
}

export async function listNodes(): Promise<DeployedNode[]> {
  const store = await readStore();
  return store.nodes;
}

// A node sitting in `loading` is a zombie when:
//   • it has no runtimeId AND was created >10 min ago — deploy crashed
//     before any container ran; OR
//   • it has a runtimeId but the container is missing/exited AND was created
//     >10 min ago — container died and never recovered.
// In either case the fast-poller hammers the chain forever and the Nodes
// screen shows a permanent "Starting" entry. Drop them.
const ZOMBIE_LOADING_AGE_MS = 10 * 60_000;

/**
 * User-triggered force-clear: drop every local `loading` node whose container
 * is not running, regardless of age. This is the "I clicked Clear Stuck Nodes"
 * path from the UI — no 10-minute grace period.
 */
export async function reapStuckNow(): Promise<number> {
  const store = await readStore();
  const before = store.nodes.length;
  const survivors: DeployedNode[] = [];
  let dropped = 0;
  for (const n of store.nodes) {
    if (n.target !== 'local' || n.status !== 'loading') {
      survivors.push(n);
      continue;
    }
    let isStuck = true;
    if (n.runtimeId) {
      const up = await withDockerTimeout(
        () => isRunning(n.runtimeId!),
        5_000,
        'isRunning',
      ).catch(() => false);
      isStuck = !up;
    }
    if (!isStuck) {
      survivors.push(n);
      continue;
    }
    dropped += 1;
    log.info('force-reap stuck node', { id: n.id, moniker: n.moniker });
    if (n.runtimeId) {
      try {
        await removeContainer(n.runtimeId);
      } catch {
        /* already gone */
      }
    }
    try {
      await fs.rm(nodeDataDir(n.id), { recursive: true, force: true });
    } catch (err) {
      log.warn('stuck data dir cleanup failed', {
        path: nodeDataDir(n.id),
        err: (err as Error).message,
      });
    }
    stopFastPoll(n.id);
  }
  if (dropped > 0) {
    store.nodes = survivors;
    await writeStore(store);
    broadcast(IPC.NODES_CHANGED, null);
    log.info('force reap complete', { before, after: survivors.length, dropped });
  }
  return dropped;
}

export async function reapZombieNodes(): Promise<number> {
  const store = await readStore();
  const now = Date.now();
  const before = store.nodes.length;
  const survivors: DeployedNode[] = [];
  let dropped = 0;
  for (const n of store.nodes) {
    const age = n.createdAt ? now - Date.parse(n.createdAt) : 0;
    // Only loading nodes older than the zombie threshold are candidates.
    // M-9: previously remote nodes were never even considered (the guard was
    // `n.target !== 'local'`), so a remote deploy that wedged in 'loading'
    // lived forever as a phantom. Now both targets are reaped; the liveness
    // probe just differs (local dockerode vs. remote SSH).
    if (n.status !== 'loading' || age <= ZOMBIE_LOADING_AGE_MS) {
      survivors.push(n);
      continue;
    }
    let isZombie = false;
    let reason = '';
    if (n.target === 'local') {
      if (!n.runtimeId) {
        isZombie = true;
        reason = 'no runtimeId';
      } else {
        const up = await withDockerTimeout(
          () => isRunning(n.runtimeId!),
          5_000,
          'isRunning',
        ).catch(() => false);
        if (!up) {
          isZombie = true;
          reason = 'container not running';
        }
      }
    } else {
      // Remote: probe the container over SSH if we still hold creds. No creds
      // means we can never confirm liveness for a node that's already long
      // past its loading deadline — treat it as a zombie so the UI clears.
      const creds = sshKeyring.get(n.id);
      if (!creds) {
        isZombie = true;
        reason = 'remote loading past deadline, no cached SSH creds';
      } else {
        const up = await withSSH(creds, async (client) => {
          const sudo = await remoteSudo(client);
          const { code, stdout } = await runRemote(
            client,
            sudo +
              shellQuote(['docker', 'inspect', '-f', '{{.State.Running}}', containerName(n.id)]),
            undefined,
            { timeoutMs: 15_000 },
          );
          return code === 0 && stdout.trim() === 'true';
        }).catch(() => false);
        if (!up) {
          isZombie = true;
          reason = 'remote container not running';
        }
      }
    }
    if (isZombie) {
      dropped += 1;
      log.info('reaping zombie node', {
        id: n.id,
        moniker: n.moniker,
        ageMs: age,
        reason,
      });
      if (n.target === 'local') {
        if (n.runtimeId) {
          try {
            await removeContainer(n.runtimeId);
          } catch {
            /* container already gone — fine */
          }
        }
        try {
          await fs.rm(nodeDataDir(n.id), { recursive: true, force: true });
        } catch (err) {
          log.warn('zombie data dir cleanup failed', {
            path: nodeDataDir(n.id),
            err: (err as Error).message,
          });
        }
      } else {
        // Best-effort remote container teardown. Missing creds or an
        // unreachable host just means the (already non-running) container
        // is left for the operator's own cleanup — we still drop the entry.
        const creds = sshKeyring.get(n.id);
        if (creds) {
          await withSSH(creds, async (client) => {
            const sudo = await remoteSudo(client);
            await runRemote(
              client,
              sudo + shellQuote(['docker', 'rm', '-f', containerName(n.id)]),
              undefined,
              { timeoutMs: 30_000 },
            );
          }).catch((err) =>
            log.warn('remote zombie container teardown failed', {
              id: n.id,
              err: (err as Error).message,
            }),
          );
        }
      }
      continue;
    }
    survivors.push(n);
  }
  if (dropped > 0) {
    store.nodes = survivors;
    await writeStore(store);
    broadcast(IPC.NODES_CHANGED, null);
    log.info('zombie reap complete', { before, after: survivors.length, dropped });
  }
  return dropped;
}

export async function getNode(id: string): Promise<DeployedNode | null> {
  const store = await readStore();
  return store.nodes.find((n) => n.id === id) ?? null;
}

export function rememberSSH(nodeId: string, creds: SSHCredentials): void {
  sshKeyring.set(nodeId, creds);
}

export function getSSH(nodeId: string): SSHCredentials | undefined {
  return sshKeyring.get(nodeId);
}

export async function ensureNodePersisted(node: DeployedNode): Promise<void> {
  const store = await readStore();
  const idx = store.nodes.findIndex((n) => n.id === node.id);
  if (idx === -1) {
    store.nodes.push(node);
  } else {
    store.nodes[idx] = { ...store.nodes[idx], ...node };
  }
  await writeStore(store);
  broadcast(IPC.NODES_CHANGED, null);
}

export async function updateNode(id: string, patch: Partial<DeployedNode>): Promise<void> {
  const store = await readStore();
  const n = store.nodes.find((x) => x.id === id);
  if (!n) return;
  Object.assign(n, patch);
  await writeStore(store);
  broadcast(IPC.NODES_CHANGED, null);
}

export async function transition(id: string, status: NodeStatus): Promise<void> {
  await updateNode(id, { status });
  // The on-chain registration normally lands within a few seconds of the
  // deploy tx, but the global poller only samples every 60s. While a node
  // sits in `loading` we run a per-node fast-poller that probes every few
  // seconds so the UI flips "Pending registration" → "Active" promptly.
  // For loading→online we keep the fast-poller running so peers/uptime/
  // reachability stay live during the post-online grace window — the
  // poller's own tick checks `startedAt + grace` and self-stops.
  if (status === 'loading' || status === 'online') startFastPoll(id);
  else stopFastPoll(id);
}

// ---------------------------------------------------------------------------
// Per-node fast-poller: live updates for nodes still registering on chain
// ---------------------------------------------------------------------------

const fastPollers = new Map<string, NodeJS.Timeout>();
const fastPollExpiry = new Map<string, number>();
// M-10: consecutive fast-poll failures per node. Reset on any clean tick and
// on stop; escalates the log level once a poller is genuinely stuck.
const fastPollFailCount = new Map<string, number>();
const FAST_POLL_INTERVAL_MS = 4_000;
const FAST_POLL_TIMEOUT_MS = 5 * 60_000;
// After a node flips loading → online the renderer still needs frequent
// pushes for the first minute so peer count, uptime, and reachability
// don't sit on stale data until the 60s background poll catches up.
const POST_ONLINE_GRACE_MS = 60_000;

function startFastPoll(id: string): void {
  if (fastPollers.has(id)) {
    fastPollExpiry.set(id, Date.now() + FAST_POLL_TIMEOUT_MS);
    return;
  }
  fastPollExpiry.set(id, Date.now() + FAST_POLL_TIMEOUT_MS);
  const tick = async () => {
    if ((fastPollExpiry.get(id) ?? 0) < Date.now()) {
      stopFastPoll(id);
      return;
    }
    try {
      const node = await getNode(id);
      if (!node) {
        stopFastPoll(id);
        return;
      }
      // Keep ticking through the post-online grace window. We compare against
      // the node's `startedAt` so the grace covers the first ~60s of life,
      // independent of when the loading→online transition actually fired.
      const startedAtMs = node.startedAt ? Date.parse(node.startedAt) : 0;
      const inOnlineGrace =
        node.status === 'online' &&
        startedAtMs > 0 &&
        Date.now() - startedAtMs < POST_ONLINE_GRACE_MS;
      if (node.status !== 'loading' && !inOnlineGrace) {
        stopFastPoll(id);
        return;
      }
      const status = await liveStatus(id);
      // Push the fresh snapshot to the renderer so chainStatus flips live.
      broadcast(IPC.NODES_LIVE_STATUS, { nodeId: id, status });
      // Promote loading → online the same way the 60s poller does, but
      // sooner. The `node.status === 'loading'` gate keeps the event
      // single-fire: once we've transitioned to online the fast-poller
      // keeps ticking through the post-online grace window for live
      // peer/uptime pushes, but must not re-emit `node-online` on every tick.
      if (status.reachable && node.status === 'loading') {
        await transition(id, 'online');
        await addEvent({
          kind: 'node-online',
          title: `Node ${node.moniker} is online`,
          subtitle: 'Registered on chain',
          relatedNodeId: id,
        });
        // transition() will call stopFastPoll for us via the `else` branch.
      } else if (
        // Container-up fallback during fast-poll. Same rule as the 60s
        // poller: if the container has been running >60s and chain hasn't
        // caught up, still flip the UI to online.
        node.target === 'local' &&
        node.status === 'loading' &&
        node.runtimeId &&
        node.startedAt &&
        Date.now() - Date.parse(node.startedAt) > 60_000 &&
        (await withDockerTimeout(
          () => isRunning(node.runtimeId!),
          5_000,
          'isRunning',
        ).catch(() => false))
      ) {
        await transition(id, 'online');
        await addEvent({
          kind: 'node-online',
          title: `Node ${node.moniker} is online`,
          subtitle: 'Container running (chain registration pending)',
          relatedNodeId: id,
        });
      }
      // Clean tick — reset the consecutive-failure escalation counter.
      fastPollFailCount.delete(id);
    } catch (err) {
      // M-10: was log.debug, which silently swallowed real faults (a wedged
      // Docker client, a thrown transition, a store write error) for the whole
      // grace window. Transient RPC/probe failures are expected here, so keep
      // the level low but make it warn-visible and tag consecutive failures so
      // a genuinely stuck poller is greppable in diagnostics.
      const fails = (fastPollFailCount.get(id) ?? 0) + 1;
      fastPollFailCount.set(id, fails);
      const msg = (err as Error).message;
      if (fails >= 3) {
        log.warn('fast-poll node failing repeatedly', { id, fails, err: msg });
      } else {
        log.debug('fast-poll node failed', { id, fails, err: msg });
      }
    }
  };
  // Kick a probe immediately, then on the interval. immediate probe makes the
  // first refresh visible within the IPC round-trip rather than after 4 s.
  void tick();
  const handle = setInterval(() => void tick(), FAST_POLL_INTERVAL_MS);
  fastPollers.set(id, handle);
}

function stopFastPoll(id: string): void {
  const h = fastPollers.get(id);
  if (h) {
    clearInterval(h);
    fastPollers.delete(id);
  }
  fastPollExpiry.delete(id);
  fastPollFailCount.delete(id);
}

// ---------------------------------------------------------------------------
// Start / stop / restart
// ---------------------------------------------------------------------------

/** Build a sudo prefix lazily for a remote session. */
async function remoteSudo(client: import('ssh2').Client): Promise<string> {
  const r = await runRemote(client, 'id -u');
  return r.stdout.trim() === '0' ? '' : 'sudo -n ';
}

/**
 * Verify a freshly-started local container is still alive ~6s later. Without
 * this guard `runNode` happily returns success on a container that exits one
 * second later (port conflict, bad config), and the user stares at an
 * "online" pill that flips to offline on the next 60s poll. We surface the
 * tail of the container logs so the failure mode is debuggable from the UI.
 */
async function probeContainerAfterStart(runtimeId: string, name: string): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + 6_000;
  // Poll every ~500 ms until we either see a confirmed-up window (≥4 s of
  // continuous "running" state) or hit the deadline. Each docker call gets
  // its own per-call timeout so a wedged daemon can't block the loop.
  let firstSeenRunningAt: number | null = null;
  while (Date.now() < deadline) {
    const up = await withDockerTimeout(() => isRunning(runtimeId), 4_000, 'isRunning').catch(
      () => false,
    );
    if (up) {
      firstSeenRunningAt ??= Date.now();
      if (Date.now() - (firstSeenRunningAt ?? Date.now()) >= 1_500) return;
    } else if (firstSeenRunningAt !== null) {
      const tail = await withDockerTimeout(
        () => containerLogs(runtimeId, 30),
        6_000,
        'containerLogs',
      ).catch(() => [] as string[]);
      throw new Error(
        `Your node "${name}" started, but stopped almost immediately. Here is what it printed before it stopped:\n` +
          tail.join('\n').slice(-2000),
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const finalUp = await withDockerTimeout(
    () => isRunning(runtimeId),
    4_000,
    'isRunning',
  ).catch(() => false);
  if (!finalUp) {
    const tail = await withDockerTimeout(
      () => containerLogs(runtimeId, 30),
      6_000,
      'containerLogs',
    ).catch(() => [] as string[]);
    throw new Error(
      `Your node "${name}" would not stay running. Here is what it printed:\n` +
        tail.join('\n').slice(-2000),
    );
  }
}

export async function startNode(id: string): Promise<void> {
  const node = await getNode(id);
  if (!node) throw new Error('We couldn\'t find that node — it may have already been removed.');

  // Per-start specs republish: fire-and-forget so a transient RPC outage
  // never makes a successful node start look like it failed. Dynamic
  // import avoids a circular dep with node-specs.ts. `force: true`
  // bypasses the idempotency short-circuit on `specsTxHash` so every
  // on/off cycle gets a fresh on-chain attestation.
  const republishSpecs = () => {
    void updateNode(id, { specsPublishPending: true }).then(async () => {
      try {
        const { publishNodeSpecs } = await import('./node-specs');
        const res = await publishNodeSpecs(id, { force: true });
        if (!res.ok) log.warn('per-start specs republish failed', { id, err: res.error });
      } catch (err) {
        log.warn('per-start specs republish threw', { id, err: (err as Error).message });
      }
    });
  };

  const emitStarted = async (subtitle: string) => {
    await addEvent({
      kind: 'node-started',
      title: `Node ${node.moniker} started`,
      subtitle,
      relatedNodeId: id,
    });
  };

  if (node.target === 'local') {
    const name = containerName(node.id);
    // M-11: marks errors that must NOT be swallowed by the recreate
    // fall-through (port conflicts, surfaced resume failures). The outer
    // catch re-throws anything wearing this brand.
    const PROPAGATE = Symbol('propagate');
    const propagate = (err: Error): Error => {
      (err as Error & { [PROPAGATE]?: true })[PROPAGATE] = true;
      return err;
    };
    try {
      if (
        node.runtimeId &&
        (await withDockerTimeout(
          () => isRunning(node.runtimeId!),
          5_000,
          'isRunning',
        ).catch(() => false))
      ) {
        await setRestartPolicy(node.runtimeId, 'unless-stopped');
        await updateNode(id, { status: 'online' });
        await emitStarted('Local device · already running');
        republishSpecs();
        return;
      }
      // Container exists but is stopped — start it and restore restart policy.
      if (node.runtimeId) {
        const c = await getDockerClient();
        try {
          const container = c.getContainer(node.runtimeId);
          await container.inspect();
          await setRestartPolicy(node.runtimeId, 'unless-stopped');
          await container.start();
          const now = Date.now();
          startedAt.set(id, now);
          await updateNode(id, {
            status: 'online',
            startedAt: new Date(now).toISOString(),
          });
          await emitStarted('Local device · resumed container');
          republishSpecs();
          log.info('node started (local, resumed)', { id, name });
          return;
        } catch (resumeErr) {
          // M-11: only fall through to recreate when the existing container is
          // genuinely gone. Other failures (a port already bound by another
          // process, a Docker daemon error) must NOT silently fall through to
          // runNode — that just retries the same port and surfaces a cryptic
          // "address already in use" with no hint that a stale container or a
          // foreign process is the real cause. Surface those clearly instead.
          const m = (resumeErr as Error).message ?? '';
          const notFound = /no such container|not found|404/i.test(m);
          if (!notFound) {
            log.warn('resume of existing container failed (not a missing-container error)', {
              id,
              name,
              err: m,
            });
            if (/address already in use|port is already allocated/i.test(m)) {
              throw propagate(
                new Error(
                  `Port ${node.port} is already in use on this computer. Stop whatever is using it (or pick a different port) and try again.`,
                ),
              );
            }
            throw propagate(resumeErr as Error);
          }
          log.debug('existing container gone, recreating', { id, name });
        }
      }
    } catch (outerErr) {
      // Re-throw anything branded for propagation (real resume failures, port
      // conflicts). Only swallow the isRunning/inspect probe failures that
      // legitimately mean "recreate".
      if ((outerErr as Error & { [key: symbol]: unknown })[PROPAGATE]) throw outerErr;
      const m = (outerErr as Error).message ?? '';
      if (/address already in use|port is already allocated/i.test(m)) {
        throw new Error(
          `Port ${node.port} is already in use on this computer. Stop whatever is using it (or pick a different port) and try again.`,
        );
      }
      log.debug('local start probe failed, recreating container', { id, err: m });
    }
    const runtimeId = await runNode({
      nodeId: node.id,
      hostDataDir: nodeDataDir(node.id),
      port: node.port,
      imageTag: IMAGE_TAG,
    });
    // Liveness probe — give the container ~6s to either crash or stay up.
    // Without this, `runNode` can return success on a container that exits
    // 1s later (port conflict, config drift), leaving the user staring at
    // an "online" pill that flips to offline on the next poll.
    await probeContainerAfterStart(runtimeId, name);
    const now = Date.now();
    startedAt.set(id, now);
    await updateNode(id, { status: 'online', runtimeId, startedAt: new Date(now).toISOString() });
    await emitStarted('Local device · fresh container');
    republishSpecs();
    log.info('node started (local)', { id, name });
  } else {
    const creds = sshKeyring.get(id);
    if (!creds) {
      throw new Error(
        'We no longer have the SSH login for this remote node saved. Open Node Details and enter your SSH details again to restart it.',
      );
    }
    await withSSH(creds, async (client) => {
      const sudo = await remoteSudo(client);
      const cmd = sudo + shellQuote(['docker', 'start', containerName(id)]);
      const { code, stderr } = await runRemote(client, cmd, undefined, { timeoutMs: 30_000 });
      if (code === 124) {
        throw new Error('The remote computer didn\'t respond within 30 seconds. Please check your SSH connection and that Docker is running on the remote computer.');
      }
      if (code !== 0) throw new Error(`Could not start the node on the remote computer. Details: ${stderr.trim().slice(-400)}`);
    });
    const now = Date.now();
    startedAt.set(id, now);
    await updateNode(id, { status: 'online', startedAt: new Date(now).toISOString() });
    await emitStarted(`Remote · ${creds.host}`);
    republishSpecs();
  }
}

export async function stopNode(id: string): Promise<void> {
  const node = await getNode(id);
  if (!node) return;

  if (node.target === 'local') {
    if (node.runtimeId) await stopContainer(node.runtimeId);
  } else {
    const creds = sshKeyring.get(id);
    if (!creds) {
      log.warn('stopNode: remote creds not cached, marking offline only', { id });
    } else {
      await withSSH(creds, async (client) => {
        const sudo = await remoteSudo(client);
        await runRemote(client, sudo + shellQuote(['docker', 'stop', containerName(id)]));
      });
    }
  }
  await updateNode(id, { status: 'offline' });
  await addEvent({
    kind: 'node-stopped',
    title: `Node ${node.moniker} stopped`,
    subtitle: 'Requested by operator',
    relatedNodeId: id,
  });
}

export async function restartNode(id: string): Promise<void> {
  const node = await getNode(id);
  if (!node) return;
  await transition(id, 'loading');

  if (node.target === 'local') {
    if (node.runtimeId) {
      await restartContainer(node.runtimeId);
    } else {
      // startNode already drives its own online transition + fast-poller; the
      // shared finalize below is a no-op re-affirm in that case.
      await startNode(id);
    }
    const now = Date.now();
    startedAt.set(id, now);
    // H-1: route the final online state through transition(), not a bare
    // updateNode(). transition() owns the fast-poller lifecycle (startFastPoll
    // on online, stopFastPoll otherwise). A bare updateNode here leaves the
    // poller started by transition(id,'loading') above in an unmanaged state —
    // it self-stops on the grace window but is never re-affirmed, so a restart
    // landing during another node's grace window could race its own teardown.
    await updateNode(id, { startedAt: new Date(now).toISOString() });
    await transition(id, 'online');
  } else {
    const creds = sshKeyring.get(id);
    if (!creds) throw new Error('Please enter your SSH details again to restart this remote node.');
    await withSSH(creds, async (client) => {
      const sudo = await remoteSudo(client);
      const { code, stderr } = await runRemote(
        client,
        sudo + shellQuote(['docker', 'restart', containerName(id)]),
      );
      if (code !== 0) throw new Error(`Could not restart the node on the remote computer. Details: ${stderr.trim().slice(-400)}`);
    });
    const now = Date.now();
    startedAt.set(id, now);
    await updateNode(id, { startedAt: new Date(now).toISOString() });
    await transition(id, 'online');
  }

  await addEvent({
    kind: 'node-restarted',
    title: `Node ${node.moniker} restarted`,
    subtitle: '',
    relatedNodeId: id,
  });

  // Per-start republish: every restart counts as a fresh on-chain
  // attestation. Fire-and-forget — already gated through the same
  // pending/clear lifecycle as startNode.
  void updateNode(id, { specsPublishPending: true }).then(async () => {
    try {
      const { publishNodeSpecs } = await import('./node-specs');
      const res = await publishNodeSpecs(id, { force: true });
      if (!res.ok)
        log.warn('per-restart specs republish failed', { id, err: res.error });
    } catch (err) {
      log.warn('per-restart specs republish threw', { id, err: (err as Error).message });
    }
  });
}

export async function removeNode(id: string): Promise<void> {
  const node = await getNode(id);
  if (!node) return;

  if (node.target === 'local') {
    if (node.runtimeId) {
      try {
        await removeContainer(node.runtimeId);
      } catch (err) {
        log.warn('removeContainer failed', { err: (err as Error).message });
      }
    }
    try {
      await fs.rm(nodeDataDir(id), { recursive: true, force: true });
    } catch (err) {
      log.warn('node data dir cleanup failed', {
        path: nodeDataDir(id),
        err: (err as Error).message,
      });
    }
  } else {
    const creds = sshKeyring.get(id);
    if (creds) {
      try {
        await withSSH(creds, async (client) => {
          const sudo = await remoteSudo(client);
          // Defence in depth: validate the id at the IPC boundary AND
          // shell-quote it here. A non-UUID id would otherwise let
          // user-controlled input break out of the rm path.
          if (!UUID_RE.test(id)) {
            throw new Error('refusing remote teardown for non-UUID node id');
          }
          const safeId = shellQuote([id]);
          // We keep `$HOME` literal so the remote shell expands it,
          // but the id itself is a quoted token now.
          await runRemote(
            client,
            sudo + shellQuote(['docker', 'rm', '-f', containerName(id)]) +
              ` ; rm -rf "$HOME/.sentinel-dvpnx/"${safeId} "/root/.sentinel-dvpnx/"${safeId} 2>/dev/null || true`,
          );
        });
      } catch (err) {
        log.warn('remote teardown failed', { err: (err as Error).message });
      }
    }
  }

  purgeNode(id);
  sshKeyring.delete(id);
  startedAt.delete(id);

  const store = await readStore();
  store.nodes = store.nodes.filter((n) => n.id !== id);
  delete store.logs[id];
  delete store.nodeBackups[id];
  await writeStore(store);
  broadcast(IPC.NODES_CHANGED, null);

  await addEvent({
    kind: 'node-removed',
    title: `Node ${node.moniker} removed`,
    subtitle: node.host ?? 'local',
    relatedNodeId: id,
  });
}

// ---------------------------------------------------------------------------
// Logs + live status
// ---------------------------------------------------------------------------

export async function recentLogs(id: string): Promise<string[]> {
  const node = await getNode(id);
  if (!node) return [];
  if (node.target === 'local') {
    if (node.runtimeId) {
      try {
        const lines = await containerLogs(node.runtimeId, 200);
        if (lines.length > 0) return lines;
      } catch (err) {
        // Best-effort: a docker-daemon-down or removed-container error
        // here would otherwise propagate into liveStatus and hide the
        // real container/onChain check that follows.
        log.debug('recentLogs local failed', { err: (err as Error).message });
      }
    }
  } else {
    const creds = sshKeyring.get(id);
    if (creds) {
      try {
        return await withSSH(creds, async (client) => {
          const sudo = await remoteSudo(client);
          const cmd = sudo + shellQuote(['docker', 'logs', '--tail', '200', containerName(id)]);
          const { stdout, stderr } = await runRemote(client, cmd);
          return (stdout + stderr).split(/\r?\n/).filter(Boolean);
        });
      } catch (err) {
        log.debug('recentLogs remote failed', { err: (err as Error).message });
      }
    }
  }
  // Fall back to whatever we last persisted in the store.
  const store = await readStore();
  return store.logs[id] ?? [];
}

export async function liveStatus(id: string): Promise<NodeLiveStatus> {
  const node = await getNode(id);
  if (!node) {
    return {
      nodeId: id,
      reachable: false,
      sessions: 0,
      bytesOut: 0,
      bytesIn: 0,
      uptimeMs: 0,
      logTail: [],
      activeSubscriptions: [],
      linkedPlans: [],
      error: 'Unknown node',
    };
  }

  const logTail = await recentLogs(id);
  const start = Date.now();
  const uptimeMs = node.startedAt ? Math.max(0, Date.now() - Date.parse(node.startedAt)) : 0;

  try {
    const { sentinel, stargate, disconnect } = await readClients();
    try {
      const nodeAddr = accountToNodeAddr(node.operatorAddress);
      const onChain = sentinel
        ? await withRpcTimeout(
            () => sentinel.node.node(nodeAddr),
            RPC_QUERY_TIMEOUT_MS,
            'node.node',
          ).catch(() => undefined)
        : undefined;
      const balanceCoin = await withRpcTimeout(
        () => stargate.getBalance(node.operatorAddress, DENOM),
        RPC_QUERY_TIMEOUT_MS,
        'getBalance',
      ).catch(() => ({ amount: '0' }));
      const chainHeight = await withRpcTimeout(
        () => stargate.getHeight(),
        RPC_QUERY_TIMEOUT_MS,
        'getHeight',
      ).catch(() => undefined);

      // "reachable" means the node is actually serving traffic: it is both
      // registered on-chain AND its local container is running. Without the
      // container check a stopped node stays marked reachable (the on-chain
      // registration record persists forever), which causes the poller to
      // flip the UI back to "online" after an explicit stop.
      let containerUp = true;
      if (node.target === 'local') {
        containerUp = node.runtimeId
          ? await withDockerTimeout(() => isRunning(node.runtimeId!), 5_000, 'isRunning').catch(
              () => false,
            )
          : false;
      }
      const reachable = Boolean(onChain) && containerUp;
      const earnings = udvpnToDvpn(balanceCoin.amount);

      // Sessions currently served by the node. The on-chain sessions index
      // is keyed by the operator's node address.
      let sessionsCount = 0;
      let bytesIn = 0;
      let bytesOut = 0;
      const activeSubscriptions: NodeSession[] = [];
      if (sentinel && reachable) {
        try {
          const res = await withRpcTimeout(
            () => sentinel.session.sessionsForNode(nodeAddr),
            RPC_QUERY_TIMEOUT_MS,
            'sessionsForNode',
          );
          // Only count sessions we could actually decode AND that are
          // marked STATUS_ACTIVE. The raw list includes winding-down and
          // already-ended sessions, which aren't "live subscribers".
          for (const raw of res.sessions) {
            const summary = summarizeSession(raw);
            if (!summary) continue;
            bytesIn += summary.bytesIn;
            bytesOut += summary.bytesOut;
            activeSubscriptions.push(summary);
            if (activeSubscriptions.length >= 20) break;
          }
          sessionsCount = activeSubscriptions.length;
        } catch (err) {
          log.debug('sessions query failed', { err: (err as Error).message });
        }
      }

      // Plans this node is linked into. We probe even when `reachable` is
      // false — a node can be linked into plans before it registers and the
      // operator wants to see that linkage in the UI to debug it.
      const linkedPlans = sentinel
        ? await withRpcTimeout(
            () => discoverPlansForNode(sentinel, nodeAddr),
            RPC_QUERY_TIMEOUT_MS,
            'discoverPlansForNode',
          ).catch(() => [] as NodePlanLink[])
        : [];

      // Chain status (active / active_pending / inactive).
      const chainStatusStr = onChain && onChain.status !== undefined ? String(onChain.status) : undefined;
      const lastStatusAt = onChain?.statusAt
        ? new Date(onChain.statusAt).toISOString()
        : undefined;

      // Persist only when changed (avoids write churn on every probe).
      const patch: Partial<typeof node> = {};
      if (earnings !== node.balanceDVPN) patch.balanceDVPN = earnings;
      if (reachable !== node.registeredOnChain) patch.registeredOnChain = reachable;
      if (!node.country) {
        const geoHost =
          node.target === 'remote'
            ? node.host
            : node.remoteUrl
              ? stripToHostSafe(node.remoteUrl)
              : undefined;
        if (geoHost) {
          const geo = await resolveCountry(geoHost);
          if (geo) {
            patch.country = geo.country;
            patch.countryName = geo.countryName;
          }
        }
      }
      if (Object.keys(patch).length) await updateNode(id, patch);

      return {
        nodeId: id,
        reachable,
        sessions: sessionsCount,
        bytesOut,
        bytesIn,
        uptimeMs,
        // M-15: carry the freshly-read balance so the sampler records this
        // probe's value, not the stale per-tick snapshot.
        earningsUdvpn: Math.round(earnings * 1_000_000),
        chainHeight,
        apiLatencyMs: Date.now() - start,
        logTail: logTail.slice(-100),
        chainStatus: chainStatusStr,
        chainAddress: nodeAddr,
        lastStatusAt,
        activeSubscriptions,
        linkedPlans,
      };
    } finally {
      disconnect();
    }
  } catch (err) {
    return {
      nodeId: id,
      reachable: false,
      sessions: 0,
      bytesOut: 0,
      bytesIn: 0,
      uptimeMs,
      logTail: logTail.slice(-100),
      activeSubscriptions: [],
      linkedPlans: [],
      error: (err as Error).message,
    };
  }
}

export function historyFor(id: string, window: MetricsWindow): MetricsSample[] {
  return history(id, window);
}

// ---------------------------------------------------------------------------
// Background poller — samples every node every 60s
// ---------------------------------------------------------------------------

export function startPoller(): void {
  if (poller) return;
  // Rehydrate startedAt from persisted DeployedNode records so uptime
  // survives app restarts. Also re-arm the fast-poller for any node that
  // was already mid-registration when the app last quit. Reap zombies first
  // so we don't spin up fast-pollers for nodes that will never come up.
  void reapZombieNodes()
    .catch((err) => log.warn('reap zombies failed', { err: (err as Error).message }))
    .then(listNodes)
    .then((nodes) => {
      for (const n of nodes) {
        if (n.startedAt) startedAt.set(n.id, Date.parse(n.startedAt));
        if (n.status === 'loading') startFastPoll(n.id);
      }
    });
  const tick = async () => {
    const nodes = await listNodes();
    for (const node of nodes) {
      try {
        const status = await liveStatus(node.id);
        broadcast(IPC.NODES_LIVE_STATUS, { nodeId: node.id, status });
        recordSample({
          nodeId: node.id,
          ts: Date.now(),
          peers: status.sessions,
          bytesIn: status.bytesIn,
          bytesOut: status.bytesOut,
          // M-15: prefer the balance read on this very probe; fall back to the
          // persisted snapshot only if the probe didn't return one.
          earningsUdvpn:
            status.earningsUdvpn ?? Math.round(node.balanceDVPN * 1_000_000),
          chainHeight: status.chainHeight,
          reachable: status.reachable,
        });

        // Health transitions:
        //   loading → online   on first successful probe (freshly-deployed
        //                      nodes sit in "Starting" until the chain sees
        //                      them register).
        //   online  → offline  when an online node becomes unreachable.
        // We deliberately do NOT promote `offline → online`. `offline` is
        // user-initiated (they clicked Stop) and must be sticky — the user
        // restarts it explicitly. Without this rule the poller flips a
        // stopped node back to online because the on-chain registration
        // record outlives the container.
        if (status.reachable && node.status === 'loading') {
          await transition(node.id, 'online');
          await addEvent({
            kind: 'node-online',
            title: `Node ${node.moniker} is online`,
            subtitle: 'Registered on chain',
            relatedNodeId: node.id,
          });
        } else if (
          // Container-up fallback: if a local node has had its container
          // running for >60s but on-chain registration hasn't landed yet
          // (RPC pool slow, indexer lag, chain mempool congested), we still
          // promote to `online` so the UI doesn't sit in "Starting" forever.
          // The next tick will flip it back to offline if the container drops.
          node.target === 'local' &&
          node.status === 'loading' &&
          node.runtimeId &&
          node.startedAt &&
          Date.now() - Date.parse(node.startedAt) > 60_000 &&
          (await withDockerTimeout(
            () => isRunning(node.runtimeId!),
            5_000,
            'isRunning',
          ).catch(() => false))
        ) {
          await transition(node.id, 'online');
          await addEvent({
            kind: 'node-online',
            title: `Node ${node.moniker} is online`,
            subtitle: 'Container running (chain registration pending)',
            relatedNodeId: node.id,
          });
        } else if (!status.reachable && node.status === 'online') {
          // Post-start grace: a freshly-started node won't appear on-chain
          // for ~30–90s while the registration tx propagates and indexers
          // catch up. Without this gate the very next poll fires a spurious
          // `node-unreachable` event on top of the user's `node-started`.
          const sinceStart = Date.now() - (startedAt.get(node.id) ?? 0);
          const POST_START_UNREACHABLE_GRACE_MS = 90_000;
          if (sinceStart < POST_START_UNREACHABLE_GRACE_MS) {
            log.debug('skip unreachable transition within post-start grace', {
              id: node.id,
              sinceStartMs: sinceStart,
            });
          } else {
            await transition(node.id, 'offline');
            await addEvent({
              kind: 'node-unreachable',
              title: `Node ${node.moniker} is unreachable`,
              subtitle: status.error ?? 'No on-chain status',
              relatedNodeId: node.id,
            });
          }
        }
      } catch (err) {
        log.debug('poll node failed', { id: node.id, err: (err as Error).message });
      }
    }
  };
  // Fire once shortly after startup so history charts have at least one point
  // by the time the user opens them.
  setTimeout(() => void tick(), 5_000);
  pollerTick = tick;
  void getSettings()
    .then((s) => armPoller(s.nodeRefreshIntervalSec))
    .catch(() => armPoller(60));
}

let pollerTick: (() => Promise<void>) | null = null;

function armPoller(intervalSec: number): void {
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
  if (!pollerTick) return;
  const ms = Math.max(15, Math.min(600, Math.round(intervalSec))) * 1000;
  poller = setInterval(() => {
    if (pollerTick) void pollerTick();
  }, ms);
}

/**
 * Re-arm the background poller at a new cadence. Called by the main
 * process when the user changes `nodeRefreshIntervalSec` in settings.
 * No-op if `startPoller` has not run yet.
 */
export function restartPollerCadence(intervalSec: number): void {
  armPoller(intervalSec);
}

export function stopPoller(): void {
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
  pollerTick = null;
  for (const id of Array.from(fastPollers.keys())) stopFastPoll(id);
}

// ---------------------------------------------------------------------------
// Node-level withdrawals (from node's own key)
// ---------------------------------------------------------------------------

export async function withdrawFromNode(
  nodeId: string,
  to: string,
  amountDVPN?: number,
): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  const node = await getNode(nodeId);
  if (!node) return { ok: false, error: 'Node not found' };

  // The operator key was generated in-app at deploy time and (by default)
  // backed up encrypted in safeStorage. To withdraw, we decrypt that
  // backup, build a signer, and issue a MsgSend via CosmJS — no need to
  // execute commands inside the container.
  const store = await readStore();
  const backup = store.nodeBackups[nodeId];
  if (!backup) {
    return {
      ok: false,
      error:
        'No encrypted backup of this node\'s operator mnemonic is in the app. Open Node Details and save the backup, then try again.',
    };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'OS keychain is unavailable — cannot decrypt the node backup.' };
  }

  let mnemonic: string;
  try {
    mnemonic = safeStorage.decryptString(Buffer.from(backup, 'base64'));
  } catch (err) {
    return { ok: false, error: `Could not decrypt node backup: ${(err as Error).message}` };
  }

  const amountUdvpn =
    amountDVPN && amountDVPN > 0
      ? Math.round(amountDVPN * 1_000_000)
      : Math.max(0, Math.floor(node.balanceDVPN * 1_000_000) - 3_000);
  if (amountUdvpn <= 0) {
    return { ok: false, error: 'Nothing to withdraw (balance under gas buffer).' };
  }

  try {
    const settings = await getSettings();
    const signer = await signerFromMnemonic(mnemonic);
    const [{ address: from }] = await signer.getAccounts();
    if (from !== node.operatorAddress) {
      return {
        ok: false,
        error: `Backup mnemonic derives to ${from} but the node's operator address is ${node.operatorAddress}.`,
      };
    }
    const { client, disconnect, url } = await signClient(signer);
    try {
      const actualChainId = await client.getChainId();
      if (actualChainId !== settings.chainId) {
        return {
          ok: false,
          error: `RPC ${url} reports chain ${actualChainId}, expected ${settings.chainId}.`,
        };
      }
      // Explicit StdFee — the bundled-cosmjs GasPrice instance check
      // rejects 'auto' here (same root cause as the app-wallet send path).
      const gas = 250_000;
      const feeUdvpn = String(Math.max(1, Math.ceil(gas * Number(settings.gasPriceUdvpn))));
      const fee = { amount: [{ denom: DENOM, amount: feeUdvpn }], gas: String(gas) };
      const result = await client.sendTokens(
        from,
        to,
        [{ denom: DENOM, amount: String(amountUdvpn) }],
        fee,
        `withdraw from ${node.moniker}`,
      );
      if (result.code !== 0) {
        await addEvent({
          kind: 'withdraw-failed',
          title: `Withdraw from ${node.moniker} failed`,
          subtitle: (result.rawLog ?? `code ${result.code}`).slice(0, 160),
          amountDVPN: -udvpnToDvpn(amountUdvpn),
          relatedNodeId: nodeId,
        });
        return { ok: false, error: result.rawLog ?? `Broadcast rejected (code ${result.code})` };
      }
      await addEvent({
        kind: 'withdraw-sent',
        title: `Withdrew from ${node.moniker}`,
        subtitle: `to ${to.slice(0, 10)}…${to.slice(-6)}`,
        amountDVPN: -udvpnToDvpn(amountUdvpn),
        relatedNodeId: nodeId,
        txHash: result.transactionHash,
      });
      return { ok: true, txHash: result.transactionHash };
    } finally {
      disconnect();
    }
  } catch (err) {
    const msg = (err as Error).message ?? 'Unknown error';
    await addEvent({
      kind: 'withdraw-failed',
      title: `Withdraw from ${node.moniker} failed`,
      subtitle: msg.slice(0, 160),
      relatedNodeId: nodeId,
    });
    return { ok: false, error: msg };
  }
}

/**
 * Broadcast MsgUpdateNodeDetails for a deployed node, keeping moniker +
 * remote addr + service type but rewriting gigabyte / hourly prices.
 *
 * Returns the tx hash on success. Requires the encrypted backup mnemonic
 * we saved during deploy so we can sign with the node's operator key.
 */
export async function updateNodePricing(
  nodeId: string,
  gigabytePriceDVPN: number,
  hourlyPriceDVPN: number,
  opts: {
    priceMode?: 'flat' | 'oracle';
    usdGigabytePrice?: number;
    usdHourlyPrice?: number;
  } = {},
): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  const node = await getNode(nodeId);
  if (!node) return { ok: false, error: 'Node not found' };
  if (!(gigabytePriceDVPN >= 0) || !(hourlyPriceDVPN >= 0)) {
    return { ok: false, error: 'Prices must be non-negative' };
  }
  if (opts.priceMode === 'oracle') {
    if (!((opts.usdGigabytePrice ?? -1) >= 0) || !((opts.usdHourlyPrice ?? -1) >= 0)) {
      return {
        ok: false,
        error: 'Oracle pricing requires non-negative USD targets for GB and hour.',
      };
    }
  }

  const store = await readStore();
  const backup = store.nodeBackups[nodeId];
  if (!backup) {
    return {
      ok: false,
      error:
        'No encrypted backup of this node\'s mnemonic is in the app — can\'t sign a price update.',
    };
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

  const giga = Math.round(gigabytePriceDVPN * 1_000_000);
  const hour = Math.round(hourlyPriceDVPN * 1_000_000);
  const remoteAddr = node.remoteUrl ?? node.host ?? '127.0.0.1';

  try {
    const signer = await signerFromMnemonic(mnemonic);
    const [{ address: from }] = await signer.getAccounts();

    // One generous fee — MsgUpdateNodeDetails is similar weight to MsgSend.
    const settings = await getSettings();
    const gas = 250_000;
    const feeUdvpn = String(Math.max(1, Math.ceil(gas * Number(settings.gasPriceUdvpn))));
    const fee = { amount: [{ denom: DENOM, amount: feeUdvpn }], gas: String(gas) };
    const gbBase =
      opts.priceMode === 'oracle' ? formatBase(opts.usdGigabytePrice ?? 0) : '0';
    const hrBase =
      opts.priceMode === 'oracle' ? formatBase(opts.usdHourlyPrice ?? 0) : '0';
    // The SDK's signing-client helper reuses `args.from` as both the
    // CosmJS signer-address (used to look up the on-chain account, which
    // requires the `sent…` HRP) and the proto-message `from` field (which
    // the node module enforces as `sentnode…`). Those are two different
    // bech32 prefixes for the same 20-byte payload, so we have to bypass
    // the helper and construct the encode object manually: sign as the
    // operator (`sent…`), but populate the message with the node identity
    // (`sentnode…`).
    const updateMsg = {
      typeUrl: '/sentinel.node.v3.MsgUpdateNodeDetailsRequest',
      value: {
        from: accountToNodeAddr(from),
        gigabytePrices: [
          { denom: DENOM, baseValue: gbBase, quoteValue: String(giga) },
        ],
        hourlyPrices: [
          { denom: DENOM, baseValue: hrBase, quoteValue: String(hour) },
        ],
        remoteUrl: stripToHostSafe(remoteAddr),
      },
    };

    // Mainnet RPC reads of /auth/account can lag the canonical sequence by
    // a block or two (the read RPC and the broadcast RPC are independent
    // peers, and CosmJS pre-fetches sequence at signing time). Retry on
    // "account sequence mismatch" with a fresh signing client (which
    // re-reads the account) before giving up.
    const MAX_BROADCAST_ATTEMPTS = 4;
    const RETRY_DELAY_MS = 4_000;
    type BroadcastResult = { code: number; rawLog?: string; transactionHash: string };
    let result: BroadcastResult | null = null;
    let lastErr = '';
    for (let attempt = 1; attempt <= MAX_BROADCAST_ATTEMPTS; attempt++) {
      let opened: Awaited<ReturnType<typeof signClient>> | null = null;
      try {
        opened = await signClient(signer);
      } catch (connErr) {
        lastErr = (connErr as Error).message;
        // pickRPC() throws "Could not connect to the Sentinel network..." when every
        // configured RPC fails its health check in one window — on a flaky home
        // connection that can clear in a few seconds, so treat it as transient.
        const transient =
          /timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo|EAI_AGAIN|Could not connect to the Sentinel network|none responded/i.test(
            lastErr,
          );
        if (!transient || attempt === MAX_BROADCAST_ATTEMPTS) {
          break;
        }
        log.warn('updatePricing signClient connect failed, retrying', { attempt, err: lastErr.slice(0, 160) });
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      try {
        result = (await opened.client.signAndBroadcast(
          from,
          [updateMsg as never],
          fee,
          `update pricing ${node.moniker}`,
        )) as BroadcastResult;
      } catch (bcErr) {
        lastErr = (bcErr as Error).message;
        result = null;
        const transient = /timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|sequence mismatch/i.test(lastErr);
        if (!transient || attempt === MAX_BROADCAST_ATTEMPTS) {
          break;
        }
        log.warn('updatePricing broadcast threw, retrying', { attempt, err: lastErr.slice(0, 160) });
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      } finally {
        opened.disconnect();
      }
      if (result.code === 0) break;
      lastErr = result.rawLog ?? `code ${result.code}`;
      const transient = /account sequence mismatch|sequence mismatch/i.test(lastErr);
      if (!transient || attempt === MAX_BROADCAST_ATTEMPTS) break;
      log.warn('updatePricing sequence-mismatch, retrying', { attempt, err: lastErr.slice(0, 160) });
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }

    if (!result || result.code !== 0) {
      await addEvent({
        kind: 'withdraw-failed',
        title: `Pricing update failed: ${node.moniker}`,
        subtitle: lastErr.slice(0, 160),
        relatedNodeId: nodeId,
      });
      return { ok: false, error: lastErr || `Broadcast rejected` };
    }
    {
      await updateNode(nodeId, {
        gigabytePriceDVPN,
        hourlyPriceDVPN,
        priceMode: opts.priceMode ?? 'flat',
        usdGigabytePrice: opts.priceMode === 'oracle' ? opts.usdGigabytePrice : undefined,
        usdHourlyPrice: opts.priceMode === 'oracle' ? opts.usdHourlyPrice : undefined,
      });
      const priceLabel =
        opts.priceMode === 'oracle'
          ? `gigabyte=$${opts.usdGigabytePrice ?? 0} USD (fallback ${gigabytePriceDVPN} P2P) · hourly=$${opts.usdHourlyPrice ?? 0} USD (fallback ${hourlyPriceDVPN} P2P)`
          : `gigabyte=${gigabytePriceDVPN} P2P · hourly=${hourlyPriceDVPN} P2P`;
      await addEvent({
        kind: 'node-restarted', // re-use a neutral event kind
        title: `Pricing updated: ${node.moniker}`,
        subtitle: priceLabel,
        relatedNodeId: nodeId,
        txHash: result.transactionHash,
      });
      return { ok: true, txHash: result.transactionHash };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function stripToHostSafe(raw: string): string {
  let s = (raw ?? '').trim();
  s = s.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  const v6 = s.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (v6) return v6[1];
  const hp = s.match(/^([^:/]+):\d+$/);
  return hp ? hp[1] : s;
}

// Keep stable imports referenced (avoid unused-import lint noise).
void GasPrice;
void dvpnToUdvpn;
void containerName;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}
