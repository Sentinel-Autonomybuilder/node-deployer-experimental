/**
 * Main-process CLI command registry.
 *
 * Mirrors the renderer-side registry in `src/renderer/src/lib/cli.ts` but
 * dispatches directly to main-process services so the same commands are
 * runnable from a local pipe / unix socket (PowerShell, AI agent) without
 * crossing the IPC bridge.
 *
 * Adding a new command: register it both here and in the renderer registry.
 */

import { dialog, safeStorage, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import QRCode from 'qrcode';
import AdmZip from 'adm-zip';
import {
  type AppSettings,
  type DeployProgress,
  type DeployRequest,
  type LocalSystemReport,
  type MetricsWindow,
  type NodeLogExportRequest,
  type NodeLogExportResult,
  type NodeWithdrawRequest,
  type PriceMode,
  type SSHCredentials,
  type SendTxRequest,
  type UpdateNodePricingRequest,
  type VpnServiceType,
} from '../../shared/types';
import { testSSHConnection } from './ssh';
import { forgetHostKey } from './host-keys';
import { vSSHCredentials } from '../validate';
import {
  startDeploy,
  cancelDeploy,
  primeDeploySettings,
  getDeployProgress,
  listDeployProgress,
} from './deploy';
import { getUpdaterState, checkForUpdatesNow, installPendingUpdate } from './updater';
import {
  getWallet,
  createWallet,
  restoreWallet,
  refreshWalletBalance,
  sendTokens,
  logoutWallet,
} from './wallet';
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
} from './nodes';
import { publishNodeSpecs } from './node-specs';
import { listEvents } from './events';
import { getSettings, updateSettings } from './settings';
import {
  startDockerDesktop,
  resetDockerClient,
  dockerOverview,
  stopAllSentinelContainers,
  pruneDangling,
  quitDockerDesktop,
  forceQuitDockerDesktop,
} from './docker';
import { buildLocalSystemReport } from './system-report';
import { healthAll, invalidateHealthCache } from './sentinel-client';
import { readStore, writeStore } from './store';

// ─── argv tokenizer (parity with renderer) ──────────────────────────────────

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function tokenize(line: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && i + 1 < line.length) {
        buf += line[++i];
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

export function parseArgs(tokens: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq > -1) {
        flags[t.slice(2, eq)] = t.slice(eq + 1);
      } else {
        const name = t.slice(2);
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positional.push(t);
    }
  }
  return { positional, flags };
}

