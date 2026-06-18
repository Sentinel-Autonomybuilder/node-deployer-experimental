import { safeStorage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import TOML from '@iarna/toml';
import {
  IMAGE_TAG,
  IMAGE_VERSION,
  SENTINEL_DVPNX_DOCKERFILE,
  containerLogs,
  dockerHealth,
  ensureImage,
  hasImage,
  isRunning,
  runOnce,
  withDockerTimeout,
} from './docker';
import { getSettings } from './settings';
import { DENOM, DEFAULT_RPC_POOL } from './chain';
import { readStore, writeStore } from './store';
import { addEvent } from './events';
import { fetchBalance, generateNodeKey, sendTokens } from './wallet';
import { formatPrices } from './price';
import { ensureNodePersisted, getNode, nodeDataDir, rememberSSH, removeNode, startNode, updateNode } from './node-manager';
import { uploadFile, withSSH, runRemote, shellQuote } from './ssh';
import { captureLocalSpecs, publishNodeSpecs } from './node-specs';
import type { Client } from 'ssh2';
import { log } from './logger';
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/types';
import type {
  DeployPhase,
  DeployProgress,
  DeployRequest,
  DeployedNode,
} from '../../shared/types';

/**
 * Broadcast a node-list-changed event to every renderer. Uses the IPC enum
 * (NOT a raw 'nodes:changed' string) so it can never silently drift from the
 * preload `subscribe(IPC.NODES_CHANGED)` channel.
 */
function broadcastNodesChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.NODES_CHANGED, null);
  }
}

/**
 * Serializes all store-scrub read-modify-write cycles in this module.
 *
 * H-3: a deploy's async worker and `cancelDeploy()` run concurrently. When a
 * cancel fires mid-flight, the worker's on-error/on-cancel cleanup and
 * `purgeCancelledNode()` can both reach `readStore()`→filter→`writeStore()` at
 * the same time. Two unlocked read-modify-write cycles last-writer-wins, which
 * can resurrect a node one path just deleted (or drop an unrelated node added
 * between the read and the write). Chaining every scrub through this promise
 * makes them strictly sequential.
 */
let scrubChain: Promise<void> = Promise.resolve();

function scrubNodeFromStore(nodeId: string): Promise<void> {
  const run = scrubChain.then(async () => {
    const s = await readStore();
    const before = s.nodes.length;
    s.nodes = s.nodes.filter((x) => x.id !== nodeId);
    delete s.logs[nodeId];
    delete s.nodeBackups[nodeId];
    await writeStore(s);
    if (s.nodes.length !== before) broadcastNodesChanged();
  });
  // Keep the chain alive even if this scrub throws — a rejected link would
  // reject every future scrub. Swallow here; callers log their own context.
  scrubChain = run.catch(() => undefined);
  return run;
}

/**
 * Deploy orchestration.
 *
 *   Local path:
 *     1. dockerHealth() — verify daemon is reachable.
 *     2. ensureImage() — build sentinel-dvpnx image on first deploy.
 *     3. runOnce(`sentinel-dvpnx init`) — capture mnemonic + operator addr.
 *     4. Write structured TOML config into the node's host data dir.
 *     5. startNode() in node-manager — creates the long-running container.
 *
 *   Remote path (SSH):
 *     1. Connect + preflight (`docker --version`).
 *     2. Install Docker if missing (`curl get.docker.com | sh`).
 *     3. Pull / build the same image on the remote.
 *     4. Run `sentinel-dvpnx init` in a throwaway container; capture output.
 *     5. Upload the generated TOML via SFTP.
 *     6. Run the long-lived container with systemd-style restart.
 *
 * Both paths end with a verify step that waits ~30s for the node's first
 * on-chain heartbeat; if that doesn't land, we surface a warning but keep
 * the node (it will come up eventually and flip to online via the poller).
 */

/**
 * Amount of DVPN transferred from the app wallet into a freshly-deployed
 * node's operator address. Covers account creation + a generous runway of
 * on-chain status / session txs (each ~0.002 DVPN in gas).
 */
const OPERATOR_SEED_DVPN = 1;

/**
 * Gas headroom required on top of the seed amount for the MsgSend that funds
 * the operator. A MsgSend at the default gas price costs ~0.002 DVPN; we ask
 * for 0.05 to absorb gas-price spikes and leave the wallet with a non-zero
 * balance after the seed.
 */
const DEPLOY_GAS_BUFFER_DVPN = 0.05;

type ProgressFn = (p: DeployProgress) => void;
type PushFn = (
  phase: DeployPhase,
  percent: number,
  message: string,
  log: string,
  extras?: Partial<DeployProgress>,
) => void;

interface RunningJob {
  jobId: string;
  cancel: () => void;
  abort: AbortController;
  onProgress: ProgressFn;
  lockKey: string;
}

const jobs = new Map<string, RunningJob>();
// Last DeployProgress event seen per job, kept long enough for CLI clients
// to poll `deploy.status <jobId>` after a `deploy.start`. Cleared 60s after
// a terminal phase ('done' | 'error' | 'cancelled').
const lastProgress = new Map<string, DeployProgress>();
const TERMINAL_PHASES = new Set<DeployProgress['phase']>(['done', 'error', 'cancelled']);

export function getDeployProgress(jobId: string): DeployProgress | null {
  return lastProgress.get(jobId) ?? null;
}

export function listDeployProgress(): DeployProgress[] {
  return Array.from(lastProgress.values());
}

