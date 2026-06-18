import type { SSHCredentials } from '../shared/types';

// ─── Shared input validators ────────────────────────────────────────────────
//
// Both the IPC layer (renderer-facing) and the CLI registry (local-socket /
// scripting-facing) accept untrusted, externally-shaped payloads. They MUST
// run them through the same validators so the two entry points can't diverge
// — M-13 was exactly this: `ssh.test` / `deploy.start` in the CLI registry
// constructed SSHCredentials by hand, skipping the bounds + charset checks the
// IPC handlers enforce via vSSHCredentials. Centralising the validators here
// makes the single-source-of-truth explicit and import-cycle-free.

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Permits IPv4 + hostnames. IPv6-in-brackets is rejected here on purpose.
export const HOSTNAME_RE = /^[a-zA-Z0-9.\-:_]{1,255}$/;
export const USERNAME_RE = /^[a-zA-Z0-9._\-]{1,32}$/;

export function vUUID(id: unknown, label: string): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new Error(`Invalid ${label}: expected UUID`);
  }
  return id;
}

export function vSSHCredentials(raw: unknown): SSHCredentials {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid SSH credentials');
  const c = raw as Record<string, unknown>;
  const host = String(c.host ?? '');
  if (!HOSTNAME_RE.test(host)) throw new Error('Invalid SSH host');
  const port = Number(c.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid SSH port');
  }
  const username = String(c.username ?? '');
  if (!USERNAME_RE.test(username)) throw new Error('Invalid SSH username');
  // password / privateKey / passphrase: pass-through. Length-bound only
  // to avoid trivial DoS via gigabyte payloads.
  const cap = (s: unknown, max: number): string | undefined => {
    if (s === undefined || s === null) return undefined;
    const v = String(s);
    if (v.length > max) throw new Error('SSH credential field too long');
    return v;
  };
  return {
    host,
    port,
    username,
    password: cap(c.password, 4096),
    privateKey: cap(c.privateKey, 32_768),
    passphrase: cap(c.passphrase, 4096),
  } as SSHCredentials;
}
