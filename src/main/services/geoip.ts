import { log } from './logger';

interface GeoipResult {
  country: string;
  countryName: string;
}

const cache = new Map<string, GeoipResult>();

/**
 * True for RFC1918 / loopback IPv4 literals (and `localhost`). Parses octets
 * so the 172.16/12 block is matched correctly — the old prefix check
 * (`startsWith('172.2')`) falsely flagged public IPs 172.200–172.255 as
 * private while the real range is only 172.16.0.0 – 172.31.255.255.
 * Non-IPv4 strings (hostnames, IPv6) fall through and are treated as public.
 */
function isPrivateOrLoopback(key: string): boolean {
  if (key === 'localhost') return true;
  const m = key.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const oct = m.slice(1).map(Number);
  if (oct.some((o) => o > 255)) return false;
  const [a, b] = oct;
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
  return false;
}

/**
 * Resolve a host / IP to an ISO-3166-1 alpha-2 country code using the free
 * https://ipwho.is/ endpoint (no API key, no rate-limit headers in normal
 * use). Falls back to undefined on any failure — callers must handle that.
 * Results are cached per-process.
 */
export async function resolveCountry(host: string): Promise<GeoipResult | undefined> {
  const key = host.trim().toLowerCase();
  if (!key) return undefined;
  if (cache.has(key)) return cache.get(key);

  // Skip obviously private / loopback literals — they will just return a
  // private-network error and waste a request.
  if (isPrivateOrLoopback(key)) {
    return undefined;
  }

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(key)}`, {
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      success?: boolean;
      country_code?: string;
      country?: string;
    };
    if (!body.success || !body.country_code) return undefined;
    const out: GeoipResult = {
      country: body.country_code.toUpperCase(),
      countryName: body.country ?? body.country_code.toUpperCase(),
    };
    cache.set(key, out);
    return out;
  } catch (err) {
    log.debug('geoip lookup failed', { host: key, err: (err as Error).message });
    return undefined;
  }
}