export async function startDeploy(
  req: DeployRequest,
  onProgress: ProgressFn,
): Promise<{ jobId: string; nodeId: string }> {
  const jobId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();

  // Concurrent-deploy guard. Two simultaneous deploys to the same target
  // race on the local Docker daemon and on the same data-dir prefix —
  // BuildKit can serialise at most one build per Dockerfile, and parallel
  // `docker run -p` against the same port crashes the second one with
  // "address already in use". Key the lock by target host so a remote +
  // local deploy can still run side-by-side.
  const lockKey = req.target === 'remote' ? `remote:${req.ssh?.host ?? ''}` : 'local';
  for (const j of jobs.values()) {
    if (j.lockKey === lockKey) {
      throw new Error(
        req.target === 'remote'
          ? `A node is already being deployed to ${req.ssh?.host}. Please wait for it to finish, or cancel it from the bar at the top of the window.`
          : 'A node is already being deployed on this computer. Please wait for it to finish, or cancel it from the bar at the top of the window.',
      );
    }
  }

  const store = await readStore();
  if (!store.wallet?.address) {
    throw new Error('You need a wallet first. Create a new wallet or restore one from a recovery phrase before deploying a node.');
  }

  // Cap concurrent local nodes. The chain treats nodes on the same public IP
  // as duplicates for directory ranking, and each extra node multiplies disk,
  // CPU, and bandwidth load on the host. Three is the soft ceiling we expose;
  // above that the UX falls apart even before docker complains.
  const MAX_LOCAL_NODES = 3;
  if (req.target === 'local') {
    const localCount = store.nodes.filter((n) => n.target === 'local').length;
    if (localCount >= MAX_LOCAL_NODES) {
      throw new Error(
        `This computer already has ${localCount} nodes running, which is the maximum (${MAX_LOCAL_NODES}). Please remove one from the Nodes page before deploying another.`,
      );
    }
    if (store.nodes.some((n) => n.target === 'local' && n.port === req.port)) {
      throw new Error(
        `Port ${req.port} is already used by one of your other nodes. Please pick a different port number.`,
      );
    }
  }
  if (!Number.isInteger(req.port) || req.port < 1024 || req.port > 65535) {
    throw new Error('The port must be a whole number between 1024 and 65535.');
  }

  // Balance preflight: the deploy flow seeds OPERATOR_SEED_DVPN from the app
  // wallet to the new operator address. Without this gate the chain rejects
  // the MsgSend with `insufficient funds` AFTER we've already burned work on
  // key generation, container builds, and the user's screen. Fail fast with
  // a clear, actionable message instead.
  const required = OPERATOR_SEED_DVPN + DEPLOY_GAS_BUFFER_DVPN;
  let liveBalance: number;
  try {
    liveBalance = await fetchBalance(store.wallet.address);
  } catch (err) {
    throw new Error(
      `Could not check your app wallet balance before deploying. ` +
        `Please check your internet connection and try again. Details: ${(err as Error).message}.`,
    );
  }
  if (liveBalance < required) {
    const short = (required - liveBalance).toFixed(4);
    throw new Error(
      `Your app wallet does not have enough P2P to start a new node. ` +
        `You have ${liveBalance.toFixed(4)} P2P. You need ${required.toFixed(2)} P2P ` +
        `(${OPERATOR_SEED_DVPN} P2P to start the node, plus a tiny ${DEPLOY_GAS_BUFFER_DVPN.toFixed(2)} P2P for network fees). ` +
        `Add at least ${short} more P2P to the app wallet, then try again.`,
    );
  }

  // Mint the node's own operator key locally (24-word mnemonic, same HD
  // path as the app wallet but from independent entropy). We'll display
  // the mnemonic once on the Progress screen AND save an encrypted backup
  // to safeStorage so node-level withdrawals work without SSH later.
  const { mnemonic: nodeMnemonic, address: operatorAddress } = await generateNodeKey();

  const node: DeployedNode = {
    id: nodeId,
    name: req.moniker,
    moniker: req.moniker,
    target: req.target,
    host: req.ssh?.host,
    status: 'loading',
    region: req.target === 'remote' ? req.ssh?.host ?? 'Remote' : 'This device',
    createdAt: new Date().toISOString(),
    operatorAddress,
    balanceDVPN: 0,
    port: req.port,
    gigabytePriceDVPN: req.gigabytePriceDVPN,
    hourlyPriceDVPN: req.hourlyPriceDVPN,
    priceMode: req.priceMode ?? 'flat',
    usdGigabytePrice: req.usdGigabytePrice,
    usdHourlyPrice: req.usdHourlyPrice,
    serviceType: req.serviceType,
    registeredOnChain: false,
    remoteUrl: req.remoteUrl,
  };
  await ensureNodePersisted(node);

  // Auto-backup the node mnemonic encrypted in app. The user can also
  // write it down from the Progress screen; this is the convenience path
  // so Withdraw works out of the box.
  if (safeStorage.isEncryptionAvailable()) {
    const s = await readStore();
    s.nodeBackups[nodeId] = safeStorage.encryptString(nodeMnemonic).toString('base64');
    await writeStore(s);
  }

  if (req.target === 'remote' && req.ssh) {
    rememberSSH(nodeId, req.ssh);
  }

  await addEvent({
    kind: 'deploy-started',
    title: `Deploying ${req.moniker}`,
    subtitle: req.target === 'remote' ? `Remote · ${req.ssh?.host}` : 'Local device',
    relatedNodeId: nodeId,
  });

  let cancelled = false;
  const abort = new AbortController();
  jobs.set(jobId, {
    jobId,
    cancel: () => {
      cancelled = true;
      abort.abort();
    },
    abort,
    onProgress,
    lockKey,
  });

  // Carry the mnemonic only on the FIRST non-error frame (so the renderer's
  // seed-phrase modal opens immediately at deploy start) and on the terminal
  // 'done' frame (so callers that miss the first frame still see it). Every
  // intermediate frame omits it: cuts seed exposure in IPC traffic from O(N)
  // frames to 2, while keeping the existing renderer flow unchanged.
  let mnemonicEmitted = false;
  // M-12: the remote spec-publish runs as a fire-and-forget IIFE that emits
  // several more `push('done', …)` log frames after the first terminal 'done'.
  // Each previously (a) stacked a fresh 60s lastProgress-delete timer and
  // (b) re-attached the mnemonic to every 'done' broadcast, widening the IPC
  // exposure window on each spec update. We still must carry the mnemonic on
  // the FIRST 'done' frame — the renderer (Progress.tsx) reads it off the
  // terminal frame in case it missed the earlier non-terminal one. So: carry
  // on the first eligible frame OR the first 'done', whichever comes first,
  // but never on a repeat 'done'. Likewise arm the cleanup timer exactly once.
  let doneMnemonicEmitted = false;
  let terminalTimerArmed = false;
  const push: PushFn = (phase, percent, message, log, extras = {}) => {
    if (cancelled && phase !== 'error') return;
    const isFirstDone = phase === 'done' && !doneMnemonicEmitted;
    if (phase === 'done') doneMnemonicEmitted = true;
    const carryMnemonic =
      phase !== 'error' &&
      phase !== 'cancelled' &&
      (!mnemonicEmitted || isFirstDone);
    if (carryMnemonic) mnemonicEmitted = true;
    const progress: DeployProgress = {
      jobId,
      nodeId,
      phase,
      percent,
      message,
      log: scrubLog(log),
      ...(carryMnemonic
        ? { mnemonicForBackup: nodeMnemonic, operatorAddress }
        : {}),
      ...extras,
    };
    lastProgress.set(jobId, progress);
    if (TERMINAL_PHASES.has(phase) && !terminalTimerArmed) {
      terminalTimerArmed = true;
      setTimeout(() => lastProgress.delete(jobId), 60_000).unref?.();
    }
    onProgress(progress);
  };

  void (async () => {
    try {
      // Fund the operator address from the app wallet BEFORE the node
      // starts. Cosmos accounts are created lazily on first incoming
      // transaction; without this step the node errors out at startup with
      // "account does not exist" while trying to query its own account
      // info, and the container restart-loops forever.
      push('preflight', 1, 'Sending 1 P2P to the new node', `[${ts()}] sending ${OPERATOR_SEED_DVPN} P2P from app wallet → ${operatorAddress}`);
      const fund = await sendTokens({
        to: operatorAddress,
        amountDVPN: OPERATOR_SEED_DVPN,
        memo: `seed ${node.moniker}`,
      });
      if (!fund.ok) {
        throw new Error(
          `Could not send P2P to the new node: ${fund.error ?? 'unknown error'}. ` +
            (fund.errorCode === 'insufficient-funds'
              ? `Your app wallet needs at least ${OPERATOR_SEED_DVPN} P2P (plus a small amount for network fees) before you can start a new node.`
              : ''),
        );
      }
      push('preflight', 3, 'New node funded', `[${ts()}] tx ${fund.txHash?.slice(0, 16)}… · height ${fund.height}`);

      if (req.target === 'remote') {
        await runRemoteDeploy(req, node, nodeMnemonic, push, () => cancelled, abort.signal);
      } else {
        await runLocalDeploy(req, node, nodeMnemonic, push, () => cancelled, abort.signal);
      }
      if (cancelled) {
        await purgeCancelledNode(nodeId);
        return;
      }
      // push() adds mnemonicForBackup + operatorAddress for 'done' automatically.
      push('done', 100, 'Node is online', `[${ts()}] ${node.moniker} is online on port ${node.port}.`);
      await addEvent({
        kind: 'deploy-succeeded',
        title: `Node ${node.moniker} is online`,
        subtitle: req.target === 'remote' ? `Remote · ${req.ssh?.host}` : 'Local device',
        relatedNodeId: nodeId,
      });
      // Remote deploys construct the container directly via SSH-driven
      // `docker run` and never pass through startNode, so the `node-started`
      // emit baked into startNode never fires for them. Emit it here for
      // remote-only — local deploys already get one from startNode at the
      // verified-container-up gate.
      if (req.target === 'remote') {
        await addEvent({
          kind: 'node-started',
          title: `Node ${node.moniker} started`,
          subtitle: `Remote · ${req.ssh?.host}`,
          relatedNodeId: nodeId,
        });
      }

      // Mark the node as awaiting on-chain spec publish; the actual broadcast
      // is fire-and-forget so a transient RPC outage doesn't make `deploy`
      // look like it failed. The startup replay path picks up anything that
      // didn't make it through.
      //
      // Only remote deploys publish from here. Local deploys go through
      // startNode at the verified-container-up gate, which already triggers
      // republishSpecs(); double-publishing would race the same tx into the
      // mempool and trip the "tx already exists in cache" path.
      if (req.target === 'remote') {
        void updateNode(nodeId, { specsPublishPending: true });
        void (async () => {
          try {
            // Give the new operator account time for the seed-funding tx to
            // fully propagate across the RPC pool. 5s was too short — many
            // RPCs still returned `account does not exist` and bailed. 12s
            // catches the slowest peers; the fresh-account error is also
            // now in TRANSIENT_ERR so any residual lag retries cleanly.
            await new Promise((r) => setTimeout(r, 12_000));
            push(
              'done',
              100,
              'Node is online',
              `[${ts()}] Publishing hardware specs on-chain (specs:v1)…`,
            );
            const specsRes = await publishNodeSpecs(nodeId, { force: true });
            if (specsRes.ok) {
              push(
                'done',
                100,
                'Node is online',
                `[${ts()}] Specs reported on-chain · tx ${specsRes.txHash?.slice(0, 16)}…`,
              );
            } else {
              log.warn('specs publish skipped', { nodeId, err: specsRes.error });
            }
          } catch (specsErr) {
            log.warn('specs publish threw', { nodeId, err: (specsErr as Error).message });
          }
        })();
      }
    } catch (err) {
      const msg = (err as Error).message ?? 'Unknown error';
      log.error('deploy failed', { id: nodeId, err: msg });
      if (cancelled) {
        await purgeCancelledNode(nodeId);
      } else {
        push('error', 0, 'Deployment failed', `[${ts()}] ${msg}`);
        await addEvent({
          kind: 'deploy-failed',
          title: `Deployment failed: ${node.moniker}`,
          subtitle: msg.slice(0, 180),
          relatedNodeId: nodeId,
        });
        // Drop the failed node from the inventory so the user isn't left
        // with a zombie entry. Any transient backup / logs / metrics for
        // the nodeId are purged too. Routed through the serialized scrub
        // (H-3) so it can't race a concurrent cancel's cleanup.
        try {
          await scrubNodeFromStore(nodeId);
        } catch (cleanupErr) {
          log.warn('failed-deploy cleanup errored', { err: String(cleanupErr) });
        }
      }
    } finally {
      jobs.delete(jobId);
    }
  })();

  return { jobId, nodeId };
}

