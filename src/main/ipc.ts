import { BrowserWindow, app, dialog, ipcMain, safeStorage, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import AdmZip from 'adm-zip';
import {
  IPC,
  type AppSettings,
  type DeployProgress,
  type DeployRequest,
  type LocalSystemReport,
  type MetricsWindow,
  type MnemonicExportResult,
  type NodeLogExportRequest,
  type NodeLogExportResult,
  type NodeWithdrawRequest,
  type SSHCredentials,
  type SSHTestResult,
  type SendTxRequest,
  type UpdateNodePricingRequest,
} from '../shared/types';
import { testSSHConnection } from './services/ssh';
import { forgetHostKey } from './services/host-keys';
import { HOSTNAME_RE, vSSHCredentials, vUUID } from './validate';
import { publishNodeSpecs } from './services/node-specs';
import {
  startDeploy,
  cancelDeploy,
  primeDeploySettings,
  getDeployProgress,
  listDeployProgress,
} from './services/deploy';
import {
  getWallet,
  createWallet,
  restoreWallet,
  refreshWalletBalance,
  sendTokens,
  logoutWallet,
} from './services/wallet';
import {
  listNodes,
  getNode,
  removeNode,
  restartNode,
  startNode,
  stopNode,
  recentLogs,
  nodeStatus,
  nodeHistory,
  withdrawFromNode,
  updateNodePricing,
  reapStuckNow,
} from './services/nodes';
import { listEvents } from './services/events';
import { getSettings, updateSettings } from './services/settings';
import {
  startDockerDesktop,
  resetDockerClient,
  dockerOverview,
  stopAllSentinelContainers,
  pruneDangling,
  quitDockerDesktop,
  forceQuitDockerDesktop,
} from './services/docker';
import { healthAll, invalidateHealthCache } from './services/sentinel-client';
import { buildLocalSystemReport } from './services/system-report';
import { startLiveStats, stopLiveStats } from './services/live-stats';
import { logDir, log } from './services/logger';
import { readStore, writeStore } from './services/store';
import {
  getCliState,
  runFromApp,
  startCliServer,
  stopCliServer,
} from './services/cli-server';
import { spawn } from 'node:child_process';

// ─── IPC payload validators ──────────────────────────────────────────────────
//
// The renderer is sandboxed (contextIsolation), but we still treat every
// IPC payload as untrusted: a renderer compromise is the most likely
// attack vector for a desktop app. Validators throw on bad input so
// `ipcMain.handle` returns a structured error to the caller instead of
// silently passing malformed data into the service layer.

// Validators live in ./validate so the CLI registry (cli-registry.ts) shares
// the exact same bounds/charset checks (M-13). HOSTNAME_RE is re-used by the
// forget-host-key handler below.
function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

// Token-bucket rate limiter: protects expensive / state-changing IPC
// channels from a runaway renderer. Capacity = burst, refill = per-second.
// All limiter state lives in-process and resets on app restart.
type Bucket = { tokens: number; last: number };
const RATE_BUCKETS = new Map<string, Bucket>();
function rateOk(key: string, capacity: number, refillPerSec: number): boolean {
  const now = Date.now();
  const b = RATE_BUCKETS.get(key) ?? { tokens: capacity, last: now };
  const elapsed = (now - b.last) / 1000;
  b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
  b.last = now;
  if (b.tokens < 1) {
    RATE_BUCKETS.set(key, b);
    return false;
  }
  b.tokens -= 1;
  RATE_BUCKETS.set(key, b);
  return true;
}
function enforceRate(key: string, capacity: number, refillPerSec: number): void {
  if (!rateOk(key, capacity, refillPerSec)) {
    throw new Error('You\'re going a bit too fast. Please wait a few seconds and try again.');
  }
}

// Convert a thrown error into a user-safe message: strip stack frames,
// absolute paths (which may contain the OS username), and runaway length.
// The full error is still logged via the main-process logger for triage.
function toUserError(err: unknown, ctx?: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  let msg = raw.split('\n')[0] ?? raw;
  // Replace any Windows or POSIX absolute path with a placeholder.
  msg = msg.replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>');
  msg = msg.replace(/\/(?:home|Users|root|etc|var|tmp)\/[^\s'"]+/g, '<path>');
  if (msg.length > 400) msg = msg.slice(0, 400) + '…';
  if (ctx) log.warn(`ipc handler error: ${ctx}`, { err: String(err) });
  return msg;
}

async function reportLocalSystem(): Promise<LocalSystemReport> {
  return buildLocalSystemReport();
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.SYSTEM_REPORT, reportLocalSystem);
  ipcMain.handle(IPC.SYSTEM_LIVE_STATS_START, (e) => {
    startLiveStats(e.sender);
    return { ok: true };
  });
  ipcMain.handle(IPC.SYSTEM_LIVE_STATS_STOP, (e) => {
    stopLiveStats(e.sender);
    return { ok: true };
  });
  ipcMain.handle(IPC.DOCKER_START, async () => {
    const result = await startDockerDesktop();
    // Clear the cached Docker client so once the daemon finishes booting,
    // the next `dockerHealth()` re-probes sockets instead of returning
    // the stale "not reachable" client.
    resetDockerClient();
    return result;
  });
  ipcMain.handle(IPC.DOCKER_OVERVIEW, () => dockerOverview());
  ipcMain.handle(IPC.DOCKER_STOP_ALL_SENTINEL, () => stopAllSentinelContainers());
  ipcMain.handle(IPC.DOCKER_PRUNE, () => pruneDangling());
  ipcMain.handle(IPC.DOCKER_OPEN_SETTINGS, async () => {
    // Docker Desktop has no public deep-link to the Resources pane (the
    // `docker-desktop://` scheme only handles launch + OAuth callbacks),
    // so we just bring Docker Desktop itself to the front and the
    // renderer tells the user to navigate to Settings → Resources. On
    // Linux there is no Docker Desktop GUI.
    if (process.platform === 'linux') {
      return {
        ok: false,
        error: 'On Linux, Docker resources are configured via /etc/docker/daemon.json and a daemon restart.',
      };
    }
    const result = await startDockerDesktop();
    if (result.started) return { ok: true };
    return {
      ok: false,
      error: result.error ?? 'Docker Desktop could not be opened.',
    };
  });
  ipcMain.handle(IPC.DOCKER_QUIT, async () => {
    const result = await quitDockerDesktop();
    resetDockerClient();
    return result;
  });
  ipcMain.handle(IPC.DOCKER_FORCE_QUIT, async () => {
    const result = await forceQuitDockerDesktop();
    resetDockerClient();
    return result;
  });

  // -- Settings --------------------------------------------------------------
  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings());
  ipcMain.handle(IPC.SETTINGS_SET, async (_e, patch: Partial<AppSettings>) => {
    const next = await updateSettings(patch);
    invalidateHealthCache();
    await primeDeploySettings();
    return next;
  });
  ipcMain.handle(IPC.CHAIN_HEALTH, () => healthAll());

  // -- Wallet ----------------------------------------------------------------
  ipcMain.handle(IPC.WALLET_GET, () => getWallet());
  ipcMain.handle(IPC.WALLET_CREATE, () => createWallet());
  ipcMain.handle(IPC.WALLET_RESTORE, (_e, mnemonic: string) => restoreWallet(mnemonic));
  ipcMain.handle(IPC.WALLET_REFRESH_BALANCE, () => refreshWalletBalance());
  ipcMain.handle(IPC.WALLET_SEND, (_e, req: SendTxRequest) => {
    enforceRate('wallet-send', 5, 0.5); // 5 burst, ~one every 2s after that
    return sendTokens(req);
  });
  ipcMain.handle(IPC.WALLET_QR, (_e, text: string) =>
    QRCode.toString(text, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#0B1020', light: '#FFFFFF' },
    }),
  );
  ipcMain.handle(IPC.WALLET_LOGOUT, () => logoutWallet());

  // -- Events ----------------------------------------------------------------
  ipcMain.handle(IPC.EVENTS_LIST, (_e, limit?: number) => {
    const safeLimit =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? Math.min(Math.floor(limit), 1000)
        : undefined;
    return listEvents(safeLimit);
  });

  // -- SSH -------------------------------------------------------------------
  ipcMain.handle(
    IPC.SSH_TEST,
    (_e, creds: SSHCredentials): Promise<SSHTestResult> =>
      testSSHConnection(vSSHCredentials(creds)),
  );
  ipcMain.handle(
    IPC.SSH_FORGET_HOST_KEY,
    async (_e, req: { host: string; port?: number }) => {
      if (!req || typeof req !== 'object') throw new Error('Invalid forget-host-key request');
      const host = String(req.host ?? '');
      if (!HOSTNAME_RE.test(host)) throw new Error('Invalid SSH host');
      const port = Number(req.port ?? 22);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Invalid SSH port');
      }
      await forgetHostKey(host, port);
      return { ok: true };
    },
  );

  // -- Deploy ----------------------------------------------------------------
  ipcMain.handle(IPC.DEPLOY_START, async (_e, req: DeployRequest) => {
    enforceRate('deploy-start', 3, 0.2); // 3 burst, then 1 every 5s
    if (req && typeof req === 'object' && req.ssh) vSSHCredentials(req.ssh);
    await primeDeploySettings();
    return startDeploy(req, (progress: DeployProgress) => {
      broadcast(IPC.DEPLOY_PROGRESS, progress);
    });
  });
  ipcMain.handle(IPC.DEPLOY_CANCEL, (_e, jobId: string) => cancelDeploy(jobId));
  ipcMain.handle(IPC.DEPLOY_STATUS, (_e, jobId?: string) =>
    jobId ? getDeployProgress(jobId) : listDeployProgress(),
  );

  // -- Nodes -----------------------------------------------------------------
  ipcMain.handle(IPC.NODES_LIST, () => listNodes());
  ipcMain.handle(IPC.NODES_GET, (_e, id: string) => getNode(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_RESTART, (_e, id: string) => restartNode(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_STOP, (_e, id: string) => stopNode(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_START, (_e, id: string) => startNode(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_REMOVE, (_e, id: string) => removeNode(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_REAP_STUCK, () => reapStuckNow());
  ipcMain.handle(IPC.NODES_LOGS, (_e, id: string) => recentLogs(vUUID(id, 'node id')));
  ipcMain.handle(
    IPC.NODES_EXPORT_LOGS,
    async (_e, req: NodeLogExportRequest): Promise<NodeLogExportResult> =>
      exportNodeLogs(req),
  );
  ipcMain.handle(IPC.NODES_STATUS, (_e, id: string) => nodeStatus(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_HISTORY, (_e, id: string, window: MetricsWindow) =>
    nodeHistory(vUUID(id, 'node id'), window),
  );
  ipcMain.handle(IPC.NODES_WITHDRAW, async (_e, req: NodeWithdrawRequest) => {
    enforceRate('nodes-withdraw', 5, 0.5);
    vUUID(req?.nodeId, 'node id');
    const store = await readStore();
    const to = req.to ?? store.wallet?.address;
    if (!to) return { ok: false, error: 'No destination: app wallet not set up.' };
    return withdrawFromNode(req.nodeId, to, req.amountDVPN);
  });
  ipcMain.handle(IPC.NODES_UPDATE_PRICING, async (_e, req: UpdateNodePricingRequest) => {
    enforceRate('nodes-update-pricing', 5, 0.5);
    vUUID(req?.nodeId, 'node id');
    return updateNodePricing(req.nodeId, req.gigabytePriceDVPN, req.hourlyPriceDVPN, {
      priceMode: req.priceMode,
      usdGigabytePrice: req.usdGigabytePrice,
      usdHourlyPrice: req.usdHourlyPrice,
    });
  });
  ipcMain.handle(
    IPC.NODES_PUBLISH_SPECS,
    async (_e, nodeId: string, opts?: { force?: boolean }) => {
      enforceRate('nodes-publish-specs', 3, 0.2); // self-MsgSend on chain — keep tight
      return publishNodeSpecs(vUUID(nodeId, 'node id'), {
        force: !!opts?.force,
      });
    },
  );

  ipcMain.handle(IPC.NODES_BACKUP_MNEMONIC, async (_e, nodeId: string, mnemonic: string) => {
    const id = vUUID(nodeId, 'node id');
    if (typeof mnemonic !== 'string' || !mnemonic.trim()) {
      return { ok: false, error: 'No mnemonic to back up.' };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS keychain unavailable — cannot back up.' };
    }
    const blob = safeStorage.encryptString(mnemonic).toString('base64');
    if (!blob) {
      return { ok: false, error: 'Encryption produced an empty blob — backup aborted.' };
    }
    const store = await readStore();
    store.nodeBackups[id] = blob;
    await writeStore(store);
    return { ok: true };
  });

  ipcMain.handle(
    IPC.NODES_EXPORT_MNEMONIC,
    async (_e, nodeId: string, mnemonic: string): Promise<MnemonicExportResult> => {
      vUUID(nodeId, 'node id');
      if (typeof mnemonic !== 'string' || !mnemonic.trim()) {
        return { ok: false, error: 'No mnemonic to export.' };
      }
      const date = new Date().toISOString().split('T')[0];
      const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Export recovery phrase',
        defaultPath: `sentinel-recovery-${nodeId.slice(0, 8)}-${date}.txt`,
        filters: [{ name: 'Text file', extensions: ['txt'] }],
      });
      if (canceled || !filePath) return { ok: false, cancelled: true };
      try {
        const body =
          `# Sentinel node recovery phrase\n` +
          `# Node: ${nodeId}\n` +
          `# Exported: ${new Date().toISOString()}\n` +
          `# Keep this file offline. Anyone with these words can control the operator wallet.\n\n` +
          `${mnemonic.trim()}\n`;
        await fs.writeFile(filePath, body, { encoding: 'utf8', mode: 0o600 });
        shell.showItemInFolder(filePath);
        return { ok: true, path: filePath };
      } catch (err) {
        return { ok: false, error: toUserError(err, 'mnemonic-export') };
      }
    },
  );

  ipcMain.handle(IPC.NODES_REVEAL_MNEMONIC, async (_e, nodeId: string) => {
    const id = vUUID(nodeId, 'node id');
    const store = await readStore();
    const blob = store.nodeBackups[id];
    if (!blob) {
      return {
        ok: false,
        error:
          'No mnemonic backup is stored for this node. The mnemonic is shown only once during deploy; if you skipped saving the encrypted backup then, it cannot be recovered here.',
      };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS keychain unavailable — cannot decrypt backup.' };
    }
    try {
      const mnemonic = safeStorage.decryptString(Buffer.from(blob, 'base64'));
      return { ok: true, mnemonic };
    } catch (err) {
      return { ok: false, error: `Failed to decrypt backup: ${toUserError(err, 'mnemonic-decrypt')}` };
    }
  });

  // -- CLI server ------------------------------------------------------------
  ipcMain.handle(IPC.CLI_STATUS, () => getCliState());
  ipcMain.handle(IPC.CLI_START, async () => {
    try {
      return await startCliServer();
    } catch (err) {
      return { ...getCliState(), error: toUserError(err, 'cli-start') };
    }
  });
  ipcMain.handle(IPC.CLI_STOP, () => stopCliServer());
  ipcMain.handle(IPC.CLI_RUN, async (_e, line: string) => {
    enforceRate('cli-run', 10, 5); // 10-burst, 5/sec sustained
    return runFromApp(line);
  });
  ipcMain.handle(IPC.CLI_OPEN_POWERSHELL, async () => {
    const state = getCliState();
    if (state.status === 'off') {
      return { ok: false, error: 'CLI server is not running. Start it first.' };
    }
    if (process.platform !== 'win32') {
      return {
        ok: false,
        error:
          'Open in PowerShell is Windows-only. On macOS / Linux, run: node ./bin/sentinel-node-manager.js',
      };
    }
    try {
      const binDir = path.join(app.getAppPath(), 'bin');
      const script = path.join(binDir, 'sentinel-node-manager.js');
      // `cmd /c start` is the canonical way to spawn a new visible console
      // window from a GUI process on Windows. `spawn(powershell, …, { detached })`
      // alone doesn't get a console — the window never appears. The empty
      // string after `start` is the window title (required when the next
      // arg is quoted).
      const psCmd = `Write-Host 'Sentinel Node Manager CLI — type help'; node "${script.replace(/"/g, '`"')}"`;
      const child = spawn(
        'cmd.exe',
        [
          '/c',
          'start',
          '""',
          'powershell.exe',
          '-NoProfile',
          '-NoLogo',
          '-NoExit',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          psCmd,
        ],
        {
          detached: true,
          stdio: 'ignore',
          // Must stay false: this command's whole purpose is to surface a
          // visible PowerShell console. windowsHide:true can propagate
          // CREATE_NO_WINDOW to the start-launched grandchild on some builds.
          windowsHide: false,
        },
      );
      child.on('error', (err) => log.warn('cli powershell spawn error', { err: String(err) }));
      child.unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: toUserError(err, 'cli-open-powershell') };
    }
  });

  // -- Diagnostics / online ---------------------------------------------------
  ipcMain.handle(IPC.SYSTEM_ONLINE, () => true); // Renderer-side probe is more meaningful
  ipcMain.handle(IPC.SYSTEM_DIAGNOSTICS, async () => {
    const { filePath } = await dialog.showSaveDialog({
      title: 'Export diagnostics',
      defaultPath: `sentinel-dvpn-diagnostics-${new Date().toISOString().split('T')[0]}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (!filePath) return { ok: false, cancelled: true };
    await exportDiagnostics(filePath);
    shell.showItemInFolder(filePath);
    return { ok: true, path: filePath };
  });
}

async function exportDiagnostics(targetZip: string): Promise<void> {
  const store = await readStore();
  const sanitizedStore = {
    wallet: store.wallet ? { address: store.wallet.address, createdAt: store.wallet.createdAt } : null,
    nodes: store.nodes.map((n) => ({
      id: n.id,
      moniker: n.moniker,
      target: n.target,
      status: n.status,
      operatorAddress: n.operatorAddress,
      createdAt: n.createdAt,
      host: n.host,
      port: n.port,
    })),
    eventsLast50: store.events.slice(0, 50),
  };
  const settings = await getSettings();

  const zip = new AdmZip();
  zip.addFile(
    'meta.json',
    Buffer.from(
      JSON.stringify(
        {
          version: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
          node: process.versions.node,
          chromium: process.versions.chrome,
          ts: new Date().toISOString(),
        },
        null,
        2,
      ),
    ),
  );
  zip.addFile('store.json', Buffer.from(JSON.stringify(sanitizedStore, null, 2)));
  zip.addFile('settings.json', Buffer.from(JSON.stringify(settings, null, 2)));
  let files: string[] = [];
  try {
    files = await fs.readdir(logDir());
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      log.warn('exportDiagnostics: could not read log dir', { err: String(err) });
    }
  }
  for (const f of files) {
    try {
      const contents = await fs.readFile(path.join(logDir(), f));
      zip.addFile(`logs/${f}`, contents);
    } catch (err) {
      // One unreadable/locked log file must not abort the whole bundle.
      log.warn('exportDiagnostics: skipped log file', { file: f, err: String(err) });
    }
  }
  zip.writeZip(targetZip);
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\[[0-9]{1,3}(?:;[0-9]{1,3})*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function parseLineForJson(raw: string): {
  raw: string;
  timestamp: string | null;
  level: string | null;
  message: string;
  fields: Record<string, string>;
} {
  const line = stripAnsi(raw).replace(/\s+$/u, '');
  let timestamp: string | null = null;
  let rest = line;
  const tsMatch = rest.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.*)$/u,
  );
  if (tsMatch) {
    timestamp = tsMatch[1];
    rest = tsMatch[2];
  }
  let level: string | null = null;
  const lvlMatch = rest.match(
    /^\[?(ERROR|ERR|WARN(?:ING)?|INFO|INF|DEBUG|DBG|TRACE|TRC|FATAL|FTL)\]?[:\s]\s*(.*)$/iu,
  );
  if (lvlMatch) {
    level = lvlMatch[1].toUpperCase();
    rest = lvlMatch[2];
  }
  const fields: Record<string, string> = {};
  const kvRe = /([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|\[[^\]]*\]|\S+)/g;
  let firstIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = kvRe.exec(rest))) {
    if (firstIdx < 0) firstIdx = m.index;
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    fields[m[1]] = value;
  }
  const message = firstIdx < 0 ? rest.trim() : rest.slice(0, firstIdx).trim();
  return { raw, timestamp, level, message, fields };
}

async function exportNodeLogs(req: NodeLogExportRequest): Promise<NodeLogExportResult> {
  try {
    const node = await getNode(req.nodeId);
    const moniker = node?.moniker?.replace(/[^A-Za-z0-9_.-]/g, '_') ?? req.nodeId;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = req.format === 'json' ? 'json' : req.format === 'log' ? 'log' : 'txt';
    const defaultName = `${moniker}-logs-${stamp}.${ext}`;

    const filters =
      req.format === 'json'
        ? [{ name: 'JSON', extensions: ['json'] }]
        : req.format === 'log'
          ? [{ name: 'Log file', extensions: ['log'] }]
          : [{ name: 'Plain text', extensions: ['txt'] }];

    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'Export container logs',
      defaultPath: defaultName,
      filters,
    });
    if (canceled || !filePath) return { ok: false, cancelled: true };

    let body: string;
    if (req.format === 'json') {
      const parsed = req.lines.map(parseLineForJson);
      body = JSON.stringify(
        {
          nodeId: req.nodeId,
          moniker: node?.moniker ?? null,
          exportedAt: new Date().toISOString(),
          lineCount: parsed.length,
          lines: parsed,
        },
        null,
        2,
      );
    } else {
      // plain text + .log format share the same ANSI-stripped line body
      body = req.lines.map((l) => stripAnsi(l).replace(/\s+$/u, '')).join('\n') + '\n';
    }

    await fs.writeFile(filePath, body, 'utf8');
    shell.showItemInFolder(filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: toUserError(err, 'export-diagnostics') };
  }
}
