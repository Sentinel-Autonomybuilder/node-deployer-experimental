import { app, BrowserWindow, crashReporter, nativeImage, session, shell } from 'electron';
import path from 'node:path';
import { registerIpcHandlers } from './ipc';
import { attachGlobalHandlers, log, logDir } from './services/logger';
import { restartPollerCadence, startPoller, stopPoller } from './services/node-manager';
import { replayPendingSpecs } from './services/node-specs';
import { refreshWalletBalance } from './services/wallet';
import { primeDeploySettings } from './services/deploy';
import { startUpdater, stopUpdater } from './services/updater';
import { getSettings, onSettingsChanged } from './services/settings';
import { isCliServerRunning, startCliServer, stopCliServer } from './services/cli-server';
import type { AppSettings } from '../shared/types';
import {
  createAppTray,
  destroyAppTray,
  isQuittingForReal,
  isTrayActive,
  markQuittingForReal,
  maybeShowTrayHint,
} from './services/tray';

function resolveAppIcon(): Electron.NativeImage | undefined {
  const candidates =
    process.platform === 'win32'
      ? ['icon.ico', 'icon.png']
      : process.platform === 'darwin'
        ? ['icon.icns', 'icon.png']
        : ['icon.png'];
  const roots = [
    path.join(process.resourcesPath ?? '', 'build'),
    path.join(app.getAppPath(), 'build'),
    path.join(__dirname, '..', '..', 'build'),
  ];
  for (const root of roots) {
    for (const name of candidates) {
      const p = path.join(root, name);
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
  }
  return undefined;
}

// `__dirname` is available in CJS output.

attachGlobalHandlers();
crashReporter.start({
  productName: 'Sentinel Node Manager',
  submitURL: '',        // no remote submit; we store dumps locally
  uploadToServer: false,
  compress: true,
});

// Single-instance lock — avoids two app windows racing to manage the same node.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // We're the second instance. Quit immediately; the primary will get a
  // `second-instance` event and surface its window. `app.quit()` alone only
  // schedules teardown, so guard the rest of module init from running and
  // briefly spinning up a poller/updater that we're about to tear down.
  app.quit();
} else {
  // L-7: without a `second-instance` handler the user's second launch (or a
  // file double-click that re-invokes the exe) was silently swallowed — the
  // app would appear "not to open". Restore + focus the existing window so a
  // re-launch behaves like a click on the taskbar icon.
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });
}

function createWindow(): BrowserWindow {
  const icon = resolveAppIcon();
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1060,
    minHeight: 720,
    title: 'Sentinel Node Manager',
    icon,
    backgroundColor: '#0B1020',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      // sandbox the renderer so a renderer compromise can't reach raw Node
      // APIs through the preload's CJS context. The preload itself runs in
      // a sandboxed context and only uses electron's contextBridge + ipcRenderer.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  win.on('ready-to-show', () => win.show());
  win.on('page-title-updated', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (isQuittingForReal()) return;
    if (!currentSettingsSnapshot?.minimizeToTrayOnClose) return;
    // If the tray failed to materialise (missing icon assets on an exotic
    // build), don't trap the user with a window they can't reopen.
    if (!isTrayActive()) return;
    e.preventDefault();
    win.hide();
    void maybeShowTrayHint();
    void getSettings().then((s) => {
      currentSettingsSnapshot = s;
    }).catch((err) => log.debug('refresh settings snapshot failed', { err: String(err) }));
  });

  // Only forward https/mailto links to the OS shell. Blocks file:, javascript:,
  // data:, and any custom-protocol vector that could pivot through the OS
  // handler chain. http:// is intentionally excluded — we never embed plain
  // http links and rejecting them surfaces accidents early.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' || u.protocol === 'mailto:') {
        void shell.openExternal(url);
      } else {
        log.warn('blocked window-open with disallowed scheme', { protocol: u.protocol });
      }
    } catch {
      // Malformed URL — silently drop.
    }
    return { action: 'deny' };
  });

  // Defence-in-depth: forbid in-window navigation to off-origin URLs.
  // Renderer should only ever load app:// (file://) or the dev server.
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl && url.startsWith(devUrl)) return;
    if (url.startsWith('file://')) return;
    e.preventDefault();
    log.warn('blocked in-window navigation', { url });
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return win;
}

let balancePoll: NodeJS.Timeout | null = null;
let currentSettingsSnapshot: AppSettings | null = null;

function startBalancePoll(intervalSec: number): void {
  if (balancePoll) {
    clearInterval(balancePoll);
    balancePoll = null;
  }
  const ms = Math.max(10, Math.min(600, Math.round(intervalSec))) * 1000;
  balancePoll = setInterval(() => {
    void refreshWalletBalance().catch((err) =>
      log.debug('balance poll skipped', { err: String(err) }),
    );
  }, ms);
}