export function cancelDeploy(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  const onProgress = job.onProgress;
  job.cancel();
  jobs.delete(jobId);
  const prev = lastProgress.get(jobId);
  const cancelled: DeployProgress = prev
    ? {
        ...prev,
        phase: 'cancelled',
        message: 'Cancelled',
        log: `[${ts()}] Deploy cancelled by user.`,
        // Strip any seed material from the cancelled frame — the renderer
        // already cached it on the first non-error frame, and broadcasting
        // it again on every cancel just widens the IPC exposure window.
        mnemonicForBackup: undefined,
      }
    : {
        jobId,
        nodeId: '',
        phase: 'cancelled',
        percent: 0,
        message: 'Cancelled',
        log: `[${ts()}] Deploy cancelled by user.`,
      };
  lastProgress.set(jobId, cancelled);
  setTimeout(() => lastProgress.delete(jobId), 60_000).unref?.();
  // Broadcast the cancelled frame so the renderer's IPC.DEPLOY_PROGRESS
  // subscriber updates immediately. Without this the Topbar chip and the
  // Progress screen only flip to 'cancelled' if a poll happens to fire.
  try {
    onProgress(cancelled);
  } catch (e) {
    log.warn('cancel broadcast failed', { jobId, err: String(e) });
  }
  return true;
}

/**
 * Tear down everything a cancelled deploy may have created so the user isn't
 * left with a zombie node entry, a half-built container, or a populated
 * remote data dir. Routes through removeNode (which handles container
 * removal, data-dir cleanup, remote SSH teardown) and broadcasts a
 * NODES_CHANGED so the UI refreshes immediately.
 */
