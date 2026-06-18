/**
 * Types shared between the Electron main process, the preload bridge,
 * and the React renderer. Nothing in this file should import Node/Electron
 * or DOM APIs so it can be safely consumed by either side.
 */

export type NodeStatus = 'online' | 'offline' | 'loading' | 'error';

export type NodeDeployTarget = 'local' | 'remote';

export type VpnServiceType = 'wireguard' | 'v2ray';

/**
 * How the node quotes its gigabyte/hour prices on chain.
 *
 * - `'flat'` (default): the udvpn fields are the literal price the node
 *   advertises. Predictable revenue in DVPN, swings in fiat value.
 * - `'oracle'`: the chain's Hub-v12 oracle module multiplies the USD
 *   target by the DVPN spot price at session-settlement time. Predictable
 *   USD revenue, DVPN amount floats. The udvpn fields become the fallback
 *   the node uses when the oracle feed is offline.
 */
export type PriceMode = 'flat' | 'oracle';

/**
 * Hardware snapshot captured at deploy time and broadcast on-chain via a
 * self-MsgSend tx (`specs:v1:{…}` memo). Operator-reported, NOT consensus-
 * validated — the CQAP attestation is what eventually supersedes this.
 *
 * Compact field names so the JSON memo stays under Cosmos's 256-byte cap.
 *   cpu  – cpu model (truncated to 64 chars)
 *   c    – total logical host cores
 *   cr   – cores available to the dvpn-node container (Docker/WSL2 VM view)
 *   r    – total host RAM (MiB)
 *   rr   – RAM available to the dvpn-node container (Docker/WSL2 VM, MiB)
 *
 * `cr`/`rr` are "available to the container", not "reserved": the node
 * container runs uncapped (no HostConfig Memory/NanoCpus), so these report the
 * Docker engine's ceiling (on Windows = the WSL2 VM allocation, which is below
 * the host total). See node-specs.ts for the full rationale.
 */
export interface NodeSpecsSnapshot {
  cpu: string;
  c: number;
  cr: number;
  r: number;
  rr: number;
}

export interface DeployedNode {
  id: string;
  name: string;
  moniker: string;
  target: NodeDeployTarget;
  host?: string;
  region?: string;
  /** ISO-3166-1 alpha-2 country code resolved via geoip (e.g. 'US', 'DE'). */
  country?: string;
  /** Human-readable country name matching `country` (e.g. 'United States'). */
  countryName?: string;
  status: NodeStatus;
  createdAt: string;
  /** The on-chain operator address that sentinel-dvpnx generated during init. */
  operatorAddress: string;
  /** Last observed on-chain DVPN balance for the operator address. */
  balanceDVPN: number;
  port: number;
  /** Hardware snapshot captured at deploy time. Populated for new launches. */
  specs?: NodeSpecsSnapshot;
  /** Hash of the on-chain self-MsgSend that published `specs`. */
  specsTxHash?: string;
  /** Unix ms when `specsTxHash` was confirmed. */
  specsPublishedAt?: number;
  /** True between deploy success and successful spec broadcast. Cleared on success. */
  specsPublishPending?: boolean;
  /** Pricing configured at deploy time (display-friendly DVPN units).
   *  When `priceMode === 'oracle'`, these are the udvpn fallback the node
   *  uses if the oracle is offline; the primary price is `usdGigabytePrice`
   *  / `usdHourlyPrice`. */
  gigabytePriceDVPN: number;
  hourlyPriceDVPN: number;
  /** Pricing mode. Defaults to `'flat'` for nodes deployed before the
   *  oracle option existed (field will be undefined in old records). */
  priceMode?: PriceMode;
  /** USD target per GB. Only meaningful when `priceMode === 'oracle'`. */
  usdGigabytePrice?: number;
  /** USD target per hour. Only meaningful when `priceMode === 'oracle'`. */
  usdHourlyPrice?: number;
  serviceType: VpnServiceType;
  /** Docker container id (local) OR systemd unit name (remote). */
  runtimeId?: string;
  /** True once `sentinel-dvpnx` has reported status to the chain. */
  registeredOnChain: boolean;
  /** Publicly reachable URL of the node's API (for wallet clients). */
  remoteUrl?: string;
  /** ISO timestamp of when the node process most recently started (persisted). */
  startedAt?: string;
}

