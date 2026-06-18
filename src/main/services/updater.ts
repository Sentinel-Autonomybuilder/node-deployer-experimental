import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { IPC_UPDATER, type UpdateInfo } from '../../shared/updater-types';
import { log } from './logger';

/**
 * Auto-updater.
 *
 * We publish releases to GitHub Releases (configured in electron-builder.yml
 * via the default `github` provider). The renderer can:
 *   • query current status via `updater:status`
 *   • manually trigger a check via `updater:check`
 *   • invoke `updater:install` to quit + install a downloaded update
 *
 * Builds without a GitHub release channel (dev / unsigned local) simply
 * have the checks no-op with a clear status value.
 */

type Stage = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'up-to-date';

interface State {
  stage: Stage;
  version?: string;
  percent?: number;
  error?: string;
  checkedAt?: number;
}

let state: State = { stage: 'idle' };
let initialCheckTimer: NodeJS.Timeout | null = null;

export function getUpdaterState(): State {
  return state;
}

export async function checkForUpdatesNow(): Promise<State> {
  if (!app.isPackaged) return state;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    update({ stage: 'error', error: (err as Error).message });
  }
  return state;
}

export function installPendingUpdate(): { ok: boolean; error?: string } {
  if (!app.isPackaged) return { ok: false, error: 'Dev mode — updater disabled' };
  if (state.stage !== 'ready') return { ok: false, error: 'No update ready' };
  setImmediate(() => autoUpdater.quitAndInstall());
  return { ok: true };
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_UPDATER.CHANGED, state);
  }
}

function update(partial: Partial<State>): void {
  state = { ...state, ...partial };
  broadcast();
}

export function startUpdater(): void {
  // In dev (unpackaged) electron-updater throws on init; skip entirely.
  if (!app.isPackaged) {
    update({ stage: 'idle', error: 'Dev mode — updater disabled' });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = log;

  autoUpdater.on('checking-for-update', () => update({ stage: 'checking' }));
  autoUpdater.on('update-available', (info: UpdateInfo) =>
    update({ stage: 'downloading', version: info.version, percent: 0 }),
  );
  autoUpdater.on('update-not-available', () =>
    update({ stage: 'up-to-date', checkedAt: Date.now() }),
  );
  autoUpdater.on('download-progress', (p) =>
    update({ stage: 'downloading', percent: Math.round(p.percent) }),
  );
  autoUpdater.on('update-downloaded', (info: UpdateInfo) =>
    update({ stage: 'ready', version: info.version, percent: 100 }),
  );
  autoUpdater.on('error', (err: Error) =>
    update({ stage: 'error', error: err.message }),
  );

  ipcMain.handle(IPC_UPDATER.STATUS, () => state);
  ipcMain.handle(IPC_UPDATER.CHECK, async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      update({ stage: 'error', error: (err as Error).message });
    }
    return state;
  });
  ipcMain.handle(IPC_UPDATER.INSTALL, async () => {
    if (state.stage !== 'ready') return { ok: false, error: 'No update ready' };
    // Ask the user before quitting. L-12: `win` can be undefined when the app
    // is running tray-only (all windows hidden/closed). The (message, options)
    // overload of showMessageBox shows a windowless dialog; passing
    // `undefined` as the parent is unpredictable across platforms, so branch
    // on whether we actually have a window.
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Install + restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Install Sentinel Node Manager v${state.version}?`,
      detail: 'The app will quit and reopen on the new version.',
    };
    const choice = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts);
    if (choice.response === 0) {
      setImmediate(() => autoUpdater.quitAndInstall());
    }
    return { ok: choice.response === 0 };
  });

  // Quiet initial check once the window has painted. L-12: keep the handle so
  // a quit during the 15 s window cancels it instead of firing a check (and a
  // potential `error` state update / broadcast) against a tearing-down app.
  initialCheckTimer = setTimeout(() => {
    initialCheckTimer = null;
    autoUpdater.checkForUpdates().catch((err) => {
      update({ stage: 'error', error: String(err) });
    });
  }, 15_000);
  initialCheckTimer.unref?.();
}

/**
 * Cancel the pending startup check. Called from `before-quit` so a quit
 * inside the initial 15 s delay doesn't kick off a network check against an
 * app that's already tearing down.
 */
export function stopUpdater(): void {
  if (initialCheckTimer) {
    clearTimeout(initialCheckTimer);
    initialCheckTimer = null;
  }
}