async function purgeCancelledNode(nodeId: string): Promise<void> {
  try {
    await removeNode(nodeId);
  } catch (err) {
    log.warn('cancelled-deploy cleanup failed', { nodeId, err: String(err) });
    // Belt-and-braces: even if removeNode threw mid-way, scrub the store
    // entry so the renderer doesn't keep showing a phantom 'loading' node.
    // Serialized (H-3) so it can't race the on-error cleanup path.
    try {
      await scrubNodeFromStore(nodeId);
    } catch (storeErr) {
      log.warn('cancelled-deploy store scrub failed', { nodeId, err: String(storeErr) });
    }
  }
}

// ---------------------------------------------------------------------------
// LOCAL
// ---------------------------------------------------------------------------

// Re-probe the Docker daemon between long-running phases. A daemon that died
// or was restarted (Docker Desktop "Reset to factory defaults", a Windows
// update, OOM kill) mid-deploy will surface as a cryptic ECONNREFUSED on the
// next dockerode call — sometimes minutes after the user actually lost the
// daemon. Failing fast with a specific message saves the user from staring
// at a stalled container-wait.
async function recheckDockerDaemon(): Promise<void> {
  const health = await dockerHealth();
  if (!health.reachable) {
    throw new Error(
      `Docker stopped responding while the node was being deployed (${health.error}). ` +
        `Please restart Docker Desktop and try again.`,
    );
  }
}

