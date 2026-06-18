import { create } from 'zustand';
import type {
  AppEvent,
  AppSettings,
  ChainHealth,
  CliServerState,
  CliStreamEvent,
  DeployProgress,
  DeployedNode,
  EventKind,
  LiveSystemStats,
  MetricsSample,
  MetricsWindow,
  NodeLiveStatus,
  WalletState,
} from '../../../shared/types';

export type Route =
  | { name: 'wallet-setup' }
  | { name: 'overview' }
  | { name: 'nodes' }
  | { name: 'node-details'; id: string }
  | { name: 'deploy-local' }
  | { name: 'deploy-ssh' }
  | { name: 'deploy-ssh-batch' }
  | { name: 'progress'; jobId: string; moniker: string; origin?: 'local' | 'ssh' }
  | { name: 'wallet' }
  | { name: 'settings' }
  | { name: 'manage-docker' }
  | { name: 'cli' }
  | { name: 'activity'; kinds?: EventKind[]; nodeId?: string }
  | { name: 'on-chain-specs' }
  | { name: 'system' }
  | { name: 'help' };

export interface Toast {
  id: string;
  title: string;
  body?: string;
  tone?: 'success' | 'error' | 'warn' | 'info';
  durationMs?: number;
}

export interface ConfirmPrompt {
  id: string;
  title: string;
  body?: string;
  tone?: 'info' | 'warning' | 'danger';
  confirmLabel?: string;
  cancelLabel?: string;
  /** When set, user must type this string to enable the confirm button. */
  requireType?: string;
  resolve: (ok: boolean) => void;
}

export interface CliOutputEntry {
  id: number;
  kind: 'input' | 'ok' | 'err' | 'info';
  source?: 'app' | 'shell' | 'agent' | 'system';
  text: string;
  poll?: boolean;
}

// Read-only commands hammered in polling loops; their input + reply are
// flagged so the CLI screen's "Hide poll spam" toggle can collapse them.
const POLL_COMMANDS = new Set([
  'deploy.status',
  'nodes.list',
  'nodes.get',
  'nodes.status',
  'system.report',
  'wallet.refreshBalance',
  'wallet.get',
  'settings.chainHealth',
  'cli.status',
  'updater.status',
  'events.list',
  'docker.overview',
]);
const CLI_OUTPUT_MAX = 500;
const CLI_HISTORY_MAX = 200;
const INITIAL_CLI_ENTRY: CliOutputEntry = {
  id: 0,
  kind: 'info',
  text:
    'Sentinel Node Manager — built-in CLI. Type `help` for the full command list, or click any command on the left to insert it. Use the arrow keys to recall previous commands.',
};

function commandFromInput(text: string): string | null {
  const stripped = text.startsWith('$ ') ? text.slice(2) : text;
  const tok = stripped.trim().split(/\s+/)[0];
  return tok || null;
}
function isPollInput(text: string): boolean {
  const cmd = commandFromInput(text);
  return cmd != null && POLL_COMMANDS.has(cmd);
}

interface AppState {
  // routing
  route: Route;
  history: Route[];
  navigate: (r: Route) => void;
  goBack: () => void;
  canGoBack: boolean;

  // data
  wallet: WalletState | null;
  walletBootstrapped: boolean;
  bootError: string | null;
  setWallet: (w: WalletState | null) => void;
  refreshWallet: () => Promise<void>;
  logoutWallet: () => Promise<void>;

  nodes: DeployedNode[];
  refreshNodes: () => Promise<void>;
  /** Force-drop every local node stuck in `loading` whose container isn't
   * actually running. Surfaced from the Nodes screen as a manual escape
   * hatch when the auto-reaper hasn't caught up (e.g. a node that wedged
   * before this build's reaper code shipped). */
  reapStuckNodes: () => Promise<void>;

  events: AppEvent[];
  refreshEvents: () => Promise<void>;

  settings: AppSettings | null;
  refreshSettings: () => Promise<void>;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;

  chainHealth: ChainHealth[];
  refreshChainHealth: () => Promise<void>;

  liveStatuses: Record<string, NodeLiveStatus>;
  refreshStatus: (id: string) => Promise<NodeLiveStatus>;

