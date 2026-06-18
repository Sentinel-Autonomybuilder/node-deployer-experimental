/**
 * UI-side formatters. Keep in one place so the "DVPN is the technical
 * denom, $P2P is the brand" distinction is a single source of truth.
 *
 *   - On-chain / protocol: `udvpn` (micro) and `DVPN` (display denom)
 *   - User-facing label: `$P2P`
 *
 * `fmtAmount` returns just the number. `fmtToken(n)` returns
 * `"12.34 $P2P"` which is the string to render anywhere in the UI.
 */

/** Brand label for the coin. Do NOT use this for chain-level strings. */
export const TOKEN_LABEL = '$P2P';

export const fmtAmount = (n: number, digits = 2): string =>
  // NaN/±Infinity render as literal "NaN"/"∞" through toLocaleString, which
  // leaks into balances and prices. Collapse non-finite input to 0 first.
  (Number.isFinite(n) ? n : 0).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/** `<amount> $P2P` — the canonical rendering for any on-screen balance. */
export const fmtToken = (n: number, digits = 2): string =>
  `${fmtAmount(n, digits)} ${TOKEN_LABEL}`;

/** Back-compat alias — call sites can keep using fmtDVPN, but it now
 *  emits the branded amount only (no denom suffix). Add the label at the
 *  call site, or migrate to fmtToken. */
export const fmtDVPN = fmtAmount;

export const fmtUSD = (n: number): string =>
  (Number.isFinite(n) ? n : 0).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });

export const fmtBytes = (bytes: number, digits = 1): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / Math.pow(1024, i);
  return `${fmtAmount(n, i === 0 ? 0 : digits)} ${units[i]}`;
};

export const shortAddr = (addr: string | null | undefined, head = 8, tail = 6): string => {
  if (!addr) return '—';
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
};

export const relativeTime = (iso: string): string => {
  const then = new Date(iso).getTime();
  // Invalid/unparseable timestamps yield NaN, which propagates through every
  // branch below as "NaNm ago". Surface a stable placeholder instead.
  if (!Number.isFinite(then)) return '—';
  const diff = Math.max(0, Date.now() - then);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};