async function runLocalDeploy(
  req: DeployRequest,
  node: DeployedNode,
  nodeMnemonic: string,
  push: PushFn,
  isCancelled: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  push('docker-check', 6, 'Checking Docker', `[${ts()}] Checking that Docker is running…`);
  const health = await dockerHealth();
  if (!health.reachable) {
    const hint =
      health.reason === 'desktop-not-running'
        ? 'Docker Desktop is installed, but it is not running. Open Docker Desktop and wait for it to start, then try again.'
        : health.reason === 'engine-not-running'
          ? 'Start the Docker service on this computer (run `sudo systemctl start docker`), then try again.'
          : 'You need to install Docker first. Install Docker Desktop (Windows or Mac) or Docker Engine (Linux), then try again.';
    throw new Error(`Docker is not running. ${hint} Details: ${health.error}.`);
  }
  push('docker-check', 10, 'Docker is running', `[${ts()}] Docker ${health.version}`);

  // Capture the host hardware snapshot up front so we have it ready for
  // the post-deploy on-chain `specs:v1` publish. Probe failure is non-fatal.
  try {
    const specs = await captureLocalSpecs();
    await updateNode(node.id, { specs });
  } catch (specErr) {
    log.warn('local spec capture failed', { id: node.id, err: (specErr as Error).message });
  }

  if (isCancelled()) return;
  const imageCached = await hasImage(IMAGE_TAG);
  if (imageCached) {
    push(
      'image-build',
      45,
      'Node image cached',
      `[${ts()}] ${IMAGE_TAG} already in local store — skipping build`,
    );
  } else {
    push(
      'image-build',
      12,
      'Preparing node image',
      `[${ts()}] tag=${IMAGE_TAG} (first build can take 5–15 min; cached thereafter)`,
    );
    try {
      await ensureImage(
        IMAGE_TAG,
        (line) => push('image-build', 36, 'Preparing node image', line),
        signal,
      );
    } catch (buildErr) {
      if (isCancelled() || signal.aborted) {
        throw new Error('You cancelled the deploy while the node image was building.');
      }
      throw buildErr;
    }
  }

  if (isCancelled()) return;
  // Docker Desktop sometimes restarts during a long image build (Windows
  // updates, OOM kills, user-initiated reset). Re-probe before any further
  // dockerode call so the user gets a precise error instead of a hang.
  await recheckDockerDaemon();
  const dataDir = nodeDataDir(node.id);
  await fs.mkdir(dataDir, { recursive: true });

  // 1. Pre-seed the node's keyring with our app-generated mnemonic, via
  //    `sentinelhub keys add --recover`. This runs in a throwaway
  //    container sharing the same host data dir; `dvpnx start` will pick
  //    up the operator key on launch.
  //
  // We write the mnemonic to a temp file inside the bind-mounted host
  // dir and have a shell pipe it into sentinelhub's stdin. The previous
  // implementation used Docker's AttachStdin, which is unreliable on
  // Windows / Docker Desktop named pipes — the EOF would sometimes not
  // propagate, and `--recover` would block forever waiting for input.
  // The deploy would then sit at "Seeding node keyring" indefinitely.
  // Reading from a file removes that whole class of failure.
  push('keygen', 55, 'Seeding node keyring', `[${ts()}] sentinelhub keys add --recover (name=operator)`);
  const mnemonicFile = path.join(dataDir, '.mnemonic.tmp');
  await fs.writeFile(mnemonicFile, `${nodeMnemonic}\n`, { mode: 0o600 });
  // Inside the container, the host data dir is mounted at /root/.sentinel-dvpnx.
  // We use /bin/sh -c "...; rm -f tmp" so the secret is removed before the
  // container exits even if sentinelhub fails. Belt-and-braces: we also unlink
  // the host-side tempfile in a `finally` below.
  const HUB_BIN = '/usr/local/bin/sentinelhub';
  const innerCmd =
    `${HUB_BIN} keys add operator --keyring-backend test ` +
    `--keyring-dir /root/.sentinel-dvpnx --recover --output json ` +
    `< /root/.sentinel-dvpnx/.mnemonic.tmp; rc=$?; ` +
    `rm -f /root/.sentinel-dvpnx/.mnemonic.tmp; exit $rc`;
  let keygen: { exitCode: number; output: string };
  try {
    keygen = await runOnce({
      hostDataDir: dataDir,
      imageTag: IMAGE_TAG,
      entrypoint: ['/bin/sh', '-c'],
      cmd: [innerCmd],
      onLog: (line) => push('keygen', 62, 'Seeding node keyring', line),
      timeoutMs: 90_000,
      signal,
    });
  } finally {
    await fs.unlink(mnemonicFile).catch(() => undefined);
  }
  if (keygen.exitCode === -1) {
    throw new Error('You cancelled the deploy while the node was creating its key.');
  }
  if (keygen.exitCode === 124) {
    throw new Error(
      'Creating the node key took too long (over 90 seconds). Docker Desktop is running, but the helper container did not finish. Please restart Docker Desktop and try deploying again.',
    );
  }
  if (keygen.exitCode !== 0) {
    throw new Error(
      `The node could not create its key. Details: ${keygen.output.trim().slice(-400)}`,
    );
  }

  // 2. Write canonical TOML config into the node's host data dir.
  if (isCancelled()) return;
  push('configure', 72, 'Writing node config', `[${ts()}] operator=${node.operatorAddress}`);
  await writeConfigToml(path.join(dataDir, 'config.toml'), {
    moniker: node.moniker,
    port: node.port,
    serviceType: node.serviceType,
    gigabytePriceUdvpn: Math.round(req.gigabytePriceDVPN * 1_000_000),
    hourlyPriceUdvpn: Math.round(req.hourlyPriceDVPN * 1_000_000),
    priceMode: req.priceMode ?? 'flat',
    usdGigabytePrice: req.usdGigabytePrice,
    usdHourlyPrice: req.usdHourlyPrice,
    remoteUrl: node.remoteUrl ?? `127.0.0.1:${node.port}`,
    keyName: 'operator',
  });

  // 3. Run `dvpnx init` to generate TLS cert + service dir. Our config.toml
  //    (written above) carries moniker / prices / service / keyring; we
  //    intentionally skip --force so init respects those values. The one
  //    flag upstream marks as required on the command line is
  //    --node.remote-addrs.
  if (isCancelled()) return;
  push('configure', 78, 'Initializing node (TLS + service)', `[${ts()}] dvpnx init`);
  const initRes = await runOnce({
    hostDataDir: dataDir,
    imageTag: IMAGE_TAG,
    cmd: [
      'init',
      '--node.remote-addrs',
      stripToHost(node.remoteUrl ?? '127.0.0.1'),
    ],
    onLog: (line) => push('configure', 82, 'Initializing node (TLS + service)', line),
    timeoutMs: 120_000,
    signal,
  });
  if (initRes.exitCode === -1) {
    throw new Error('You cancelled the deploy while the node was setting itself up.');
  }
  if (initRes.exitCode === 124) {
    throw new Error('Setting up the node took too long (over 2 minutes). Please restart Docker Desktop and try deploying again.');
  }
  if (initRes.exitCode !== 0) {
    throw new Error(`The node could not finish setting itself up. Details: ${initRes.output.trim().slice(-400)}`);
  }

  // 4. Start the long-running container.
  if (isCancelled()) return;
  await recheckDockerDaemon();
  push('starting', 90, 'Starting node container', `[${ts()}] docker run ${IMAGE_TAG}`);
  await withDockerTimeout(() => startNode(node.id), 120_000, 'startNode');

  if (isCancelled()) return;
  push('verifying', 94, 'Waiting for node container', `[${ts()}] checking container state…`);
  // Poll the local container for proof-of-life: running + at least one log
  // line. We give it up to ~25s before falling back to the original blind
  // wait — this catches the most common failure mode (container exits with
  // a config error in the first second) and surfaces it as a clear deploy
  // error instead of a silent "node never came up" that the user would
  // only spot from the Nodes screen 30s later.
  const running = await getNode(node.id);
  const runtimeId = running?.runtimeId;
  const startedTs = Date.now();
  const HEARTBEAT_TIMEOUT_MS = 25_000;
  let liveSeen = false;
  while (Date.now() - startedTs < HEARTBEAT_TIMEOUT_MS) {
    if (isCancelled()) return;
    if (!runtimeId) break;
    try {
      const up = await withDockerTimeout(() => isRunning(runtimeId), 5_000, 'isRunning');
      if (!up) {
        // Container exited before we could verify it — pull last logs and
        // surface them so the user sees WHY (bad config, port in use, etc.)
        // instead of a generic "node not online" toast a minute later.
        const tail = (
          await withDockerTimeout(() => containerLogs(runtimeId, 80), 8_000, 'containerLogs')
        )
          .join('\n')
          .trim();
        throw new Error(
          `Node container exited shortly after start. Last logs:\n${tail.slice(-1200) || '(no output)'}`,
        );
      }
      const recent = await withDockerTimeout(
        () => containerLogs(runtimeId, 5),
        5_000,
        'containerLogs',
      );
      if (recent.length > 0) {
        liveSeen = true;
        push('verifying', 97, 'Node container is up', `[${ts()}] ${recent[recent.length - 1] ?? ''}`);
        break;
      }
    } catch (err) {
      // isRunning / containerLogs failure is non-fatal here unless we
      // already determined the container exited (re-thrown above). For
      // intermittent dockerode disconnects, just retry the loop.
      if ((err as Error).message?.startsWith('Node container exited')) throw err;
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  if (!liveSeen) {
    push(
      'verifying',
      96,
      'First heartbeat pending',
      `[${ts()}] container is up but the chain heartbeat may take a minute — the Nodes page will flip to online when it lands.`,
    );
  }
}

// ---------------------------------------------------------------------------
// REMOTE — Docker-based install.
// ---------------------------------------------------------------------------

async function runRemoteDeploy(
  req: DeployRequest,
  node: DeployedNode,
  nodeMnemonic: string,
  push: PushFn,
  isCancelled: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  if (!req.ssh) throw new Error('SSH credentials required for remote deploy');

  // Helper: wrap runRemote with our cancel signal + a per-step timeout, and
  // turn well-known result codes (124 timeout, -1 cancel) into thrown errors
  // with messages the user can act on. This mirrors the local-deploy
  // runOnce() error handling so the renderer surfaces the same vocabulary
  // regardless of which path the user took.
  const ssh = (
    client: Client,
    label: string,
    command: string,
    onLog?: (l: string) => void,
    extra: { stdin?: string; timeoutMs?: number } = {},
  ) =>
    runRemote(client, command, onLog, {
      stdin: extra.stdin,
      timeoutMs: extra.timeoutMs ?? 600_000,
      signal,
    }).then((res) => {
      if (res.code === -1) {
        throw new Error(`Deploy was cancelled while ${label}.`);
      }
      if (res.code === 124) {
        throw new Error(
          `${label} timed out after ${Math.round((extra.timeoutMs ?? 600_000) / 1000)}s on the remote host. Check connectivity and retry.`,
        );
      }
      return res;
    });

  push('connecting', 4, 'Opening secure shell', `[${ts()}] ${req.ssh.host}:${req.ssh.port}`);
  await withSSH(req.ssh, async (client) => {
    if (isCancelled()) return;
    push('preflight', 10, 'Checking remote host', `[${ts()}] uname + whoami + docker probe`);
    const uname = await ssh(client, 'checking remote host', 'uname -a', (l) => push('preflight', 12, 'Checking remote host', l), { timeoutMs: 30_000 });
    if (uname.code !== 0) throw new Error(`uname failed: ${uname.stderr.trim()}`);

    // Capture remote hardware snapshot for the post-deploy on-chain
    // `specs:v1` publish. Probe failure is non-fatal — deploy continues
    // and specs publishing is simply skipped.
    try {
      const cores = await ssh(client, 'probing remote cores', 'nproc', undefined, { timeoutMs: 10_000 });
      const memInfo = await ssh(client, 'probing remote memory', 'cat /proc/meminfo', undefined, { timeoutMs: 10_000 });
      const cpuInfo = await ssh(client, 'probing remote cpu', 'cat /proc/cpuinfo', undefined, { timeoutMs: 10_000 });
      const c = parseInt(cores.stdout.trim(), 10);
      const memTotalKb = memInfo.stdout.match(/^MemTotal:\s+(\d+)\s*kB/m);
      const cpuModel = cpuInfo.stdout.match(/^model name\s*:\s*(.+)$/m);
      if (Number.isFinite(c) && c > 0 && memTotalKb) {
        const r = Math.round(parseInt(memTotalKb[1], 10) / 1024);
        const cpu = (cpuModel?.[1] ?? 'Unknown CPU').replace(/\s+/g, ' ').trim().slice(0, 64);
        await updateNode(node.id, { specs: { cpu, c, cr: c, r, rr: r } });
      } else {
        log.warn('remote spec probe returned unexpected output', { id: node.id });
      }
    } catch (specErr) {
      log.warn('remote spec capture failed', { id: node.id, err: (specErr as Error).message });
    }

    const idRes = await ssh(client, 'checking remote host', 'id -u', undefined, { timeoutMs: 15_000 });
    const isRoot = idRes.stdout.trim() === '0';
    const sudo = isRoot ? '' : 'sudo -n ';
    push('preflight', 14, 'Checking remote host', `[${ts()}] uid=${idRes.stdout.trim()} sudo=${sudo ? 'yes' : 'no'}`);

    // Fail fast if a non-root user can't get passwordless sudo. Without
    // this preflight, every downstream `${sudo}…` step fails opaquely
    // and the user sees only the inner command's stderr.
    if (!isRoot) {
      const sudoProbe = await ssh(client, 'probing sudo', 'sudo -n true 2>&1', undefined, { timeoutMs: 15_000 });
      if (sudoProbe.code !== 0) {
        throw new Error(
          'Passwordless sudo is required for non-root deploys. ' +
          'Configure NOPASSWD sudo for this user (e.g. via /etc/sudoers.d) ' +
          'or deploy as root, then retry.',
        );
      }
    }

    const dockerProbe = await ssh(client, 'probing remote docker', 'docker --version 2>/dev/null || true', undefined, { timeoutMs: 15_000 });
    if (!/Docker version/i.test(dockerProbe.stdout)) {
      push('preflight', 22, 'Installing Docker', `[${ts()}] curl get.docker.com | sh`);
      const install = await ssh(
        client,
        'installing Docker',
        `curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && ${sudo}sh /tmp/get-docker.sh`,
        (l) => push('preflight', 28, 'Installing Docker', l),
        { timeoutMs: 600_000 },
      );
      if (install.code !== 0) {
        throw new Error(
          `Docker install failed: ${install.stderr.trim().slice(-400)}. If this is a non-root user, ensure passwordless sudo is configured, or install Docker manually and retry.`,
        );
      }
    }

    // Data-dir selection: root uses /root/.sentinel-dvpnx/<id>; non-root uses $HOME.
    // node.id is a UUIDv4 from crypto.randomUUID() but defence-in-depth: refuse
    // to interpolate anything that would let a malicious id escape the path.
    const NODE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!NODE_ID_RE.test(node.id)) {
      throw new Error('refusing remote deploy for non-UUID node id');
    }
    // The id is a known-safe token (regex-validated). The remaining literal
    // segment is also static. We deliberately do NOT shell-quote dataHost
    // wholesale because we need $HOME to expand on the remote shell.
    const dataHost = isRoot
      ? `/root/.sentinel-dvpnx/${node.id}`
      : `$HOME/.sentinel-dvpnx/${node.id}`;
    await ssh(client, 'creating remote data dir', `mkdir -p "${dataHost}"`, undefined, { timeoutMs: 15_000 });

    // 1. Build the image on the remote if missing. First build takes 10–15
    //    minutes (go compile of sentinel-dvpnx + sentinelhub + wasmvm).
    if (isCancelled()) return;
    push('image-build', 36, 'Building node image on remote', `[${ts()}] ${IMAGE_TAG} — first build: 10–15 min`);
    const buildCmd = `${sudo}docker image inspect ${shellQuote([IMAGE_TAG])} >/dev/null 2>&1 || ${sudo}docker build -t ${shellQuote([IMAGE_TAG])} --build-arg SENTINEL_DVPNX_VERSION=${shellQuote([IMAGE_VERSION])} - <<'EOF'\n${readBundledDockerfile()}\nEOF`;
    // Generous build window — first build is a Go compile of sentinel-dvpnx
    // + sentinelhub + a wasmvm download. 30 minutes covers slow VPSes and
    // mid-build container registry hiccups; cached rebuilds finish in <1s.
    const buildRes = await ssh(
      client,
      'building Docker image',
      buildCmd,
      (l) => push('image-build', 48, 'Building node image on remote', l),
      { timeoutMs: 30 * 60_000 },
    );
    if (buildRes.code !== 0) {
      throw new Error(
        `Docker build failed on remote: ${buildRes.stderr.trim().slice(-400)}`,
      );
    }

    // Expand $HOME for consistent absolute paths in SFTP + docker -v.
    // Use `printf %s` (not echo) so the shell only performs variable
    // expansion — no backslash interpretation, no globbing — and validate
    // the result against an absolute-path regex before using it downstream.
    const expand = await ssh(client, 'resolving remote data dir', `printf %s "${dataHost}"`, undefined, { timeoutMs: 15_000 });
    const expanded = expand.stdout.trim();
    const ABS_PATH_RE = /^\/[a-zA-Z0-9_./\-]+$/;
    const absDataHost = ABS_PATH_RE.test(expanded)
      ? expanded
      : dataHost.replace('$HOME', '/root');
    if (!ABS_PATH_RE.test(absDataHost) || absDataHost.includes('..')) {
      throw new Error(`refusing to use unsafe remote data path: ${absDataHost}`);
    }

    // 2. Seed the node's keyring with our app-generated mnemonic via
    //    sentinelhub keys add --recover (throwaway container).
    if (isCancelled()) return;
    push('keygen', 54, 'Seeding node keyring', `[${ts()}] sentinelhub keys add --recover`);
    // Pass the mnemonic via the SSH channel's stdin (then through
    // `docker run -i`'s stdin, then to `sentinelhub --recover`'s stdin)
    // instead of interpolating it into a shell `echo '...' | …` pipeline.
    // This keeps the secret out of the remote `ps` table, off the SSH
    // server's command log, and immune to quote-bearing input.
    const hubInner = [
      'docker',
      'run',
      '--rm',
      '-i',
      '-v',
      `${absDataHost}:/root/.sentinel-dvpnx`,
      '--entrypoint',
      'sentinelhub',
      IMAGE_TAG,
      'keys',
      'add',
      'operator',
      '--keyring-backend',
      'test',
      '--keyring-dir',
      '/root/.sentinel-dvpnx',
      '--recover',
      '--output',
      'json',
    ];
    const hubCmd = (sudo ? sudo : '') + shellQuote(hubInner);
    const keygen = await ssh(
      client,
      'seeding node keyring',
      hubCmd,
      (l) => push('keygen', 62, 'Seeding node keyring', l),
      { stdin: `${nodeMnemonic}\n`, timeoutMs: 90_000 },
    );
    if (keygen.code !== 0) {
      throw new Error(
        `Keyring seeding failed on remote: ${(keygen.stderr || keygen.stdout).trim().slice(-400)}`,
      );
    }

    // 3. Upload canonical TOML config via SFTP.
    if (isCancelled()) return;
    push('configure', 72, 'Writing node config', `[${ts()}] operator=${node.operatorAddress}`);
    const toml = buildConfigTomlString({
      moniker: node.moniker,
      port: node.port,
      serviceType: node.serviceType,
      gigabytePriceUdvpn: Math.round(req.gigabytePriceDVPN * 1_000_000),
      hourlyPriceUdvpn: Math.round(req.hourlyPriceDVPN * 1_000_000),
      priceMode: req.priceMode ?? 'flat',
      usdGigabytePrice: req.usdGigabytePrice,
      usdHourlyPrice: req.usdHourlyPrice,
      remoteUrl: node.remoteUrl ?? `${req.ssh!.host}:${node.port}`,
      keyName: 'operator',
    });
    await uploadFile(client, `${absDataHost}/config.toml`, toml);

    // 4. dvpnx init — generates TLS cert + per-service dir. Our config.toml
    //    was uploaded in step 3 and already carries moniker / prices /
    //    service-type / keyring settings; we intentionally skip --force so
    //    init reads and respects our config instead of overwriting it. The
    //    only flag we have to pass is --node.remote-addrs, which upstream
    //    marks as required on the command line (even if it's also in the
    //    config file — this is a MarkFlagRequired check, not a value check).
    if (isCancelled()) return;
    push('configure', 78, 'Initializing node (TLS + service)', `[${ts()}] dvpnx init`);
    const initInner = [
      'docker',
      'run',
      '--rm',
      '-v',
      `${absDataHost}:/root/.sentinel-dvpnx`,
      IMAGE_TAG,
      'init',
      '--node.remote-addrs',
      stripToHost(node.remoteUrl ?? req.ssh!.host),
    ];
    const initCmd = (sudo ? sudo : '') + shellQuote(initInner);
    const init = await ssh(
      client,
      'initializing node',
      initCmd,
      (l) => push('configure', 82, 'Initializing node (TLS + service)', l),
      { timeoutMs: 120_000 },
    );
    if (init.code !== 0) {
      throw new Error(
        `dvpnx init failed on remote: ${(init.stderr || init.stdout).trim().slice(-400)}`,
      );
    }

    // 5. Launch the long-running container with docker restart policy.
    if (isCancelled()) return;
    push('starting', 88, 'Starting node container on remote', `[${ts()}] docker run`);
    const runInner = [
      'docker',
      'run',
      '-d',
      '--name',
      `sentinel-dvpn-${node.id.slice(0, 12)}`,
      '--restart',
      'unless-stopped',
      '--cap-add',
      'NET_ADMIN',
      '--cap-add',
      'NET_RAW',
      '--device',
      '/dev/net/tun:/dev/net/tun',
      '-p',
      `${node.port}:${node.port}/udp`,
      '-p',
      `${node.port}:${node.port}/tcp`,
      '-v',
      `${absDataHost}:/root/.sentinel-dvpnx`,
      IMAGE_TAG,
      'start',
    ];
    const runCmd = (sudo ? sudo : '') + shellQuote(runInner);
    const run = await ssh(
      client,
      'starting node container',
      runCmd,
      (l) => push('starting', 92, 'Starting node container on remote', l),
      { timeoutMs: 60_000 },
    );
    if (run.code !== 0) {
      throw new Error(`docker run failed: ${run.stderr.trim().slice(-400)}`);
    }

    // Persist the container start time so uptime survives app restarts.
    {
      const s = await readStore();
      const n = s.nodes.find((x) => x.id === node.id);
      if (n) {
        n.startedAt = new Date().toISOString();
        await writeStore(s);
      }
    }

    push('verifying', 96, 'Waiting for first heartbeat', `[${ts()}] poller runs every 60s`);
  });
}

// ---------------------------------------------------------------------------
// Config emit (shared)
// ---------------------------------------------------------------------------

interface ConfigShape {
  moniker: string;
  port: number;
  serviceType: 'wireguard' | 'v2ray';
  /** udvpn fallback (oracle mode) OR literal udvpn price (flat mode). */
  gigabytePriceUdvpn: number;
  hourlyPriceUdvpn: number;
  /** Defaults to 'flat' if omitted — preserves current behaviour. */
  priceMode?: 'flat' | 'oracle';
  /** Required when priceMode === 'oracle'. */
  usdGigabytePrice?: number;
  usdHourlyPrice?: number;
  remoteUrl: string;
  keyName: string;
}

async function writeConfigToml(destPath: string, cfg: ConfigShape): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, buildConfigTomlString(cfg), 'utf8');
}

