import os from 'node:os';
import { statfs } from 'node:fs/promises';
import type { LocalSystemReport } from '../../shared/types';
import { dockerHealth } from './docker';
import { log } from './logger';

// Minimum free space we consider healthy for building the node image +
// pulling layers. The first sentinel-dvpnx build is multi-GB.
const DISK_MIN_FREE_GB = 10;

/**
 * Real free-disk-space probe. `fs.statfs` (Node 18.15+/20) gives us the
 * filesystem holding the app's home dir, which is where Docker's data root
 * and our config live on every supported platform. Returns null if the
 * platform/runtime can't answer so the report can degrade gracefully rather
 * than fabricate a number.
 */
async function diskFreeGb(): Promise<number | null> {
  try {
    const stats = await statfs(os.homedir());
    const freeBytes = stats.bavail * stats.bsize;
    if (!Number.isFinite(freeBytes) || freeBytes < 0) return null;
    return Math.round(freeBytes / 1024 ** 3);
  } catch (err) {
    log.warn('disk free probe failed — disk health reported as unknown', {
      err: String(err),
    });
    return null;
  }
}

/**
 * Single source of truth for `LocalSystemReport`. The IPC handler and the
 * CLI registry both call this so the System page and the `system status`
 * CLI command always agree.
 */
export async function buildLocalSystemReport(): Promise<LocalSystemReport> {
  const platform = os.platform();
  const arch = os.arch();
  const memMb = Math.round(os.totalmem() / (1024 * 1024));
  const freeMb = Math.round(os.freemem() / (1024 * 1024));
  const cpus = os.cpus();
  // Some Windows / VM kernels pad the model with trailing whitespace and
  // double spaces ("AMD Ryzen 9 7940HS w/ Radeon 780M Graphics     ").
  const rawModel = cpus[0]?.model?.replace(/\s+/g, ' ').trim() ?? '';
  const cpuModel = rawModel.length > 0 ? rawModel : 'Unknown CPU';
  const cpuCores = cpus.length;
  const cpuSpeedMhz = cpus[0]?.speed ?? 0;

  const osLabel =
    platform === 'darwin'
      ? `macOS ${os.release()}`
      : platform === 'linux'
        ? `Linux ${os.release()}`
        : platform === 'win32'
          ? `Windows ${os.release()}`
          : `${platform} ${os.release()}`;

  const health = await dockerHealth();
  const dockerReachable = health.reachable;

  const freeGb = await diskFreeGb();
  const wsl2Backend =
    platform === 'win32' && (health.desktop?.installed ?? false);

  return {
    osCompatible: ['darwin', 'linux', 'win32'].includes(platform),
    osLabel,
    platform,
    arch,
    memoryMb: memMb,
    memoryOk: memMb >= 2048,
    freeMemoryMb: freeMb,
    cpuModel,
    cpuCores,
    cpuSpeedMhz,
    // Real probe; if the platform can't answer we report 0 free but leave
    // diskOk true so an unknown reading never blocks deploy with a false
    // "low disk" gate.
    diskFreeGb: freeGb ?? 0,
    diskOk: freeGb === null ? true : freeGb >= DISK_MIN_FREE_GB,
    dockerInstalled: dockerReachable || (health.desktop?.installed ?? false),
    dockerVersion: health.version,
    dockerReachable,
    dockerError: health.error,
    dockerReason: health.reason,
    dockerDesktop: health.desktop,
    wsl2Backend,
    // CQAP detection mechanism is not yet decided. Keeping this isolated
    // so when the product call lands (image-flag / sidecar / endpoint /
    // chain-marker) only this block changes.
    cqap: 'unknown',
    cqapDetail: 'Detection coming soon — CQAP integration is in progress.',
  };
}