export interface UpdateNodePricingRequest {
  nodeId: string;
  /** udvpn-denominated values. In oracle mode these become the fallback. */
  gigabytePriceDVPN: number;
  hourlyPriceDVPN: number;
  priceMode?: PriceMode;
  usdGigabytePrice?: number;
  usdHourlyPrice?: number;
}

export interface WalletState {
  address: string | null;
  balanceDVPN: number;
  createdAt: string | null;
  /** True if the encrypted mnemonic file exists on disk. */
  hasMnemonic: boolean;
}

export interface NodeLiveStatus {
  nodeId: string;
  reachable: boolean;
  /** Currently-open VPN sessions against this node (from on-chain query). */
  sessions: number;
  bytesOut: number;
  bytesIn: number;
  /** Uptime (ms) of the node process, persisted across app restarts. */
  uptimeMs: number;
  chainHeight?: number;
  /** Probe latency from the app to the on-chain data source. */
  apiLatencyMs?: number;
  /** Tail of the container / node logs (~last 200 lines). */
  logTail: string[];
  /** Sentinel's lifecycle status as seen on chain (inactive / active / active_pending). */
  chainStatus?: string;
  /** Node's `sentnode1…` address on chain. */
  chainAddress?: string;
  /** `statusAt` ISO timestamp from the node proto — last time the node reported. */
  lastStatusAt?: string;
  /** Active subscription summary parsed from the subscription query. */
  activeSubscriptions: NodeSession[];
  /** Plans this node is linked into (via MsgLinkNode), with on-chain price + duration. */
  linkedPlans: NodePlanLink[];
  /** Null when everything is fine. */
  error?: string;
}

/**
 * Push payload from main → renderer whenever a node's live status is
 * resampled (fast-poll while a node is registering, or the regular 60s
 * sweep). Lets the renderer keep `liveStatuses` fresh without polling.
 */
export interface NodeLiveStatusUpdate {
  nodeId: string;
  status: NodeLiveStatus;
}

export interface NodePlanLink {
  /** Plan id as a base-10 string (Long → string for IPC). */
  id: string;
  /** Price denom on chain (e.g. `udvpn` or `up2p`). */
  denom: string;
  /** Plan price in display units (already divided by 1_000_000). */
  price: number;
  /** Plan duration in days (seconds / 86400). */
  durationDays: number;
}

export interface NodeSession {
  id: string;
  subscriber: string;
  subscriberShort: string;
  bytesIn: number;
  bytesOut: number;
  durationSeconds: number;
  status?: string;
}