  nodeHistory: Record<string, MetricsSample[]>;
  loadHistory: (id: string, window: MetricsWindow) => Promise<MetricsSample[]>;

  progress: DeployProgress | null;
  /** Wall-clock ms when the most recent progress frame arrived. Used by the
   * Topbar pill to detect a wedged backend (no frame in N seconds → stale). */
  progressAt: number | null;
  setProgress: (p: DeployProgress | null) => void;
  /** Force-clear a stuck deploy: cancels the job server-side, drops the pill
   * and the cumulative log. Surfaced from the Topbar when the backend is
   * not emitting frames anymore. */
  clearStuckDeploy: () => Promise<void>;

  // Per-jobId cumulative deploy log. Each progress frame carries only the
  // latest chunk, so we accumulate them here in the store rather than in the
  // Progress screen's local state — that way leaving and returning to the
  // Progress screen keeps the full log visible.
  deployLogs: Record<string, string[]>;
  appendDeployLog: (jobId: string, chunk: string) => void;
  clearDeployLog: (jobId: string) => void;

  // Seed-phrase: keyed by jobId. Set when the user has either saved-to-
  // keychain or copied/exported and ticked the confirmation. Until acked,
  // the Progress screen stays mounted and shows the recovery phrase inline.
  seedAck: Record<string, boolean>;
  acknowledgeSeed: (jobId: string) => void;
  // When the user clicks "Show recovery phrase" on the Progress banner we
  // stash the jobId here so SeedPhraseModal skips its 3.3 s grace delay.
  seedShowRequested: string | null;
  requestSeedShow: (jobId: string) => void;
  clearSeedShowRequest: () => void;

  // CLI session — persisted across screen navigation. The CLI screen used to
  // hold output/history in component-local state, which meant leaving and
  // returning wiped the buffer. Lifting it here (and subscribing to CLI
  // events from bootstrap) keeps the log alive for the whole app session
  // and accumulates events even while the screen isn't mounted.
  cliOutput: CliOutputEntry[];
  cliHistory: string[];
  cliServerState: CliServerState | null;
  appendCliOutput: (entry: Omit<CliOutputEntry, 'id'>) => void;
  clearCliOutput: () => void;
  pushCliHistory: (line: string) => void;
  setCliServerState: (s: CliServerState | null) => void;

  // chrome: toasts + confirm + connectivity
  toasts: Toast[];
  pushToast: (t: Omit<Toast, 'id'>) => string;
  dismissToast: (id: string) => void;

  confirmPrompt: ConfirmPrompt | null;
  confirm: (opts: Omit<ConfirmPrompt, 'id' | 'resolve'>) => Promise<boolean>;
  resolveConfirm: (ok: boolean) => void;

  online: boolean;

  // System screen toggles — lifted into the store so they survive screen
  // navigation. Live Specs in particular was getting reset every time the
  // user clicked away because it was local component state in System.tsx.
  systemLive: boolean;
  systemReporting: boolean;
  systemStats: LiveSystemStats | null;
  setSystemLive: (next: boolean) => void;
  setSystemReporting: (next: boolean) => void;

  bootstrap: () => Promise<void>;
}

const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// Specs-reported toast bookkeeping (module scope so it survives store
// re-reads). First refresh seeds the seen-set to suppress the toast for
// pre-existing events; later refreshes toast on any new id.
const seenSpecsEventIds = new Set<string>();
let specsToastSeed = true;