function buildConfigTomlString(cfg: ConfigShape): string {
  const settings = readSettingsSnapshot();
  // Matches the real sentinel-dvpnx config shape (keyring/rpc/tx/node/qos).
  const obj = {
    keyring: {
      // "test" backend matches what sentinelhub keys add --keyring-backend test
      // wrote during deploy. "file" would require a password prompt at every
      // node start which won't work under systemd / docker -d.
      backend: 'test',
      name: cfg.keyName,
    },
    query: {
      prove: false,
      retry_attempts: 5,
      retry_delay: '1s',
    },
    rpc: {
      addrs: settings.rpcUrls.length ? settings.rpcUrls : DEFAULT_RPC_POOL,
      chain_id: settings.chainId,
      timeout: '15s',
    },
    tx: {
      from_name: cfg.keyName,
      gas: 300_000,
      gas_adjustment: 1.15,
      gas_prices: `${settings.gasPriceUdvpn}${DENOM}`,
      broadcast_retry_attempts: 1,
      broadcast_retry_delay: '5s',
      query_retry_attempts: 30,
      query_retry_delay: '1s',
      simulate_and_execute: true,
    },
    handshake_dns: { enable: false, peers: 8 },
    node: {
      api_port: String(cfg.port),
      // Price entries serialized via formatPrices() — multi-denom would
      // need `;` (NOT `,`) and alphabetical denom ordering.
      //
      // Flat mode  → BASE=0, oracle disabled, node quotes the literal udvpn.
      // Oracle mode → BASE=USD target (LegacyDec), QUOTE=udvpn fallback used
      //   only when the on-chain Osmosis TWAP is unreachable.
      gigabyte_prices:
        cfg.priceMode === 'oracle'
          ? formatPrices([
              {
                denom: DENOM,
                base: cfg.usdGigabytePrice ?? 0,
                quote: cfg.gigabytePriceUdvpn,
              },
            ])
          : formatPrices([
              { denom: DENOM, base: '0', quote: cfg.gigabytePriceUdvpn },
            ]),
      hourly_prices:
        cfg.priceMode === 'oracle'
          ? formatPrices([
              {
                denom: DENOM,
                base: cfg.usdHourlyPrice ?? 0,
                quote: cfg.hourlyPriceUdvpn,
              },
            ])
          : formatPrices([
              { denom: DENOM, base: '0', quote: cfg.hourlyPriceUdvpn },
            ]),
      interval_best_rpc_addr: '5m0s',
      interval_geoip_location: '6h0m0s',
      interval_prices_update: '6h0m0s',
      interval_session_usage_sync_with_blockchain: '1h55m0s',
      interval_session_usage_sync_with_database: '2s',
      interval_session_usage_validate: '5s',
      interval_session_validate: '5m0s',
      interval_speedtest: '168h0m0s',
      interval_status_update: '55m0s',
      moniker: cfg.moniker,
      // validateRemoteAddr rejects anything but a bare IP or DNS name —
      // `net.ParseIP` / `govalidator.IsDNSName`. Strip scheme / port.
      remote_addrs: [stripToHost(cfg.remoteUrl)],
      service_type: cfg.serviceType,
    },
    oracle: {
      name: 'coingecko',
      coingecko: { api_key: '' },
      osmosis: { api_addr: 'https://api.osmosis.zone' },
    },
    qos: { max_peers: 250 },
  } as const;
  return TOML.stringify(obj as never);
}