function installContentSecurityPolicy(): void {
  // Defence-in-depth CSP injected as a response header — backstops anything
  // a future renderer change could introduce (inline <script>, dynamic eval,
  // off-origin fetch). The renderer never talks to the network directly:
  // all outbound traffic crosses the IPC bridge into main. So the policy is
  // strict in prod (self only) and slightly looser in dev to accommodate
  // Vite HMR (inline bootstrap script + ws: socket).
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  const isDev = !!devUrl;
  let devOrigin = '';
  let devWsOrigin = '';
  if (isDev) {
    try {
      const u = new URL(devUrl);
      devOrigin = `${u.protocol}//${u.host}`;
      devWsOrigin = `ws://${u.host} wss://${u.host}`;
    } catch {
      // malformed dev URL — fall through to prod-style CSP
    }
  }
  const policy = isDev
    ? [
        `default-src 'self' ${devOrigin}`,
        `script-src 'self' ${devOrigin} 'unsafe-inline' 'unsafe-eval'`,
        `style-src 'self' ${devOrigin} 'unsafe-inline'`,
        `img-src 'self' ${devOrigin} data: blob:`,
        `font-src 'self' ${devOrigin} data:`,
        `connect-src 'self' ${devOrigin} ${devWsOrigin}`,
        `object-src 'none'`,
        `frame-src 'none'`,
        `base-uri 'self'`,
        `form-action 'none'`,
      ].join('; ')
    : [
        `default-src 'self'`,
        `script-src 'self'`,
        `style-src 'self' 'unsafe-inline'`, // many React style-prop usages emit inline styles
        `img-src 'self' data: blob:`,
        `font-src 'self' data:`,
        `connect-src 'self'`,
        `object-src 'none'`,
        `frame-src 'none'`,
        `base-uri 'self'`,
        `form-action 'none'`,
      ].join('; ');
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    headers['Content-Security-Policy'] = [policy];
    callback({ responseHeaders: headers });
  });
}

app.whenReady().then(async () => {
  // Second instance: the lock was denied and app.quit() is already scheduled.
  // Bail before we initialise services we're about to tear down.
  if (!gotSingleInstanceLock) return;
  installContentSecurityPolicy();
  log.info('app ready', {
    version: app.getVersion(),
    platform: process.platform,
    logs: logDir(),
  });

  try {
    await primeDeploySettings();
  } catch (err) {
    log.warn('primeDeploySettings failed', { err: String(err) });
  }
  try {
    currentSettingsSnapshot = await getSettings();
  } catch (err) {
    log.warn('initial getSettings failed', { err: String(err) });
  }
  registerIpcHandlers();
  // CLI auto-start is gated behind a token to avoid silent surface-area
  // increase. Setting SNM_AUTO_START_CLI=1 alone is no longer enough — the
  // user must also export SNM_AUTO_START_CLI_TOKEN with the literal value
  // "i-understand-this-opens-a-local-control-channel". Without the token
  // the env var is ignored and we log a one-line refusal.
  if (process.env.SNM_AUTO_START_CLI === '1') {
    const ACK = 'i-understand-this-opens-a-local-control-channel';
    if (process.env.SNM_AUTO_START_CLI_TOKEN === ACK) {
      try {
        await startCliServer();
        log.info('cli server auto-started via SNM_AUTO_START_CLI');
      } catch (err) {
        log.warn('cli auto-start failed', { err: String(err) });
      }
    } else {
      log.warn('SNM_AUTO_START_CLI set but SNM_AUTO_START_CLI_TOKEN missing — refusing to auto-start CLI');
    }
  }
  try {
    startUpdater();
  } catch (err) {
    log.warn('startUpdater failed', { err: String(err) });
  }
  try {
    startPoller();
  } catch (err) {
    log.warn('startPoller failed', { err: String(err) });
  }

  // Best-effort retry for any node whose `specs:v1` publish didn't make
  // it through last session (RPC pool down, app killed mid-broadcast).
  // Sequential, gentle, fire-and-forget — UI doesn't wait on it.
  void replayPendingSpecs().catch((err) =>
    log.warn('replayPendingSpecs failed', { err: String(err) }),
  );

  const win = createWindow();
  try {
    createAppTray(() => BrowserWindow.getAllWindows()[0] ?? null);
  } catch (err) {
    log.warn('tray setup failed', { err: String(err) });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else BrowserWindow.getAllWindows()[0]?.show();
  });

  startBalancePoll(currentSettingsSnapshot?.walletRefreshIntervalSec ?? 60);

  onSettingsChanged((next) => {
    const prev = currentSettingsSnapshot;
    currentSettingsSnapshot = next;
    if (!prev || prev.walletRefreshIntervalSec !== next.walletRefreshIntervalSec) {
      startBalancePoll(next.walletRefreshIntervalSec);
    }
    if (!prev || prev.nodeRefreshIntervalSec !== next.nodeRefreshIntervalSec) {
      try {
        restartPollerCadence(next.nodeRefreshIntervalSec);
      } catch (err) {
        log.warn('restartPollerCadence failed', { err: String(err) });
      }
    }
  });

  void win;
}).catch((err) => {
  log.error('whenReady init failed', { err: String(err) });
});

app.on('window-all-closed', () => {
  // With tray minimize enabled, the window can be hidden without the app
  // exiting — keep the poller alive so earnings/peers stay fresh. If the
  // user explicitly picks "Quit" from the tray we flip `isQuittingForReal`
  // and fall through to the normal cleanup.
  if (!isQuittingForReal() && currentSettingsSnapshot?.minimizeToTrayOnClose) return;
  if (balancePoll) clearInterval(balancePoll);
  stopPoller();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  markQuittingForReal();
  log.info('app quitting');
  if (balancePoll) clearInterval(balancePoll);
  stopPoller();
  stopUpdater();
  destroyAppTray();
  // Stop the CLI server if the user opted in (default true). Best-effort —
  // we don't await here because before-quit is synchronous; the underlying
  // server.close() runs to completion as the event loop drains.
  if (isCliServerRunning() && currentSettingsSnapshot?.stopCliServerOnQuit !== false) {
    void stopCliServer().catch((err) =>
      log.debug('stopCliServer on quit failed', { err: String(err) }),
    );
  }
});