export const useApp = create<AppState>((set, get) => ({
  route: { name: 'wallet-setup' },
  history: [],
  canGoBack: false,
  navigate: (r) =>
    set((s) => ({
      route: r,
      history: [...s.history, s.route].slice(-30),
      canGoBack: true,
    })),
  goBack: () => {
    const { history } = get();
    const prev = history[history.length - 1];
    if (!prev) return;
    set({
      route: prev,
      history: history.slice(0, -1),
      canGoBack: history.length - 1 > 0,
    });
  },

  wallet: null,
  walletBootstrapped: false,
  bootError: null,
  setWallet: (wallet) => set({ wallet }),
  refreshWallet: async () => {
    try {
      const wallet = await window.api.wallet.refreshBalance();
      set({ wallet });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[refreshWallet]', e);
    }
  },
  logoutWallet: async () => {
    await window.api.wallet.logout();
    set({ wallet: null, history: [], canGoBack: false, route: { name: 'wallet-setup' } });
  },

  nodes: [],
  refreshNodes: async () => {
    try {
      set({ nodes: await window.api.nodes.list() });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[refreshNodes]', e);
    }
  },
  reapStuckNodes: async () => {
    try {
      const dropped = await window.api.nodes.reapStuck();
      get().pushToast(
        dropped > 0
          ? {
              title: `Cleared ${dropped} stuck node${dropped === 1 ? '' : 's'}`,
              body: 'Nodes whose containers were not running were dropped from the inventory.',
              tone: 'success',
            }
          : {
              title: 'Nothing to clear',
              body: 'No stuck local nodes were found.',
              tone: 'info',
            },
      );
      void get().refreshNodes();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[reapStuckNodes]', e);
      get().pushToast({
        title: 'Could not clear stuck nodes',
        body: e instanceof Error ? e.message : String(e),
        tone: 'error',
      });
    }
  },

  events: [],
  refreshEvents: async () => {
    try {
      const next = await window.api.events.list(50);
      const prev = get().events;
      set({ events: next });
      if (specsToastSeed) {
        // First refresh — seed without toasting so existing events don't fire.
        for (const e of next) if (e.kind === 'specs-reported') seenSpecsEventIds.add(e.id);
        specsToastSeed = false;
        return;
      }
      const prevIds = new Set(prev.map((e) => e.id));
      for (const e of next) {
        if (e.kind !== 'specs-reported') continue;
        if (prevIds.has(e.id) || seenSpecsEventIds.has(e.id)) continue;
        seenSpecsEventIds.add(e.id);
        get().pushToast({
          title: 'Hardware Specs posted On-Chain',
          body: e.subtitle ?? e.title,
          tone: 'success',
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[refreshEvents]', e);
    }
  },

  settings: null,
  refreshSettings: async () => {
    try {
      set({ settings: await window.api.settings.get() });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[refreshSettings]', e);
    }
  },
  saveSettings: async (patch) => set({ settings: await window.api.settings.set(patch) }),

  chainHealth: [],
  refreshChainHealth: async () => {
    try {
      set({ chainHealth: await window.api.settings.chainHealth() });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[refreshChainHealth]', e);
    }
  },

  liveStatuses: {},
  refreshStatus: async (id) => {
    // M-16 (TOCTOU): `nodes.status` is a multi-second RPC. While it's in
    // flight the fast-poller can push a *fresher* `nodes:live-status` frame
    // into the store. Without ordering, this slow result lands last and
    // overwrites the newer push with stale data (offline→online flicker).
    // Snapshot a wall-clock before the await and only apply if nothing newer
    // has written for this node since.
    const startedAt = Date.now();
    const status = await window.api.nodes.status(id);
    if ((liveStatusAt.get(id) ?? 0) <= startedAt) {
      liveStatusAt.set(id, Date.now());
      set((s) => ({ liveStatuses: { ...s.liveStatuses, [id]: status } }));
    }
    return status;
  },

  nodeHistory: {},
  loadHistory: async (id, w) => {
    const samples = await window.api.nodes.history(id, w);
    set((s) => ({ nodeHistory: { ...s.nodeHistory, [id]: samples } }));
    return samples;
  },

  progress: null,
  progressAt: null,
  setProgress: (progress) =>
    set({ progress, progressAt: progress ? Date.now() : null }),
  clearStuckDeploy: async () => {
    const p = get().progress;
    set({ progress: null, progressAt: null });
    if (!p) return;
    try {
      await window.api.deploy.cancel(p.jobId);
    } catch (e) {
      console.warn('[clearStuckDeploy] cancel failed', e);
    }
    get().clearDeployLog(p.jobId);
    void get().refreshNodes();
  },

  deployLogs: {},
  appendDeployLog: (jobId, chunk) =>
    set((s) => {
      const prev = s.deployLogs[jobId] ?? [];
      const next = [...prev];
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) next.push(line);
      }
      return { deployLogs: { ...s.deployLogs, [jobId]: next.slice(-1000) } };
    }),
  clearDeployLog: (jobId) =>
    set((s) => {
      if (!(jobId in s.deployLogs)) return s;
      const { [jobId]: _drop, ...rest } = s.deployLogs;
      return { deployLogs: rest };
    }),

  seedAck: {},
  acknowledgeSeed: (jobId) =>
    set((s) => ({
      seedAck: { ...s.seedAck, [jobId]: true },
      seedShowRequested: s.seedShowRequested === jobId ? null : s.seedShowRequested,
    })),
  seedShowRequested: null,
  requestSeedShow: (jobId) => set({ seedShowRequested: jobId }),
  clearSeedShowRequest: () => set({ seedShowRequested: null }),

  cliOutput: [INITIAL_CLI_ENTRY],
  cliHistory: [],
  cliServerState: null,
  appendCliOutput: (entry) =>
    set((s) => {
      const next = [...s.cliOutput, { id: cliOutputIdCounter++, ...entry }];
      return {
        cliOutput:
          next.length > CLI_OUTPUT_MAX ? next.slice(next.length - CLI_OUTPUT_MAX) : next,
      };
    }),
  clearCliOutput: () => set({ cliOutput: [] }),
  pushCliHistory: (line) =>
    set((s) => {
      const trimmed = line.trim();
      if (!trimmed) return s;
      const next = [...s.cliHistory, trimmed];
      return {
        cliHistory:
          next.length > CLI_HISTORY_MAX ? next.slice(next.length - CLI_HISTORY_MAX) : next,
      };
    }),
  setCliServerState: (cliServerState) => set({ cliServerState }),

  toasts: [],
  pushToast: (t) => {
    const id = genId();
    set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-5) }));
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  confirmPrompt: null,
  confirm: (opts) =>
    new Promise<boolean>((resolve) => {
      set({
        confirmPrompt: {
          ...opts,
          id: genId(),
          resolve,
        },
      });
    }),
  resolveConfirm: (ok) => {
    const p = get().confirmPrompt;
    if (!p) return;
    p.resolve(ok);
    set({ confirmPrompt: null });
  },

  online: typeof navigator !== 'undefined' ? navigator.onLine : true,

  systemLive: true,
  systemReporting: true,
  systemStats: null,
  setSystemLive: (systemLive) => {
    const prev = get().systemLive;
    set({ systemLive });
    if (systemLive === prev) return;
    if (systemLive) {
      void window.api.system.startLiveStats().catch((e: unknown) => {
        get().pushToast({
          title: 'Live Specs unavailable',
          body: e instanceof Error ? e.message : String(e),
          tone: 'error',
        });
        set({ systemLive: false });
      });
    } else {
      void window.api.system.stopLiveStats().catch(() => {});
      set({ systemStats: null });
    }
  },
  setSystemReporting: (systemReporting) => set({ systemReporting }),

  bootstrap: async () => {
    if (bootstrapped) return;
    bootstrapped = true;
    for (const off of subscriptions.splice(0)) {
      try { off(); } catch (e) { console.warn('[bootstrap] off-fn threw', e); }
    }
    try {
      const [walletR, nodesR, eventsR, settingsR, chainR] = await Promise.allSettled([
        window.api.wallet.get(),
        window.api.nodes.list(),
        window.api.events.list(50),
        window.api.settings.get(),
        window.api.settings.chainHealth(),
      ]);
      const wallet = walletR.status === 'fulfilled' ? walletR.value : null;
      const nodes = nodesR.status === 'fulfilled' ? nodesR.value : [];
      const events = eventsR.status === 'fulfilled' ? eventsR.value : [];
      const settings = settingsR.status === 'fulfilled' ? settingsR.value : null;
      const chainHealth = chainR.status === 'fulfilled' ? chainR.value : [];

      const critical = [walletR, settingsR].filter((r) => r.status === 'rejected');
      if (critical.length > 0 && !wallet && !settings) {
        const reason = (critical[0] as PromiseRejectedResult).reason;
        set({
          bootError:
            reason instanceof Error ? reason.message : String(reason ?? 'Bootstrap failed'),
          walletBootstrapped: true,
        });
        return;
      }

      const hasWallet = Boolean(wallet?.address);
      set({
        wallet,
        nodes,
        events,
        settings,
        chainHealth,
        walletBootstrapped: true,
        bootError: null,
        route: hasWallet ? { name: 'overview' } : { name: 'wallet-setup' },
      });

      // Per-jobId one-shot redirect + toast tracking. Without these the
      // subscriber re-fires on every `done` frame the main process
      // re-broadcasts (it caches the last frame and replays on resubscribe),
      // which yanks the user back to the Progress page after they've moved on
      // to Node Details. One terminal frame, one redirect, one toast.
      const handledDoneJobs = new Set<string>();
      const handledErrorJobs = new Set<string>();
      subscriptions.push(
        window.api.deploy.onProgress((p) => {
          get().setProgress(p);
          if (p.log) get().appendDeployLog(p.jobId, p.log);
          if (p.phase === 'done') {
            // H-7: the mnemonic-backup redirect must NOT be gated by
            // `handledDoneJobs`. That set persists for the renderer's life, so
            // when the main process replays its cached `done` frame after an
            // IPC re-subscribe (no full page reload), `handledDoneJobs.has`
            // would short-circuit and silently skip the redirect — a path
            // where the user never sees their recovery phrase. The redirect's
            // real one-shot guard is `seedAck` (set when the user saves the
            // phrase), so drive it off that and run it every replayed frame
            // until acked. Only the toast + node refresh dedupe on the set.
            const ackd = get().seedAck[p.jobId];
            if (p.mnemonicForBackup && !ackd) {
              const currentRoute = get().route;
              const onProgressForJob =
                currentRoute.name === 'progress' && currentRoute.jobId === p.jobId;
              if (!onProgressForJob) {
                const node = get().nodes.find((n) => n.id === p.nodeId);
                get().navigate({
                  name: 'progress',
                  jobId: p.jobId,
                  moniker: node?.moniker ?? 'node',
                  origin: node?.target === 'remote' ? 'ssh' : 'local',
                });
              }
            }
            if (handledDoneJobs.has(p.jobId)) return;
            handledDoneJobs.add(p.jobId);
            get().pushToast({
              title: 'Node deployed',
              body: `${p.message} · ${p.operatorAddress?.slice(0, 12) ?? ''}…`,
              tone: 'success',
            });
            void get().refreshNodes();
          } else if (p.phase === 'error') {
            if (handledErrorJobs.has(p.jobId)) return;
            handledErrorJobs.add(p.jobId);
            get().pushToast({ title: 'Deployment failed', body: p.message, tone: 'error' });
            void get().refreshNodes();
          }
        }),
      );

      // Rehydrate any deploy that was already running before this renderer
      // mounted (app reload mid-deploy, or tab change followed by a hot
      // refresh). We pull whatever the main process has cached, restore the
      // store, and route the user back onto the Progress screen if they were
      // still mid-flight.
      try {
        const live = await window.api.deploy.status();
        const list = Array.isArray(live) ? live : live ? [live] : [];
        const active = list.find((p) => p.phase !== 'error' && p.phase !== 'cancelled');
        if (active) {
          set({ progress: active });
          if (active.log) get().appendDeployLog(active.jobId, active.log);
          // Route back to Progress if the deploy is still mid-flight, OR if
          // it finished but the user never acked the recovery phrase.
          const seedUnacked =
            active.phase === 'done' &&
            !!active.mnemonicForBackup &&
            !get().seedAck[active.jobId];
          if (hasWallet && (active.phase !== 'done' || seedUnacked)) {
            const node = nodes.find((n) => n.id === active.nodeId);
            get().navigate({
              name: 'progress',
              jobId: active.jobId,
              moniker: node?.moniker ?? 'node',
              origin: node?.target === 'remote' ? 'ssh' : 'local',
            });
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[bootstrap] deploy.status rehydrate failed', e);
      }
      subscriptions.push(window.api.nodes.onChanged(() => void get().refreshNodes()));
      subscriptions.push(
        window.api.nodes.onLiveStatus((u) => {
          // The push is the freshest real-time signal — always apply it and
          // stamp the freshness clock so an in-flight refreshStatus() RPC
          // can't later clobber it with a staler result (M-16 TOCTOU).
          liveStatusAt.set(u.nodeId, Date.now());
          set((s) => ({ liveStatuses: { ...s.liveStatuses, [u.nodeId]: u.status } }));
        }),
      );
      subscriptions.push(window.api.events.onChanged(() => void get().refreshEvents()));

      // Live system stats — subscribe at bootstrap so the sampler keeps
      // running across screen navigation. Default-on per Manifesto: the
      // System page should already be sampling when the user opens it.
      subscriptions.push(
        window.api.system.onLiveStats((s) => set({ systemStats: s })),
      );
      if (get().systemLive) {
        void window.api.system.startLiveStats().catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.warn('[bootstrap] startLiveStats failed', e);
          set({ systemLive: false });
        });
      }

      // CLI session — subscribe once at bootstrap so events accumulate across
      // screen navigation. The CLI screen reads from store.cliOutput and never
      // owns the buffer itself.
      const cli = window.api?.cli;
      if (cli) {
        void cli.status().then((s) => get().setCliServerState(s));
        subscriptions.push(cli.onStateChanged((s) => get().setCliServerState(s)));
        subscriptions.push(
          cli.onStream((ev: CliStreamEvent) => {
            if (ev.seq <= cliLastSeq) return;
            cliLastSeq = ev.seq;
            let poll = false;
            const src = ev.source ?? 'app';
            if (ev.kind === 'input') {
              poll = isPollInput(ev.text);
              cliPendingPollBySource.set(src, poll);
            } else if (ev.kind === 'ok' || ev.kind === 'err') {
              poll = cliPendingPollBySource.get(src) === true;
              cliPendingPollBySource.delete(src);
            } else if (ev.kind === 'info' && ev.source === 'system') {
              poll =
                /connected\. In-app prompt is now read-only/.test(ev.text) ||
                /disconnected\. In-app prompt re-enabled/.test(ev.text);
            }
            get().appendCliOutput({ kind: ev.kind, source: ev.source, text: ev.text, poll });
          }),
        );
      }

      // H-6: register window listeners through named handlers and push their
      // removal into `subscriptions` (the same teardown `bootstrap`'s
      // `subscriptions.splice(0)` runs at the top). Previously these were
      // anonymous addEventListener calls with no matching removeEventListener,
      // so every re-bootstrap (e.g. the boot-error "Reload window" path)
      // stacked another permanent set of global listeners.
      const onOnline = () => set({ online: true });
      const onOffline = () => set({ online: false });
      const onKeydown = (e: KeyboardEvent) => {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key === 'r') {
          e.preventDefault();
          void get().refreshWallet();
          void get().refreshNodes();
        }
        if (mod && e.key === ',') {
          e.preventDefault();
          get().navigate({ name: 'settings' });
        }
        if (e.key === 'Escape') {
          if (get().confirmPrompt) get().resolveConfirm(false);
        }
      };
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      window.addEventListener('keydown', onKeydown);
      subscriptions.push(
        () => window.removeEventListener('online', onOnline),
        () => window.removeEventListener('offline', onOffline),
        () => window.removeEventListener('keydown', onKeydown),
      );

      if (hasWallet) void get().refreshWallet();
    } catch (e) {
      bootstrapped = false;
      set({
        bootError: e instanceof Error ? e.message : String(e),
        walletBootstrapped: true,
      });
    }
  },
}));

let bootstrapped = false;
const subscriptions: Array<() => void> = [];
// Monotonic id counter for CLI output entries. Module-scope so it survives
// store rehydration and never collides with previously-rendered entries.
let cliOutputIdCounter = 1;
// Highest CLI stream `seq` we've consumed; lets us drop duplicates if the
// renderer reconnects mid-session.
let cliLastSeq = -1;
// Per-source flag tracking whether the most recent input event was a poll
// command, so the matching ok/err reply gets the same `poll` tag. Keyed by
// source so two concurrent clients (app/shell/agent) can't cross-tag.
const cliPendingPollBySource = new Map<string, boolean>();
// M-16: per-node wall-clock of the last applied live-status write (push or
// on-demand RPC). Lets `refreshStatus` discard its own result when a fresher
// frame landed during its in-flight RPC, preventing offline→online flicker.
const liveStatusAt = new Map<string, number>();