const requireFlag = (p: ParsedArgs, name: string): string => {
  const v = p.flags[name];
  if (v === undefined) throw new Error(`Missing required --${name}`);
  if (typeof v !== 'string') throw new Error(`--${name} requires a value`);
  return v;
};
const optionalFlag = (p: ParsedArgs, name: string): string | undefined => {
  const v = p.flags[name];
  return typeof v === 'string' ? v : undefined;
};
const numberFlag = (p: ParsedArgs, name: string, required = false): number | undefined => {
  const v = p.flags[name];
  if (v === undefined) {
    if (required) throw new Error(`Missing required --${name}`);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
};
const requirePositional = (p: ParsedArgs, idx: number, label: string): string => {
  const v = p.positional[idx];
  if (!v) throw new Error(`Missing positional argument: ${label}`);
  return v;
};
const requirePositionalOrFlag = (
  p: ParsedArgs,
  idx: number,
  label: string,
  flag = label,
): string => {
  const pos = p.positional[idx];
  if (pos) return pos;
  const f = p.flags[flag];
  if (typeof f === 'string' && f) return f;
  throw new Error(`Missing ${label} (pass positionally or as --${flag})`);
};

const isVpnServiceType = (s: string): s is VpnServiceType =>
  s === 'wireguard' || s === 'v2ray';
const isMetricsWindow = (s: string): s is MetricsWindow =>
  s === '1h' || s === '24h' || s === '7d' || s === '30d';

// ─── helpers needed for main-side execution ──────────────────────────────────

async function reportLocalSystem(): Promise<LocalSystemReport> {
  return buildLocalSystemReport();
}

async function exportDiagnosticsToTmp(): Promise<{ ok: boolean; path?: string; error?: string }> {
  // Headless variant of the GUI's exportDiagnostics — writes to a temp path
  // since we can't show a file dialog from the pipe / agent context. Must
  // mirror the GUI sanitizer (ipc.ts) so the encrypted-mnemonic blob,
  // SSH credentials, and other secrets in the raw store NEVER hit disk
  // via the CLI path.
  const tmpDir = path.join(os.tmpdir(), 'sentinel-dvpn-diagnostics');
  await fs.mkdir(tmpDir, { recursive: true });
  const stamp = new Date().toISOString().split('T')[0];
  const target = path.join(tmpDir, `sentinel-dvpn-diagnostics-${stamp}.zip`);
  try {
    const store = await readStore();
    const sanitizedStore = {
      wallet: store.wallet
        ? { address: store.wallet.address, createdAt: store.wallet.createdAt }
        : null,
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
    zip.addFile('store.json', Buffer.from(JSON.stringify(sanitizedStore, null, 2)));
    zip.addFile('settings.json', Buffer.from(JSON.stringify(settings, null, 2)));
    zip.writeZip(target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function exportNodeLogsHeadless(
  req: NodeLogExportRequest,
): Promise<NodeLogExportResult> {
  const node = await getNode(req.nodeId);
  const moniker = node?.moniker?.replace(/[^A-Za-z0-9_.-]/g, '_') ?? req.nodeId;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = req.format === 'json' ? 'json' : req.format === 'log' ? 'log' : 'txt';
  const tmp = path.join(os.tmpdir(), 'sentinel-dvpn-logs');
  await fs.mkdir(tmp, { recursive: true });
  const target = path.join(tmp, `${moniker}-logs-${stamp}.${ext}`);
  // eslint-disable-next-line no-control-regex
  const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\[[0-9]{1,3}(?:;[0-9]{1,3})*m/g;
  const body =
    req.format === 'json'
      ? JSON.stringify(
          { nodeId: req.nodeId, moniker: node?.moniker ?? null, lines: req.lines },
          null,
          2,
        )
      : req.lines.map((l) => l.replace(ANSI_RE, '').replace(/\s+$/u, '')).join('\n') + '\n';
  await fs.writeFile(target, body, 'utf8');
  return { ok: true, path: target };
}

// ─── command registry ────────────────────────────────────────────────────────

export interface MainCliArg {
  name: string;
  kind: 'positional' | 'flag' | 'bool';
  required?: boolean;
  describe: string;
}

export interface MainCliCommand {
  name: string;
  group:
    | 'system'
    | 'docker'
    | 'settings'
    | 'wallet'
    | 'events'
    | 'updater'
    | 'ssh'
    | 'deploy'
    | 'nodes'
    | 'cli';
  summary: string;
  usage: string;
  args: MainCliArg[];
  exec: (parsed: ParsedArgs) => Promise<unknown>;
}

export const MAIN_COMMANDS: MainCliCommand[] = [
  // ── system ────────────────────────────────────────────────────────────────
  {
    name: 'system.report',
    group: 'system',
    summary: 'Local system + Docker reachability snapshot.',
    usage: 'system.report',
    args: [],
    exec: () => reportLocalSystem(),
  },
  {
    name: 'system.exportDiagnostics',
    group: 'system',
    summary: 'Bundle store + settings into a zip in the OS temp dir.',
    usage: 'system.exportDiagnostics',
    args: [],
    exec: () => exportDiagnosticsToTmp(),
  },

  // ── docker ────────────────────────────────────────────────────────────────
  {
    name: 'docker.start',
    group: 'docker',
    summary: 'Spawn Docker Desktop (Windows / macOS only).',
    usage: 'docker.start',
    args: [],
    exec: async () => {
      const r = await startDockerDesktop();
      resetDockerClient();
      return r;
    },
  },
  {
    name: 'docker.overview',
    group: 'docker',
    summary: 'Daemon stats: containers, images, sentinel containers/images.',
    usage: 'docker.overview',
    args: [],
    exec: () => dockerOverview(),
  },
  {
    name: 'docker.quit',
    group: 'docker',
    summary: 'Politely quit Docker Desktop.',
    usage: 'docker.quit',
    args: [],
    exec: async () => {
      const r = await quitDockerDesktop();
      resetDockerClient();
      return r;
    },
  },
  {
    name: 'docker.forceQuit',
    group: 'docker',
    summary: 'Force-kill Docker Desktop process tree.',
    usage: 'docker.forceQuit',
    args: [],
    exec: async () => {
      const r = await forceQuitDockerDesktop();
      resetDockerClient();
      return r;
    },
  },
  {
    name: 'docker.stopAllSentinel',
    group: 'docker',
    summary: 'Stop every running Sentinel container managed by this app.',
    usage: 'docker.stopAllSentinel',
    args: [],
    exec: () => stopAllSentinelContainers(),
  },
  {
    name: 'docker.prune',
    group: 'docker',
    summary: 'Prune dangling Docker images.',
    usage: 'docker.prune',
    args: [],
    exec: () => pruneDangling(),
  },

  // ── settings ──────────────────────────────────────────────────────────────
  {
    name: 'settings.get',
    group: 'settings',
    summary: 'Read the persisted app settings.',
    usage: 'settings.get',
    args: [],
    exec: () => getSettings(),
  },
  {
    name: 'settings.set',
    group: 'settings',
    summary: 'Patch one or more settings fields. Pass JSON via --json.',
    usage: 'settings.set --json \'{"minimizeToTrayOnClose":true}\'',
    args: [{ name: 'json', kind: 'flag', required: true, describe: 'JSON object to patch.' }],
    exec: async (p) => {
      const patch = JSON.parse(requireFlag(p, 'json')) as Partial<AppSettings>;
      const next = await updateSettings(patch);
      invalidateHealthCache();
      await primeDeploySettings();
      return next;
    },
  },
  {
    name: 'settings.chainHealth',
    group: 'settings',
    summary: 'Probe all configured RPC/LCD endpoints.',
    usage: 'settings.chainHealth',
    args: [],
    exec: () => healthAll(),
  },

  // ── wallet ────────────────────────────────────────────────────────────────
  {
    name: 'wallet.get',
    group: 'wallet',
    summary: 'Current wallet (address, balance, hasMnemonic).',
    usage: 'wallet.get',
    args: [],
    exec: () => getWallet(),
  },
  {
    name: 'wallet.create',
    group: 'wallet',
    summary: 'Generate a new wallet. Returns the mnemonic ONCE.',
    usage: 'wallet.create',
    args: [],
    exec: () => createWallet(),
  },
  {
    name: 'wallet.restore',
    group: 'wallet',
    summary: 'Restore a wallet from a BIP-39 mnemonic.',
    usage: 'wallet.restore --mnemonic "word1 word2 ... word24"',
    args: [{ name: 'mnemonic', kind: 'flag', required: true, describe: 'BIP-39 mnemonic.' }],
    exec: (p) => restoreWallet(requireFlag(p, 'mnemonic')),
  },
  {
    name: 'wallet.refreshBalance',
    group: 'wallet',
    summary: 'Re-query the chain for the wallet balance.',
    usage: 'wallet.refreshBalance',
    args: [],
    exec: () => refreshWalletBalance(),
  },
  {
    name: 'wallet.send',
    group: 'wallet',
    summary: 'Send DVPN from the app wallet.',
    usage: 'wallet.send --to sent1... --amount 1.5 [--memo "hello"]',
    args: [
      { name: 'to', kind: 'flag', required: true, describe: 'Recipient sent1… address.' },
      { name: 'amount', kind: 'flag', required: true, describe: 'Amount in DVPN.' },
      { name: 'memo', kind: 'flag', describe: 'Optional memo.' },
    ],
    exec: (p) => {
      const req: SendTxRequest = {
        to: requireFlag(p, 'to'),
        amountDVPN: numberFlag(p, 'amount', true) as number,
        memo: optionalFlag(p, 'memo'),
      };
      return sendTokens(req);
    },
  },
  {
    name: 'wallet.qrSvg',
    group: 'wallet',
    summary: 'Render an SVG QR code for any text.',
    usage: 'wallet.qrSvg --text sent1...',
    args: [{ name: 'text', kind: 'flag', required: true, describe: 'String to encode.' }],
    exec: (p) =>
      QRCode.toString(requireFlag(p, 'text'), {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 1,
        color: { dark: '#0B1020', light: '#FFFFFF' },
      }),
  },
  {
    name: 'wallet.logout',
    group: 'wallet',
    summary: 'Wipe the app wallet from disk. (Destructive.)',
    usage: 'wallet.logout',
    args: [],
    exec: () => logoutWallet(),
  },

  // ── events ────────────────────────────────────────────────────────────────
  {
    name: 'events.list',
    group: 'events',
    summary: 'Most recent app events.',
    usage: 'events.list [--limit 50]',
    args: [{ name: 'limit', kind: 'flag', describe: 'Max events.' }],
    exec: (p) => Promise.resolve(listEvents(numberFlag(p, 'limit'))),
  },

  // ── ssh ───────────────────────────────────────────────────────────────────
  {
    name: 'ssh.test',
    group: 'ssh',
    summary: 'Probe SSH credentials.',
    usage:
      'ssh.test --host 1.2.3.4 --port 22 --username root [--password ...] [--privateKey ...]',
    args: [
      { name: 'host', kind: 'flag', required: true, describe: 'IP or hostname.' },
      { name: 'port', kind: 'flag', describe: 'SSH port (default 22).' },
      { name: 'username', kind: 'flag', required: true, describe: 'SSH user.' },
      { name: 'password', kind: 'flag', describe: 'Password.' },
      { name: 'privateKey', kind: 'flag', describe: 'PEM key contents.' },
      { name: 'passphrase', kind: 'flag', describe: 'Key passphrase.' },
    ],
    exec: (p) => {
      // M-13: validate through the same checker the IPC path uses, instead of
      // constructing SSHCredentials raw. Catches bad hosts/ports/usernames and
      // bounds the credential field sizes before they reach the ssh2 client.
      const creds = vSSHCredentials({
        host: requireFlag(p, 'host'),
        port: numberFlag(p, 'port') ?? 22,
        username: requireFlag(p, 'username'),
        password: optionalFlag(p, 'password'),
        privateKey: optionalFlag(p, 'privateKey'),
        passphrase: optionalFlag(p, 'passphrase'),
      });
      return testSSHConnection(creds);
    },
  },
  {
    name: 'ssh.forgetHostKey',
    group: 'ssh',
    summary: 'Drop a TOFU-pinned SSH host key (for ephemeral hosts / e2e mocks).',
    usage: 'ssh.forgetHostKey --host 1.2.3.4 --port 22',
    args: [
      { name: 'host', kind: 'flag', required: true, describe: 'IP or hostname.' },
      { name: 'port', kind: 'flag', describe: 'SSH port (default 22).' },
    ],
    exec: async (p) => {
      const host = requireFlag(p, 'host');
      const port = numberFlag(p, 'port') ?? 22;
      await forgetHostKey(host, port);
      return { ok: true, host, port };
    },
  },

  // ── deploy ────────────────────────────────────────────────────────────────
  {
    name: 'deploy.start',
    group: 'deploy',
    summary: 'Kick off a deploy. Returns {jobId, nodeId} immediately.',
    usage:
      'deploy.start --target local|remote --moniker foo --gb 0.05 --hr 0.001 --service wireguard|v2ray --port 7777 [--ssh \'{...}\']',
    args: [
      { name: 'target', kind: 'flag', required: true, describe: '"local" or "remote".' },
      { name: 'moniker', kind: 'flag', required: true, describe: 'Public node name.' },
      { name: 'gb', kind: 'flag', required: true, describe: 'Per GB price.' },
      { name: 'hr', kind: 'flag', required: true, describe: 'Per hour price.' },
      { name: 'service', kind: 'flag', required: true, describe: 'wireguard | v2ray.' },
      { name: 'port', kind: 'flag', required: true, describe: 'Public port.' },
      { name: 'remoteUrl', kind: 'flag', describe: 'Public URL (remote target).' },
      { name: 'ssh', kind: 'flag', describe: 'JSON SSHCredentials (remote target).' },
    ],
    exec: async (p) => {
      const target = requireFlag(p, 'target');
      if (target !== 'local' && target !== 'remote')
        throw new Error('--target must be "local" or "remote"');
      const service = requireFlag(p, 'service');
      if (!isVpnServiceType(service))
        throw new Error('--service must be "wireguard" or "v2ray"');
      const sshRaw = optionalFlag(p, 'ssh');
      // M-13: a remote deploy's SSH blob arrives as a raw JSON string from the
      // CLI. Parse then validate through the shared checker — the same gate the
      // IPC DEPLOY_START handler applies — so malformed creds can't slip past.
      let ssh: SSHCredentials | undefined;
      if (sshRaw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(sshRaw);
        } catch {
          throw new Error('--ssh must be valid JSON for SSHCredentials');
        }
        ssh = vSSHCredentials(parsed);
      }
      const req: DeployRequest = {
        target,
        moniker: requireFlag(p, 'moniker'),
        gigabytePriceDVPN: numberFlag(p, 'gb', true) as number,
        hourlyPriceDVPN: numberFlag(p, 'hr', true) as number,
        serviceType: service,
        port: numberFlag(p, 'port', true) as number,
        remoteUrl: optionalFlag(p, 'remoteUrl'),
        ssh,
      };
      await primeDeploySettings();
      return startDeploy(req, () => {
        // Deploy progress is broadcast over IPC to the renderer; CLI clients
        // can poll nodes.list / nodes.status to follow up.
      });
    },
  },
  {
    name: 'deploy.cancel',
    group: 'deploy',
    summary: 'Cancel an in-flight deploy by jobId.',
    usage: 'deploy.cancel <jobId>',
    args: [{ name: 'jobId', kind: 'positional', required: true, describe: 'Job id.' }],
    exec: (p) => Promise.resolve(cancelDeploy(requirePositional(p, 0, 'jobId'))),
  },
  {
    name: 'deploy.status',
    group: 'deploy',
    summary: 'Latest progress frame for a deploy. Omit jobId to list all.',
    usage: 'deploy.status [<jobId>]',
    args: [{ name: 'jobId', kind: 'positional', describe: 'Optional job id.' }],
    // The recovery phrase is always redacted from this endpoint. The
    // previous `--reveal` flag exposed the operator mnemonic to anyone
    // with CLI pipe access; reveal must go through the renderer's gated
    // flow (with confirm) instead.
    exec: (p) => {
      const jobId = p.positional[0];
      const redact = (frame: DeployProgress | null): DeployProgress | null => {
        if (!frame) return frame;
        if (frame.mnemonicForBackup === undefined) return frame;
        return { ...frame, mnemonicForBackup: '[redacted — use the in-app reveal flow]' };
      };
      const value = jobId ? redact(getDeployProgress(jobId)) : listDeployProgress().map((f) => redact(f));
      return Promise.resolve(value);
    },
  },

  // ── updater ───────────────────────────────────────────────────────────────
  {
    name: 'updater.status',
    group: 'updater',
    summary: 'Current auto-updater state.',
    usage: 'updater.status',
    args: [],
    exec: () => Promise.resolve(getUpdaterState()),
  },
  {
    name: 'updater.check',
    group: 'updater',
    summary: 'Force a check for app updates.',
    usage: 'updater.check',
    args: [],
    exec: () => checkForUpdatesNow(),
  },
  {
    name: 'updater.install',
    group: 'updater',
    summary: 'Install a downloaded update and relaunch the app.',
    usage: 'updater.install',
    args: [],
    exec: () => Promise.resolve(installPendingUpdate()),
  },

  // ── nodes ─────────────────────────────────────────────────────────────────
  {
    name: 'nodes.list',
    group: 'nodes',
    summary: 'List every node managed by this app.',
    usage: 'nodes.list',
    args: [],
    exec: () => Promise.resolve(listNodes()),
  },
  {
    name: 'nodes.get',
    group: 'nodes',
    summary: 'Fetch a single node by id.',
    usage: 'nodes.get <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => Promise.resolve(getNode(requirePositional(p, 0, 'nodeId'))),
  },
  {
    name: 'nodes.start',
    group: 'nodes',
    summary: 'Start a stopped node.',
    usage: 'nodes.start <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => startNode(requirePositional(p, 0, 'nodeId')),
  },
  {
    name: 'nodes.restart',
    group: 'nodes',
    summary: 'Restart a node.',
    usage: 'nodes.restart <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => restartNode(requirePositional(p, 0, 'nodeId')),
  },
  {
    name: 'nodes.stop',
    group: 'nodes',
    summary: 'Stop a running node.',
    usage: 'nodes.stop <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => stopNode(requirePositional(p, 0, 'nodeId')),
  },
  {
    name: 'nodes.remove',
    group: 'nodes',
    summary: 'Remove a node from the app store. (Destructive.)',
    usage: 'nodes.remove <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => removeNode(requirePositional(p, 0, 'nodeId')),
  },
  {
    name: 'nodes.logs',
    group: 'nodes',
    summary: 'Tail recent log lines for a node.',
    usage: 'nodes.logs <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => recentLogs(requirePositional(p, 0, 'nodeId')),
  },
  {
    name: 'nodes.exportLogs',
    group: 'nodes',
    summary: 'Save a log buffer to OS temp dir.',
    usage: 'nodes.exportLogs <nodeId> --format txt|log|json --lines \'["line1"]\'',
    args: [
      { name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' },
      { name: 'format', kind: 'flag', required: true, describe: 'txt | log | json.' },
      { name: 'lines', kind: 'flag', required: true, describe: 'JSON array of lines.' },
    ],
    exec: (p) => {
      const fmt = requireFlag(p, 'format');
      if (fmt !== 'txt' && fmt !== 'log' && fmt !== 'json')
        throw new Error('--format must be txt | log | json');
      const lines = JSON.parse(requireFlag(p, 'lines')) as unknown;
      if (!Array.isArray(lines)) throw new Error('--lines must be a JSON array');
      return exportNodeLogsHeadless({
        nodeId: requirePositional(p, 0, 'nodeId'),
        format: fmt,
        lines: lines as string[],
      });
    },
  },
  {
    name: 'nodes.status',
    group: 'nodes',
    summary: 'Live status for a node.',
    usage: 'nodes.status <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => nodeStatus(requirePositional(p, 0, 'nodeId')),
  },
  {
    name: 'nodes.history',
    group: 'nodes',
    summary: 'Historical metrics samples for a node.',
    usage: 'nodes.history <nodeId> --window 1h|24h|7d|30d',
    args: [
      { name: 'nodeId', kind: 'positional', required: true, describe: 'Node id (or --nodeId).' },
      { name: 'window', kind: 'flag', required: true, describe: '1h | 24h | 7d | 30d' },
    ],
    exec: (p) => {
      const w = requireFlag(p, 'window');
      if (!isMetricsWindow(w)) throw new Error('--window must be 1h | 24h | 7d | 30d');
      return Promise.resolve(nodeHistory(requirePositionalOrFlag(p, 0, 'nodeId'), w));
    },
  },
  {
    name: 'nodes.withdraw',
    group: 'nodes',
    summary: 'Withdraw earned DVPN from a node operator.',
    usage: 'nodes.withdraw --nodeId <id> --amount 1.5 [--to sent1...]',
    args: [
      { name: 'nodeId', kind: 'flag', required: true, describe: 'Node id.' },
      { name: 'amount', kind: 'flag', required: true, describe: 'DVPN amount.' },
      { name: 'to', kind: 'flag', describe: 'Defaults to app wallet.' },
    ],
    exec: async (p) => {
      const req: NodeWithdrawRequest = {
        nodeId: requireFlag(p, 'nodeId'),
        amountDVPN: numberFlag(p, 'amount', true) as number,
        to: optionalFlag(p, 'to'),
      };
      const store = await readStore();
      const to = req.to ?? store.wallet?.address;
      if (!to) return { ok: false, error: 'No destination: app wallet not set up.' };
      return withdrawFromNode(req.nodeId, to, req.amountDVPN);
    },
  },
  {
    name: 'nodes.updatePricing',
    group: 'nodes',
    summary: 'Broadcast MsgUpdateNodeDetails with new prices.',
    usage:
      'nodes.updatePricing --nodeId <id> --gb 0.05 --hr 0.001 [--priceMode flat|oracle] [--usdGb 0.10] [--usdHr 0.01]',
    args: [
      { name: 'nodeId', kind: 'flag', required: true, describe: 'Node id.' },
      { name: 'gb', kind: 'flag', required: true, describe: 'DVPN per GB (or oracle fallback).' },
      { name: 'hr', kind: 'flag', required: true, describe: 'DVPN per hour (or oracle fallback).' },
      { name: 'priceMode', kind: 'flag', describe: 'flat | oracle (default: flat).' },
      { name: 'usdGb', kind: 'flag', describe: 'USD per GB (oracle mode).' },
      { name: 'usdHr', kind: 'flag', describe: 'USD per hour (oracle mode).' },
    ],
    exec: (p) => {
      const priceModeRaw = optionalFlag(p, 'priceMode');
      let priceMode: PriceMode | undefined;
      if (priceModeRaw !== undefined) {
        if (priceModeRaw !== 'flat' && priceModeRaw !== 'oracle') {
          throw new Error('--priceMode must be "flat" or "oracle"');
        }
        priceMode = priceModeRaw;
      }
      const req: UpdateNodePricingRequest = {
        nodeId: requireFlag(p, 'nodeId'),
        gigabytePriceDVPN: numberFlag(p, 'gb', true) as number,
        hourlyPriceDVPN: numberFlag(p, 'hr', true) as number,
        priceMode,
        usdGigabytePrice: numberFlag(p, 'usdGb'),
        usdHourlyPrice: numberFlag(p, 'usdHr'),
      };
      return updateNodePricing(req.nodeId, req.gigabytePriceDVPN, req.hourlyPriceDVPN, {
        priceMode: req.priceMode,
        usdGigabytePrice: req.usdGigabytePrice,
        usdHourlyPrice: req.usdHourlyPrice,
      });
    },
  },
  {
    name: 'nodes.publishSpecs',
    group: 'nodes',
    summary:
      'Publish on-chain hardware specs (specs:v1 self-MsgSend memo). Idempotent by default — pass --force to bypass and post a fresh attestation.',
    usage: 'nodes.publishSpecs <nodeId> [--force]',
    args: [
      { name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' },
      {
        name: 'force',
        kind: 'flag',
        required: false,
        describe: 'Bypass the idempotency short-circuit and post a fresh on-chain attestation.',
      },
    ],
    exec: (p) =>
      publishNodeSpecs(requirePositional(p, 0, 'nodeId'), {
        force: p.flags.force === true || p.flags.force === 'true',
      }),
  },
  {
    name: 'nodes.backupMnemonic',
    group: 'nodes',
    summary: "Encrypt + store a node operator's mnemonic with the OS keychain.",
    usage: 'nodes.backupMnemonic <nodeId> --mnemonic "word1 ..."',
    args: [
      { name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' },
      { name: 'mnemonic', kind: 'flag', required: true, describe: 'BIP-39 mnemonic.' },
    ],
    exec: async (p) => {
      const nodeId = requirePositional(p, 0, 'nodeId');
      const mnemonic = requireFlag(p, 'mnemonic');
      if (!safeStorage.isEncryptionAvailable()) {
        return { ok: false, error: 'OS keychain unavailable — cannot back up.' };
      }
      const store = await readStore();
      store.nodeBackups[nodeId] = safeStorage.encryptString(mnemonic).toString('base64');
      await writeStore(store);
      return { ok: true };
    },
  },
  {
    name: 'nodes.revealMnemonic',
    group: 'nodes',
    summary: 'Decrypt a previously stored node-operator mnemonic.',
    usage: 'nodes.revealMnemonic <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: async (p) => {
      const nodeId = requirePositional(p, 0, 'nodeId');
      const store = await readStore();
      const blob = store.nodeBackups[nodeId];
      if (!blob) return { ok: false, error: 'No mnemonic backup is stored for this node.' };
      if (!safeStorage.isEncryptionAvailable())
        return { ok: false, error: 'OS keychain unavailable.' };
      try {
        const mnemonic = safeStorage.decryptString(Buffer.from(blob, 'base64'));
        return { ok: true, mnemonic };
      } catch (err) {
        return { ok: false, error: `Failed to decrypt: ${(err as Error).message}` };
      }
    },
  },
];

const BY_NAME: Record<string, MainCliCommand> = Object.fromEntries(
  MAIN_COMMANDS.map((c) => [c.name, c]),
);

// Suppress unused warnings for imports kept for parity with the IPC layer.
void dialog;
void shell;

export interface RunResult {
  ok: boolean;
  text: string;
  error?: string;
}

const helpText = (): string => {
  const lines = ['Available commands:'];
  for (const c of MAIN_COMMANDS) {
    lines.push(`  ${c.name.padEnd(28)} ${c.summary}`);
  }
  lines.push('');
  lines.push('Built-in:');
  lines.push('  help                         Print this help.');
  lines.push('  exit / quit                  Disconnect (CLI clients only).');
  return lines.join('\n');
};

export async function runCommand(line: string): Promise<RunResult> {
  const trimmed = line.trim();
  if (!trimmed) return { ok: true, text: '' };
  if (trimmed === 'help') return { ok: true, text: helpText() };

  const tokens = tokenize(trimmed);
  const cmd = BY_NAME[tokens[0]];
  if (!cmd) {
    return {
      ok: false,
      text: '',
      error: `Unknown command: ${tokens[0]}. Type 'help' to see every command.`,
    };
  }
  try {
    const parsed = parseArgs(tokens.slice(1));
    const result = await cmd.exec(parsed);
    const text =
      result === undefined
        ? '(ok — no value)'
        : typeof result === 'string'
          ? result
          : JSON.stringify(result, null, 2);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, text: '', error: (err as Error).message };
  }
}