// Snapshot to avoid an await inside buildConfigTomlString (caller already awaited).
// We keep a tiny in-module cache of the most recent settings read so the
// synchronous builder is safe.
let cachedSettings: {
  rpcUrls: string[];
  chainId: string;
  gasPriceUdvpn: string;
} | null = null;

function readSettingsSnapshot() {
  if (cachedSettings) return cachedSettings;
  // Fallback to defaults; the real values are injected by primeSettings() on
  // app startup.
  return {
    rpcUrls: [...DEFAULT_RPC_POOL],
    chainId: 'sentinelhub-2',
    gasPriceUdvpn: '0.1',
  };
}

export async function primeDeploySettings(): Promise<void> {
  const s = await getSettings();
  cachedSettings = {
    rpcUrls: s.rpcUrls,
    chainId: s.chainId,
    gasPriceUdvpn: s.gasPriceUdvpn,
  };
}

// ---------------------------------------------------------------------------
// Parsers + helpers
// ---------------------------------------------------------------------------

export function parseInitOutput(out: string): { mnemonic?: string; operatorAddress?: string } {
  // sentinel-dvpnx init prints the mnemonic after a "mnemonic" / "seed"
  // label (either on the same line after a colon, or on the next line).
  // The address is emitted as a bech32 string; match the first sent1… we
  // see.
  const addrMatch = out.match(/\bsent1[0-9a-z]{30,58}\b/);

  let mnemonic: string | undefined;
  const labelled = out.match(/(?:mnemonic|seed)[^:\n]*[:=]?\s*([\sa-z]{40,400})/i);
  if (labelled) {
    const words = labelled[1].trim().split(/\s+/).filter((w) => /^[a-z]+$/.test(w));
    if (words.length >= 12 && words.length <= 24) mnemonic = words.slice(0, 24).join(' ');
  }
  return {
    operatorAddress: addrMatch ? addrMatch[0] : undefined,
    mnemonic,
  };
}