export interface SSHCredentials {
  host: string;
  port: number;
  username: string;
  /** Exactly one of password / privateKey is required. */
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SSHTestResult {
  ok: boolean;
  message: string;
  osInfo?: string;
  latencyMs?: number;
}

export type DeployPhase =
  | 'connecting'
  | 'preflight'
  | 'docker-check'
  | 'image-build'
  | 'keygen'
  | 'configure'
  | 'starting'
  | 'verifying'
  | 'done'
  | 'error'
  | 'cancelled';

export interface DeployProgress {
  jobId: string;
  nodeId: string;
  phase: DeployPhase;
  percent: number;
  message: string;
  log: string;
  /** Populated on the keygen phase so the UI can prompt the user to write it down. */
  mnemonicForBackup?: string;
  operatorAddress?: string;
}

export type DockerUnreachableReason =
  | 'desktop-not-installed'
  | 'desktop-not-running'
  | 'engine-not-running';

export interface DockerDesktopStatus {
  /** Docker Desktop is installed on disk (Windows/macOS). Always false on Linux. */
  installed: boolean;
  launchPath?: string;
  /** True if we can start it from the app (Windows/macOS only). */
  startable: boolean;
}

export interface SentinelContainerSummary {
  id: string;
  name: string;
  state: string;
  status: string;
  image: string;
  createdUnix: number;
}

export interface SentinelImageSummary {
  id: string;
  tag: string;
  sizeBytes: number;
  createdUnix: number;
}

export interface DockerOverview {
  reachable: boolean;
  version?: string;
  apiVersion?: string;
  os?: string;
  arch?: string;
  kernel?: string;
  serverTime?: string;
  totalMemoryMb?: number;
  ncpu?: number;
  rootDir?: string;
  containers: { total: number; running: number; paused: number; stopped: number };
  images: { count: number; sizeBytes: number };
  sentinelContainers: SentinelContainerSummary[];
  sentinelImages: SentinelImageSummary[];
  desktop?: DockerDesktopStatus;
  error?: string;
  reason?: DockerUnreachableReason;
}

export interface LocalSystemReport {
  osCompatible: boolean;
  osLabel: string;
  /** 'win32' | 'darwin' | 'linux' | other — surfaced verbatim from `os.platform()`. */
  platform: string;
  /** 'x64' | 'arm64' | etc. */
  arch: string;
  memoryMb: number;
  memoryOk: boolean;
  /** Free RAM at probe time. Snapshot, not a live reading. */
  freeMemoryMb: number;
  /** Reported by `os.cpus()[0].model`. */
  cpuModel: string;
  /** Logical core count. */
  cpuCores: number;
  /** Reported max clock; some VMs report 0 — UI should hide when falsy. */
  cpuSpeedMhz: number;
  diskFreeGb: number;
  diskOk: boolean;
  dockerInstalled: boolean;
  dockerVersion?: string;
  dockerReachable: boolean;
  dockerError?: string;
  /** Why the daemon isn't reachable, if !dockerReachable. Lets UI show the right recovery action. */
  dockerReason?: DockerUnreachableReason;
  /** Install / launch state for Docker Desktop, if applicable. */
  dockerDesktop?: DockerDesktopStatus;
  /**
   * True when the host is Windows AND Docker Desktop is using the WSL2
   * backend (most installs). Lets the UI surface the `vmmemwsl` /
   * `.wslconfig` tuning callout.
   */
  wsl2Backend: boolean;
  /**
   * CQAP (capacity-measurement on-node software) detection.
   *   • 'enabled'  — running and reachable.
   *   • 'disabled' — explicitly off / not installed.
   *   • 'unknown'  — detection mechanism not yet wired up; UI shows a
   *     placeholder pending product decision on how to detect.
   */
  cqap: 'enabled' | 'disabled' | 'unknown';
  /** Optional one-line context for the CQAP chip ("Detection coming soon", "Sidecar not running", etc.). */
  cqapDetail?: string;
}

/**
 * Live system telemetry sample pushed from main → renderer at ~1 Hz while
 * the user has the System page's "Live Specs" toggle enabled. The renderer
 * subscribes by calling `system.startLiveStats()` and unsubscribes via
 * `system.stopLiveStats()`; the main process refcounts subscriptions so
 * multiple windows can share one timer.
 */
export interface LiveSystemStats {
  /** Unix ms when the sample was taken. */
  ts: number;
  /** Free RAM in MB at sample time. */
  freeMemoryMb: number;
  /** Used RAM in MB (totalMb - freeMb). */
  usedMemoryMb: number;
  /** Total RAM in MB. Repeated each tick so the renderer can render without the static report. */
  totalMemoryMb: number;
  /** CPU load 0-100 averaged across all cores since the last sample. */
  cpuLoadPct: number;
  /** Per-core CPU load 0-100 since the last sample. Length = logical core count. */
  cpuPerCorePct: number[];
}

export interface DeployRequest {
  target: NodeDeployTarget;
  moniker: string;
  gigabytePriceDVPN: number;
  hourlyPriceDVPN: number;
  /** Pricing mode. Defaults to `'flat'` (current behaviour) when omitted. */
  priceMode?: PriceMode;
  /** USD target per GB. Required when `priceMode === 'oracle'`. */
  usdGigabytePrice?: number;
  /** USD target per hour. Required when `priceMode === 'oracle'`. */
  usdHourlyPrice?: number;
  serviceType: VpnServiceType;
  port: number;
  /** Optional public URL for remote hosts (e.g. `https://1.2.3.4:7777`). */
  remoteUrl?: string;
  /** Required when target === 'remote'. */
  ssh?: SSHCredentials;
}

export type EventKind =
  | 'wallet-created'
  | 'wallet-restored'
  | 'wallet-logout'
  | 'deploy-started'
  | 'deploy-succeeded'
  | 'deploy-failed'
  | 'node-started'
  | 'node-stopped'
  | 'node-restarted'
  | 'node-removed'
  | 'node-unreachable'
  | 'node-online'
  | 'node-registered'
  | 'specs-reported'
  | 'specs-publish-failed'
  | 'withdraw-sent'
  | 'withdraw-failed'
  | 'balance-refreshed';

export interface AppEvent {
  id: string;
  kind: EventKind;
  title: string;
  subtitle: string;
  timestamp: string;
  amountDVPN?: number;
  relatedNodeId?: string;
  txHash?: string;
}

export interface SendTxRequest {
  to: string;
  amountDVPN: number;
  memo?: string;
}

export interface NodeWithdrawRequest {
  nodeId: string;
  /** Defaults to the app wallet's own address. */
  to?: string;
  /** If omitted, the full node balance minus gas is withdrawn. */
  amountDVPN?: number;
}

export interface SendTxResult {
  ok: boolean;
  txHash?: string;
  height?: number;
  gasUsed?: number;
  error?: string;
  /** Classified error code so the UI can show a helpful message. */
  errorCode?:
    | 'insufficient-funds'
    | 'sequence-mismatch'
    | 'invalid-address'
    | 'timeout'
    | 'rpc-unavailable'
    | 'chain-mismatch'
    | 'gas-estimation-failed'
    | 'unknown';
}

export interface ChainHealth {
  rpcUrl: string;
  reachable: boolean;
  latencyMs?: number;
  chainId?: string;
  blockHeight?: number;
  error?: string;
}

export interface AppSettings {
  /** Comma-separated list of RPC URLs; app round-robins for health. */
  rpcUrls: string[];
  chainId: string;
  gasPriceUdvpn: string;
  /** Explicit override — if blank the app probes the Docker daemon. */
  dockerSocket: string;
  /** Cosmetic toggle only; persisted across launches. */
  seenOnboarding: boolean;
  /**
   * When true, closing the window hides it to the system tray instead of
   * quitting. The user explicitly picks "Quit" from the tray to exit.
   * Containers are never touched by close/hide — they follow their own
   * lifecycle so earnings aren't interrupted when the dashboard is closed.
   */
  minimizeToTrayOnClose: boolean;
  /**
   * When true, picking "Quit" from the tray menu also docker-stops every
   * running node before exiting. Off by default because most operators
   * want the node to keep earning even when the manager isn't running.
   */
  stopNodesOnQuit: boolean;
  /**
   * One-time flag — set to true once we've shown the "still running in
   * the tray" toast, so we don't nag the user every close.
   */
  trayHintShown: boolean;
  /**
   * When true, stops the local CLI server when the app quits. When false,
   * the server keeps running so already-connected PowerShell / agent
   * sessions aren't yanked out from under the user.
   */
  stopCliServerOnQuit: boolean;
  /**
   * How often (seconds) the main process re-queries the chain for the
   * app wallet's DVPN balance. Lower = fresher numbers, more RPC traffic.
   * Clamped to [10, 600] at the service layer.
   */
  walletRefreshIntervalSec: number;
  /**
   * How often (seconds) the main process samples each deployed node's
   * on-chain status (sessions, earnings, reachability) and pushes the
   * update to the renderer. Clamped to [15, 600].
   */
  nodeRefreshIntervalSec: number;
}

export interface MetricsSample {
  nodeId: string;
  ts: number; // unix ms
  peers: number;
  bytesIn: number;
  bytesOut: number;
  earningsUdvpn: number;
  chainHeight?: number;
  reachable: boolean;
}

export type MetricsWindow = '1h' | '24h' | '7d' | '30d';

export interface DiagnosticsArtifact {
  path: string;
  sizeBytes: number;
}

export type NodeLogExportFormat = 'txt' | 'json' | 'log';

export interface NodeLogExportRequest {
  nodeId: string;
  format: NodeLogExportFormat;
  /** Raw log lines captured by the renderer (ANSI-stripped by the writer). */
  lines: string[];
}

export interface NodeLogExportResult {
  ok: boolean;
  path?: string;
  cancelled?: boolean;
  error?: string;
}

export interface MnemonicExportResult {
  ok: boolean;
  path?: string;
  cancelled?: boolean;
  error?: string;
}

/** Channel names used for all renderer <-> main IPC. */
export const IPC = {
  // System / environment
  SYSTEM_REPORT: 'system:report',
  SYSTEM_ONLINE: 'system:online',
  SYSTEM_DIAGNOSTICS: 'system:diagnostics',
  SYSTEM_LIVE_STATS_START: 'system:live-stats-start',
  SYSTEM_LIVE_STATS_STOP: 'system:live-stats-stop',
  SYSTEM_LIVE_STATS: 'system:live-stats', // main -> renderer push (~1 Hz)
  DOCKER_START: 'docker:start',
  DOCKER_OVERVIEW: 'docker:overview',
  DOCKER_QUIT: 'docker:quit',
  DOCKER_FORCE_QUIT: 'docker:force-quit',
  DOCKER_STOP_ALL_SENTINEL: 'docker:stop-all-sentinel',
  DOCKER_PRUNE: 'docker:prune',
  DOCKER_OPEN_SETTINGS: 'docker:open-settings',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  CHAIN_HEALTH: 'chain:health',

  // Wallet
  WALLET_GET: 'wallet:get',
  WALLET_CREATE: 'wallet:create',
  WALLET_RESTORE: 'wallet:restore',
  WALLET_REFRESH_BALANCE: 'wallet:refresh-balance',
  WALLET_SEND: 'wallet:send',
  WALLET_QR: 'wallet:qr',
  WALLET_LOGOUT: 'wallet:logout',

  // Events
  EVENTS_LIST: 'events:list',
  EVENTS_CHANGED: 'events:changed', // main -> renderer push

  // SSH helpers for remote deploy
  SSH_TEST: 'ssh:test',
  SSH_FORGET_HOST_KEY: 'ssh:forget-host-key',

  // Deploy lifecycle
  DEPLOY_START: 'deploy:start',
  DEPLOY_CANCEL: 'deploy:cancel',
  DEPLOY_STATUS: 'deploy:status',
  DEPLOY_PROGRESS: 'deploy:progress', // main -> renderer push

  // Node management
  NODES_LIST: 'nodes:list',
  NODES_GET: 'nodes:get',
  NODES_RESTART: 'nodes:restart',
  NODES_STOP: 'nodes:stop',
  NODES_START: 'nodes:start',
  NODES_REMOVE: 'nodes:remove',
  NODES_LOGS: 'nodes:logs',
  NODES_EXPORT_LOGS: 'nodes:export-logs',
  NODES_STATUS: 'nodes:status',
  NODES_HISTORY: 'nodes:history',
  NODES_WITHDRAW: 'nodes:withdraw',
  NODES_BACKUP_MNEMONIC: 'nodes:backup-mnemonic',
  NODES_EXPORT_MNEMONIC: 'nodes:export-mnemonic',
  NODES_REVEAL_MNEMONIC: 'nodes:reveal-mnemonic',
  NODES_UPDATE_PRICING: 'nodes:update-pricing',
  NODES_PUBLISH_SPECS: 'nodes:publish-specs',
  NODES_REAP_STUCK: 'nodes:reap-stuck',
  NODES_CHANGED: 'nodes:changed', // main -> renderer push
  NODES_LIVE_STATUS: 'nodes:live-status', // main -> renderer push (per-node)

  // CLI server (local pipe / unix socket)
  CLI_STATUS: 'cli:status',
  CLI_START: 'cli:start',
  CLI_STOP: 'cli:stop',
  CLI_RUN: 'cli:run',
  CLI_OPEN_POWERSHELL: 'cli:open-powershell',
  CLI_STATE_CHANGED: 'cli:state-changed', // main -> renderer push
  CLI_STREAM: 'cli:stream', // main -> renderer push
} as const;

export type IPCChannel = (typeof IPC)[keyof typeof IPC];

/** Who currently holds the single-active-client lock on the CLI server. */
export type CliClientKind = 'app' | 'shell' | 'agent';

export type CliServerStatus = 'off' | 'app-active' | 'shell-active' | 'agent-active';

export interface CliServerState {
  status: CliServerStatus;
  /** Filesystem path to the named pipe / unix socket, when running. */
  endpoint: string | null;
  /** When the active session was opened (ISO). */
  sessionStartedAt: string | null;
  /** Path to the discovery file the binary reads to find the endpoint. */
  discoveryPath: string | null;
  /** Last error from the server (start failure, etc.). */
  error: string | null;
}

/**
 * Stream events broadcast to the in-app CLI screen. Mirrors what an
 * external PowerShell / agent client sees on stdout.
 */
export interface CliStreamEvent {
  /** Monotonic per-session id so clients can dedupe. */
  seq: number;
  /** ISO timestamp. */
  ts: string;
  /** Originating client. `system` is the server itself (state changes). */
  source: CliClientKind | 'system';
  /** What the line represents. */
  kind: 'input' | 'ok' | 'err' | 'info';
  /** Already-formatted text. JSON is pretty-printed before broadcast. */
  text: string;
}

export interface CliRunRequest {
  /** Raw command line, e.g. `nodes.history abc --window 1h`. */
  line: string;
}

export interface CliRunResult {
  ok: boolean;
  /** Pretty-printed response text. Empty when ok===false. */
  text: string;
  error?: string;
}
