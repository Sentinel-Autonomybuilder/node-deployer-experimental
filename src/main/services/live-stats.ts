import os from 'node:os';
import { BrowserWindow, type WebContents } from 'electron';
import { IPC, type LiveSystemStats } from '../../shared/types';
import { log } from './logger';

const SAMPLE_INTERVAL_MS = 1000;

let timer: NodeJS.Timeout | null = null;
// L-10: refcount by the actual renderer that subscribed, not a raw call
// counter. A renderer reload (or a window close without a clean toggle-off)
// re-runs bootstrap → startLiveStats but never fires the matching
// stopLiveStats, so the old counter climbed monotonically and the 1 Hz
// interval leaked forever. Keying on webContents.id + a one-shot `destroyed`
// listener makes the count self-heal when a subscriber goes away.
const subscribers = new Map<number, WebContents>();
const destroyHandlers = new Map<number, () => void>();
let prevCpuTimes: ReturnType<typeof readCpuTimes> | null = null;

interface CoreTimes {
  idle: number;
  total: number;
}

function readCpuTimes(): CoreTimes[] {
  return os.cpus().map((c) => {
    const t = c.times;
    const total = t.user + t.nice + t.sys + t.idle + t.irq;
    return { idle: t.idle, total };
  });
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function sampleAndBroadcast(): void {
  const now = readCpuTimes();
  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  const freeMb = Math.round(os.freemem() / (1024 * 1024));

  let perCore: number[];
  if (prevCpuTimes && prevCpuTimes.length === now.length) {
    perCore = now.map((cur, i) => {
      const prev = prevCpuTimes![i]!;
      const idleDiff = cur.idle - prev.idle;
      const totalDiff = cur.total - prev.total;
      if (totalDiff <= 0) return 0;
      return Math.max(0, Math.min(100, ((totalDiff - idleDiff) / totalDiff) * 100));
    });
  } else {
    // First sample: no previous baseline, report 0 rather than a misleading
    // since-boot average.
    perCore = now.map(() => 0);
  }
  prevCpuTimes = now;

  const avg =
    perCore.length > 0
      ? perCore.reduce((a, b) => a + b, 0) / perCore.length
      : 0;

  const sample: LiveSystemStats = {
    ts: Date.now(),
    freeMemoryMb: freeMb,
    usedMemoryMb: Math.max(0, totalMb - freeMb),
    totalMemoryMb: totalMb,
    cpuLoadPct: avg,
    cpuPerCorePct: perCore,
  };
  broadcast(IPC.SYSTEM_LIVE_STATS, sample);
}

function ensureTimer(): void {
  if (timer) return;
  // Prime the baseline so the first user-visible sample is real, not 0.
  prevCpuTimes = readCpuTimes();
  timer = setInterval(sampleAndBroadcast, SAMPLE_INTERVAL_MS);
}

function dropSubscriber(id: number): void {
  const off = destroyHandlers.get(id);
  if (off) {
    off();
    destroyHandlers.delete(id);
  }
  subscribers.delete(id);
  if (subscribers.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
    prevCpuTimes = null;
  }
}

/**
 * Begin (or join) the live-stats stream for a specific renderer. Pass the
 * subscribing webContents so we can auto-release when it reloads or its
 * window is destroyed; without a sender we fall back to a single anonymous
 * subscription keyed to slot 0 (legacy callers).
 */
export function startLiveStats(sender?: WebContents): void {
  const id = sender?.id ?? 0;
  if (!subscribers.has(id)) {
    subscribers.set(id, sender ?? (null as unknown as WebContents));
    if (sender) {
      const onGone = () => dropSubscriber(id);
      // `destroyed` covers window close; `did-start-navigation` to a new
      // document (reload) tears the old renderer down too. We only need the
      // destroyed signal — a reload destroys and recreates the webContents'
      // render frame, and the fresh bootstrap re-subscribes.
      sender.once('destroyed', onGone);
      destroyHandlers.set(id, () => {
        try {
          sender.removeListener('destroyed', onGone);
        } catch (e) {
          log.debug('live-stats: removeListener failed', { err: String(e) });
        }
      });
    }
  }
  ensureTimer();
}

export function stopLiveStats(sender?: WebContents): void {
  dropSubscriber(sender?.id ?? 0);
}

export function stopAllLiveStats(): void {
  for (const id of [...subscribers.keys()]) dropSubscriber(id);
}