function readBundledDockerfile(): string {
  return SENTINEL_DVPNX_DOCKERFILE;
}

/**
 * sentinel-dvpnx's validateRemoteAddr accepts either a bare IPv4/IPv6
 * (via net.ParseIP) or a DNS name (via govalidator.IsDNSName) — no scheme,
 * no port, no path. We normalize whatever the user (or our default) hands
 * in down to just the host part.
 */
export function stripToHost(raw: string): string {
  let s = (raw ?? '').trim();
  s = s.replace(/^[a-z]+:\/\//i, ''); // scheme
  s = s.replace(/\/+$/, '');           // trailing slash(es)
  // IPv6 wrapped in brackets, optionally with :port
  const v6 = s.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (v6) return v6[1];
  // host:port
  const hp = s.match(/^([^:\/]+):\d+$/);
  if (hp) return hp[1];
  return s;
}

function ts(): string {
  const d = new Date();
  return d.toISOString().split('T')[1]!.replace('Z', '');
}

// Final scrubber for anything we hand to the renderer. Belts-and-braces:
// strips ANSI/CSI escapes (with or without the leading ESC byte — sentinel-dvpnx
// emits zerolog's coloured logfmt and some pipelines drop the ESC), docker
// stream-multiplex frame headers that occasionally survive when an upstream
// command wasn't passed through stripDockerFrames, and trailing whitespace.
const ANSI_WITH_ESC = /\x1B\[[0-?]*[ -/]*[@-~]|\x9B[0-?]*[ -/]*[@-~]/g;
// Same SGR codes but with the ESC byte already lost (e.g. through a writer
// that drops control bytes). We restrict to the SGR final byte `m` so we
// don't accidentally eat legitimate `[42]` style content.
const ANSI_WITHOUT_ESC = /\[\d{1,3}(?:;\d{1,3})*m/g;
function scrubLog(s: string | undefined): string {
  if (!s) return '';
  return s
    .replace(ANSI_WITH_ESC, '')
    .replace(ANSI_WITHOUT_ESC, '')
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '')
    .trimEnd();
}
