import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { MIcon } from '../components/MIcon';
import { useApp } from '../store/app';
import { ProtocolTiles } from './DeployLocal';
import type {
  DeployPhase,
  DeployProgress,
  SSHCredentials,
  SSHTestResult,
  VpnServiceType,
} from '../../../shared/types';

type RowStatus =
  | 'idle'
  | 'testing'
  | 'test-ok'
  | 'test-fail'
  | 'queued'
  | 'deploying'
  | 'done'
  | 'error';

interface Row {
  id: string;
  host: string;
  port: number;
  username: string;
  moniker: string;
  nodePort: number;
  remoteUrlOverride: string;
  status: RowStatus;
  testMessage?: string;
  jobId?: string;
  phase?: DeployPhase;
  percent?: number;
  message?: string;
  authOverride?: 'key' | 'password';
  privateKeyOverride?: string;
  passphraseOverride?: string;
  passwordOverride?: string;
}

const TERMINAL_PHASES = new Set<DeployPhase>(['done', 'error', 'cancelled']);

function newRow(seed?: Partial<Row>): Row {
  return {
    id: Math.random().toString(36).slice(2, 10),
    host: '',
    port: 22,
    username: 'root',
    moniker: `dvpn-${Math.random().toString(36).slice(2, 6)}`,
    nodePort: 7777,
    remoteUrlOverride: '',
    status: 'idle',
    ...seed,
  };
}

function applyUrlPattern(pattern: string, host: string, nodePort: number): string {
  return pattern.replace(/\{host\}/g, host).replace(/\{port\}/g, String(nodePort));
}

// Accept "host", "host:port", or schemed http(s)://host[:port]. Strip
// scheme + trailing slashes. Reject anything containing a path, query,
// fragment, whitespace, or non-host characters — those would later be
// interpolated into the dvpnx --node.remote-addrs flag and the TOML config.
const REMOTE_URL_HOST_RE = /^[a-zA-Z0-9.\-]{1,253}(?::[0-9]{1,5})?$/;
function effectiveRemoteUrl(row: Row, pattern: string): string {
  const raw = (row.remoteUrlOverride.trim() || applyUrlPattern(pattern.trim(), row.host, row.nodePort))
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  if (!raw) return '';
  if (!REMOTE_URL_HOST_RE.test(raw)) return '';
  return raw;
}

function statusTone(s: RowStatus): { color: string; label: string } {
  switch (s) {
    case 'idle': return { color: 'var(--text-muted)', label: 'Idle' };
    case 'testing': return { color: 'var(--text)', label: 'Testing…' };
    case 'test-ok': return { color: 'var(--green)', label: 'SSH OK' };
    case 'test-fail': return { color: 'var(--red)', label: 'SSH failed' };
    case 'queued': return { color: 'var(--text-muted)', label: 'Queued' };
    case 'deploying': return { color: 'var(--accent)', label: 'Deploying' };
    case 'done': return { color: 'var(--green)', label: 'Done' };
    case 'error': return { color: 'var(--red)', label: 'Error' };
  }
}

export function DeploySshBatch() {
  const { navigate, pushToast } = useApp();

  // Shared deploy params.
  const [service, setService] = useState<VpnServiceType>('wireguard');
  const [gigabytePrice, setGigabytePrice] = useState('0.05');
  const [hourlyPrice, setHourlyPrice] = useState('0.001');
  const [remoteUrlPattern, setRemoteUrlPattern] = useState('{host}:{port}');

  const [rows, setRows] = useState<Row[]>([newRow()]);
  const [paste, setPaste] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(true);
  const [cliOpen, setCliOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [credsRowId, setCredsRowId] = useState<string | null>(null);
  const cancelRef = useRef(false);
  // M-16: the deployAll loop spins up setInterval pollers that outlive the
  // screen if the user navigates away mid-batch. Track every live timer so we
  // can clear them on unmount, and gate state writes behind an alive flag so a
  // resolving poll/await can't setRows after React has torn the screen down.
  const pollTimers = useRef<Set<ReturnType<typeof setInterval>>>(new Set());
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cancelRef.current = true;
      for (const t of pollTimers.current) clearInterval(t);
      pollTimers.current.clear();
    };
  }, []);

  // Subscribe to deploy progress and merge into the matching row.
  useEffect(() => {
    const unsub = window.api.deploy.onProgress((p: DeployProgress) => {
      if (!aliveRef.current) return;
      setRows((prev) => prev.map((r) => {
        if (r.jobId !== p.jobId) return r;
        const next: Row = { ...r, phase: p.phase, percent: p.percent, message: p.message };
        if (p.phase === 'done') next.status = 'done';
        else if (p.phase === 'error' || p.phase === 'cancelled') next.status = 'error';
        else next.status = 'deploying';
        return next;
      }));
    });
    return () => { try { unsub?.(); } catch { /* noop */ } };
  }, []);

  const credsForRow = (row: Row): SSHCredentials => {
    const host = row.host.trim();
    const username = row.username.trim();
    const port = row.port;
    if (row.authOverride === 'password') {
      return {
        host,
        port,
        username,
        password: row.passwordOverride ?? '',
      };
    }
    return {
      host,
      port,
      username,
      privateKey: row.privateKeyOverride ?? '',
      passphrase: row.passphraseOverride || undefined,
    };
  };

  const rowCredsValid = (row: Row): boolean => {
    if (row.authOverride === 'password') return (row.passwordOverride ?? '').length > 0;
    return (row.privateKeyOverride ?? '').trim().length > 0;
  };

  const validRows = rows.filter((r) => r.host.trim() && r.username.trim() && r.moniker.trim().length >= 3 && r.nodePort >= 1024 && r.nodePort <= 65535);
  const credentialsValid = validRows.length > 0 && validRows.every(rowCredsValid);
  const canRun = !running && credentialsValid && validRows.length > 0;
  const allTestedOk = validRows.length > 0 && validRows.every((r) => r.status === 'test-ok' || r.status === 'done');

  const updateRow = (id: string, patch: Partial<Row>) => {
    if (!aliveRef.current) return;
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const addRow = () => setRows((prev) => [...prev, newRow({ nodePort: 7777 + prev.length })]);
  const removeRow = (id: string) => setRows((prev) => (prev.length === 1 ? prev : prev.filter((r) => r.id !== id)));

  const importPaste = () => {
    const lines = paste.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const parsed: Row[] = lines.slice(0, 50).map((line, idx) => {
      const parts = line.split(',').map((s) => s.trim());
      const host = parts[0] ?? '';
      const username = parts[1] || 'root';
      const sshPort = Number(parts[2]) || 22;
      const moniker = parts[3] || `dvpn-${Math.random().toString(36).slice(2, 6)}`;
      const np = Number(parts[4]);
      const nodePort = Number.isInteger(np) && np >= 1024 && np <= 65535 ? np : 7777 + idx;
      return newRow({ host, username, port: sshPort, moniker, nodePort });
    });
    setRows(parsed);
    setPaste('');
    pushToast({ title: 'Imported', body: `${parsed.length} host${parsed.length === 1 ? '' : 's'} loaded`, tone: 'success' });
  };

  const testAll = async () => {
    const targets = rows.filter((r) => r.host.trim() && r.username.trim());
    const missing = targets.filter((r) => !rowCredsValid(r));
    if (missing.length > 0) {
      pushToast({
        title: 'Credentials missing',
        body: `${missing.length} host${missing.length === 1 ? '' : 's'} need${missing.length === 1 ? 's' : ''} a key or password. Click the key icon on each row to set it.`,
        tone: 'warn',
      });
      return;
    }
    if (targets.length === 0) return;

    setRows((prev) => prev.map((r) => (targets.find((t) => t.id === r.id) ? { ...r, status: 'testing', testMessage: undefined } : r)));

    await Promise.all(targets.map(async (r) => {
      try {
        const result: SSHTestResult = await window.api.ssh.test(credsForRow(r));
        updateRow(r.id, {
          status: result.ok ? 'test-ok' : 'test-fail',
          testMessage: result.ok ? `${result.latencyMs}ms · ${result.osInfo}` : result.message,
        });
      } catch (e) {
        updateRow(r.id, { status: 'test-fail', testMessage: (e as Error).message });
      }
    }));
  };

  const deployAll = async () => {
    if (!canRun) return;
    if (!allTestedOk) {
      pushToast({ title: 'Test SSH first', body: 'Run "Test all" and resolve any failures before deploying.', tone: 'warn' });
      return;
    }
    setRunning(true);
    cancelRef.current = false;

    // Sequential chain broadcasts to avoid wallet sequence collisions.
    setRows((prev) => prev.map((r) => (validRows.find((v) => v.id === r.id) ? { ...r, status: 'queued', phase: undefined, percent: undefined, message: undefined } : r)));

    for (const row of validRows) {
      if (cancelRef.current) break;
      try {
        const { jobId } = await window.api.deploy.start({
          target: 'remote',
          moniker: row.moniker.trim(),
          serviceType: service,
          port: row.nodePort,
          gigabytePriceDVPN: Number(gigabytePrice) || 0,
          hourlyPriceDVPN: Number(hourlyPrice) || 0,
          remoteUrl: effectiveRemoteUrl(row, remoteUrlPattern) || undefined,
          ssh: credsForRow(row),
        });
        updateRow(row.id, { jobId, status: 'deploying' });

        // Wait until this row reaches a terminal phase before broadcasting next.
        // The poller is registered in pollTimers so an unmount mid-wait clears
        // it (and the unmount also sets cancelRef, which breaks this loop).
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            const cur = rowsRef.current.find((x) => x.id === row.id);
            if (!aliveRef.current || (cur && cur.phase && TERMINAL_PHASES.has(cur.phase))) {
              clearInterval(timer);
              pollTimers.current.delete(timer);
              resolve();
            }
          }, 400);
          pollTimers.current.add(timer);
        });
      } catch (e) {
        updateRow(row.id, { status: 'error', message: (e as Error).message });
      }
    }
    if (aliveRef.current) setRunning(false);
  };

  // Mirror rows into a ref so the deployAll loop can read the latest phase
  // without re-running the effect on every state change.
  const rowsRef = useRef<Row[]>(rows);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  const cliCommands = useMemo(() => {
    return validRows.map((r) => {
      const ssh: Record<string, unknown> = {
        host: r.host.trim(),
        port: r.port,
        username: r.username.trim(),
      };
      if (r.authOverride === 'password') {
        ssh.password = '<password>';
      } else {
        ssh.privateKey = '<paste key here>';
        if (r.passphraseOverride) ssh.passphrase = '<passphrase>';
      }
      const url = effectiveRemoteUrl(r, remoteUrlPattern);
      const sshJson = JSON.stringify(ssh);
      const escapedSsh = sshJson.replace(/'/g, "'\\''");
      return `deploy.start --target remote --moniker ${r.moniker} --gb ${Number(gigabytePrice) || 0} --hr ${Number(hourlyPrice) || 0} --service ${service} --port ${r.nodePort}${url ? ` --remoteUrl ${url}` : ''} --ssh '${escapedSsh}'`;
    });
  }, [validRows, gigabytePrice, hourlyPrice, service, remoteUrlPattern]);

  const cliBlock = useMemo(() => cliCommands.join('\n\n'), [cliCommands]);

  const copyCli = async () => {
    try {
      await navigator.clipboard.writeText(cliBlock);
      pushToast({ title: 'Copied', body: `${cliCommands.length} command${cliCommands.length === 1 ? '' : 's'} on clipboard`, tone: 'success' });
    } catch (e) {
      pushToast({ title: 'Copy failed', body: (e as Error).message, tone: 'error' });
    }
  };

  // Aggregate header counts.
  const counts = useMemo(() => {
    const total = rows.length;
    const tested = rows.filter((r) => r.status === 'test-ok').length;
    const deploying = rows.filter((r) => r.status === 'deploying' || r.status === 'queued').length;
    const done = rows.filter((r) => r.status === 'done').length;
    const failed = rows.filter((r) => r.status === 'test-fail' || r.status === 'error').length;
    return { total, tested, deploying, done, failed };
  }, [rows]);

  // Close CLI drawer on Escape.
  useEffect(() => {
    if (!cliOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCliOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cliOpen]);

  return (
    <div className="flex flex-col gap-2 relative">
      <PageHeader
        title="Deploy SSH · Batch"
        subtitle="Provision many SSH targets in one pass. Chain broadcasts run one-at-a-time to keep wallet sequences clean."
        right={
          <div className="flex items-center gap-1 p-0.5 rounded-md" style={{ background: 'var(--bg-input)', border: '1px solid var(--border)' }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => navigate({ name: 'deploy-ssh' })}
              title="Switch to single host"
            >
              <MIcon name="dns" size={14} /> Single host
            </button>
            <button className="btn btn-primary btn-sm" style={{ pointerEvents: 'none' }} title="Batch">
              <MIcon name="grid_view" size={14} /> Batch
            </button>
          </div>
        }
      />

      {/* Compact toolbar: summary chips + toggles */}
      <div
        className="flex items-center gap-2 flex-wrap px-2 py-1.5 rounded-md"
        style={{ background: 'var(--bg-input)', border: '1px solid var(--border)' }}
      >
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setParamsOpen((v) => !v)}
          title="Shared params & credentials"
        >
          <MIcon name={paramsOpen ? 'expand_less' : 'expand_more'} size={14} />
          Shared params
        </button>

        {/* Always-visible chip strip for current shared-params state */}
        <div className="flex items-center gap-1 flex-wrap text-[11px]">
          <Chip onClick={() => setParamsOpen(true)} icon="vpn_lock" label={service} />
          <Chip onClick={() => setParamsOpen(true)} icon="data_usage" label={`${gigabytePrice}/GB`} />
          <Chip onClick={() => setParamsOpen(true)} icon="schedule" label={`${hourlyPrice}/hr`} />
          <Chip onClick={() => setParamsOpen(true)} icon="link" label={remoteUrlPattern} mono />
        </div>

        <div className="flex-1" />

        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setPasteOpen((v) => !v)}
          title="Import hosts from CSV"
        >
          <MIcon name="upload" size={14} /> Import CSV
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => setCliOpen(true)}
          title="Open CLI automation drawer"
        >
          <MIcon name="terminal" size={14} /> Automate via CLI
          {cliCommands.length > 0 && (
            <span className="ml-1 px-1 rounded text-[10px]"
              style={{ background: 'var(--accent)', color: '#000' }}>
              {cliCommands.length}
            </span>
          )}
        </button>
      </div>

      {/* Collapsible shared params panel */}
      {paramsOpen && (
        <div className="card overflow-hidden">
          <div className="card-body grid grid-cols-12 gap-2 py-2">
            <div className="col-span-12">
              <div className="field-label">Protocol</div>
              <ProtocolTiles value={service} onChange={setService} />
            </div>
            <div className="col-span-4">
              <div className="field-label">$P2P / GB</div>
              <input value={gigabytePrice} onChange={(e) => setGigabytePrice(e.target.value)}
                type="number" step="0.0001" min="0.0001" max="80" className="field-input" />
            </div>
            <div className="col-span-4">
              <div className="field-label">$P2P / hour</div>
              <input value={hourlyPrice} onChange={(e) => setHourlyPrice(e.target.value)}
                type="number" step="0.0001" min="0.0001" max="80" className="field-input" />
            </div>
            <div className="col-span-4">
              <div className="field-label">Public URL pattern</div>
              <input value={remoteUrlPattern} onChange={(e) => setRemoteUrlPattern(e.target.value)}
                placeholder="{host}:{port}" className="field-input mono-inline" />
            </div>
            <div className="col-span-12 text-[11px]" style={{ color: 'var(--text-dim)' }}>
              Set the SSH key or password per host using the credentials button on each row. Network rules cap pricing at 80 $P2P.
            </div>
          </div>
        </div>
      )}

      {/* CSV paste import */}
      {pasteOpen && (
        <div className="card overflow-hidden">
          <div className="card-body flex flex-col gap-2 py-2">
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Paste CSV — <code className="mono-inline">host, user, sshPort, moniker, nodePort</code> — one host per line (max 50).
            </div>
            <textarea
              rows={3}
              className="field-input mono-inline text-xs"
              placeholder={'1.2.3.4, root, 22, dvpn-a, 7777\n5.6.7.8, root, 22, dvpn-b, 7778'}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button className="btn btn-ghost btn-sm" onClick={() => { setPaste(''); setPasteOpen(false); }}>
                Cancel
              </button>
              <button className="btn btn-secondary btn-sm" onClick={importPaste} disabled={!paste.trim()}>
                Import & replace rows
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DOMINANT: hosts table */}
      <div className="card flex flex-col overflow-hidden">
        <div className="card-header flex items-center justify-between py-2">
          <div className="card-title flex items-center gap-2">
            <MIcon name="dns" size={14} />
            Hosts ({rows.length})
          </div>
          <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span><b style={{ color: 'var(--green)' }}>{counts.tested}</b> tested</span>
            <span><b style={{ color: 'var(--accent)' }}>{counts.deploying}</b> in flight</span>
            <span><b style={{ color: 'var(--green)' }}>{counts.done}</b> done</span>
            <span><b style={{ color: 'var(--red)' }}>{counts.failed}</b> failed</span>
          </div>
        </div>
        <div className="overflow-auto" style={{ maxHeight: 560 }}>
          <div className="grid text-[11px] uppercase tracking-wider px-2 py-1.5 sticky top-0 z-10"
            style={{ gridTemplateColumns: 'minmax(0,1.5fr) 80px minmax(0,0.9fr) minmax(0,1.2fr) 64px minmax(0,1.4fr) 96px 76px 28px', gap: '4px', background: 'var(--bg-input)', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
            <div className="truncate">Host</div>
            <div className="truncate">SSH port</div>
            <div className="truncate">User</div>
            <div className="truncate">Moniker</div>
            <div className="truncate" title="Node listen port (dvpn service public port)">Port</div>
            <div className="truncate">Public URL</div>
            <div className="text-center truncate">Credentials</div>
            <div className="text-center truncate">Status</div>
            <div />
          </div>
          {rows.map((r) => {
            const tone = statusTone(r.status);
            const portValid = Number.isInteger(r.nodePort) && r.nodePort >= 1024 && r.nodePort <= 65535;
            const credSet = rowCredsValid(r);
            return (
              <div key={r.id} className="grid items-start px-2 py-1.5"
                style={{ gridTemplateColumns: 'minmax(0,1.5fr) 80px minmax(0,0.9fr) minmax(0,1.2fr) 64px minmax(0,1.4fr) 96px 76px 28px', gap: '4px', borderBottom: '1px solid var(--border)' }}>
                <input className="field-input mono-inline text-xs" style={{ minWidth: 0 }} value={r.host}
                  onChange={(e) => updateRow(r.id, { host: e.target.value })} placeholder="1.2.3.4" />
                <input className="field-input text-xs" style={{ minWidth: 0 }} type="number" value={r.port}
                  onChange={(e) => updateRow(r.id, { port: Number(e.target.value) || 22 })} />
                <input className="field-input mono-inline text-xs" style={{ minWidth: 0 }} value={r.username}
                  onChange={(e) => updateRow(r.id, { username: e.target.value })} />
                <input className="field-input mono-inline text-xs" style={{ minWidth: 0 }} value={r.moniker}
                  onChange={(e) => updateRow(r.id, { moniker: e.target.value })} />
                <input className="field-input text-xs" style={{ minWidth: 0 }} type="number" value={r.nodePort}
                  onChange={(e) => updateRow(r.id, { nodePort: Number(e.target.value) })}
                  aria-invalid={!portValid} />
                <input className="field-input mono-inline text-xs" style={{ minWidth: 0 }} value={r.remoteUrlOverride}
                  onChange={(e) => updateRow(r.id, { remoteUrlOverride: e.target.value })}
                  placeholder={applyUrlPattern(remoteUrlPattern, r.host || 'host', r.nodePort)} />
                <button
                  onClick={() => setCredsRowId(r.id)}
                  disabled={running}
                  title={credSet
                    ? `${r.authOverride === 'password' ? 'Password' : 'SSH key'} set — click to edit`
                    : 'Click to set SSH key or password for this host'}
                  className="self-center"
                  style={{
                    height: 26,
                    width: '100%',
                    minWidth: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    padding: '0 6px',
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 500,
                    cursor: running ? 'not-allowed' : 'pointer',
                    background: 'transparent',
                    color: credSet ? 'var(--green)' : 'var(--red)',
                    border: `1px solid ${credSet ? 'var(--border)' : 'color-mix(in srgb, var(--red) 50%, transparent)'}`,
                  }}
                >
                  <MIcon
                    name={credSet ? 'check_circle' : 'add'}
                    size={13}
                  />
                  <span>
                    {credSet
                      ? (r.authOverride === 'password' ? 'Pass' : 'Key')
                      : 'Set'}
                  </span>
                </button>
                <div className="text-[11px] flex flex-col self-center text-center" style={{ minWidth: 0, overflow: 'hidden' }}>
                  <span style={{ color: tone.color, fontWeight: 600 }}>{tone.label}</span>
                  {r.status === 'deploying' && (
                    <span style={{ color: 'var(--text-muted)' }}>{r.percent ?? 0}% {r.phase ?? ''}</span>
                  )}
                  {r.testMessage && (r.status === 'test-ok' || r.status === 'test-fail') && (
                    <span className="truncate" title={r.testMessage} style={{ color: 'var(--text-muted)' }}>{r.testMessage}</span>
                  )}
                  {r.message && r.status === 'error' && (
                    <span className="truncate" title={r.message} style={{ color: 'var(--red)' }}>{r.message}</span>
                  )}
                </div>
                <button
                  className="btn btn-ghost btn-sm self-center"
                  onClick={() => removeRow(r.id)}
                  disabled={rows.length === 1 || running}
                  title="Remove row"
                  style={{ padding: 2 }}
                >
                  <MIcon name="close" size={14} />
                </button>
              </div>
            );
          })}
          <div className="px-2 py-2 flex justify-center">
            <button
              className="btn btn-secondary btn-sm"
              onClick={addRow}
              disabled={running || rows.length >= 50}
              title="Append another host row"
            >
              <MIcon name="add" size={14} /> Add host
            </button>
          </div>
        </div>
      </div>

      {/* Sticky action bar */}
      <div
        className="flex items-center justify-between gap-2 px-2 py-2 rounded-md"
        style={{ background: 'var(--bg-input)', border: '1px solid var(--border)' }}
      >
        <button className="btn btn-secondary btn-sm" onClick={addRow} disabled={running || rows.length >= 50}>
          <MIcon name="add" size={14} /> Add host
        </button>
        <div className="flex items-center gap-2">
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {validRows.length} valid · {counts.tested} ready
          </span>
          <button className="btn btn-secondary" onClick={testAll} disabled={running || !credentialsValid}>
            <MIcon name="network_check" size={14} /> Test all SSH
          </button>
          <button
            className="btn btn-primary"
            onClick={deployAll}
            disabled={!canRun || !allTestedOk}
            title={!allTestedOk ? 'Run "Test all" until every host shows SSH OK.' : undefined}
          >
            {running ? 'Deploying…' : `Deploy all (${validRows.length})`}
            <MIcon name="arrow_forward" size={14} />
          </button>
        </div>
      </div>

      {/* CLI slide-over drawer */}
      {cliOpen && (
        <>
          <div
            onClick={() => setCliOpen(false)}
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.45)',
              zIndex: 40,
            }}
          />
          <aside
            role="dialog"
            aria-label="CLI automation"
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              width: 'min(520px, 92%)',
              background: 'var(--bg)',
              borderLeft: '1px solid var(--border)',
              boxShadow: '0 0 24px rgba(0,0,0,0.4)',
              zIndex: 50,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div className="flex items-center justify-between px-3 py-2"
              style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="flex items-center gap-2">
                <MIcon name="terminal" size={16} />
                <div className="card-title">Automate via CLI</div>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {cliCommands.length} command{cliCommands.length === 1 ? '' : 's'}
                </span>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setCliOpen(false)} title="Close (Esc)">
                <MIcon name="close" size={16} />
              </button>
            </div>

            <div className="flex flex-col gap-2 p-3 flex-1 min-h-0 overflow-auto">
              <div className="text-xs" style={{ color: 'var(--text)' }}>
                Pipe these one-shot commands through the{' '}
                <a
                  href="#cli"
                  onClick={(e) => { e.preventDefault(); navigate({ name: 'cli' }); }}
                  style={{ color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' }}
                >
                  in-app CLI
                </a>{' '}
                or your shell with <code className="mono-inline">sentinel-node-manager -e &quot;…&quot;</code>.
              </div>
              <ol className="list-decimal pl-4 flex flex-col gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                <li>
                  Start the CLI server in{' '}
                  <a
                    href="#settings"
                    onClick={(e) => { e.preventDefault(); navigate({ name: 'settings' }); }}
                    style={{ color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' }}
                  >
                    Settings → CLI server
                  </a>{' '}
                  (or enable auto-start).
                </li>
                <li>Replace <code>&lt;paste key here&gt;</code> / <code>&lt;password&gt;</code> with the real value.</li>
                <li>Run each line in order — wallet broadcasts must stay sequential.</li>
                <li>Track each job with <code>deploy.status &lt;jobId&gt;</code>.</li>
              </ol>

              <div className="flex items-center gap-2">
                <button className="btn btn-secondary btn-sm flex-1" onClick={copyCli} disabled={cliCommands.length === 0}>
                  <MIcon name="content_copy" size={14} /> Copy all
                </button>
                <a
                  href="#cli"
                  onClick={(e) => { e.preventDefault(); navigate({ name: 'cli' }); }}
                  className="btn btn-primary btn-sm flex-1"
                  style={{ textDecoration: 'none' }}
                >
                  <MIcon name="open_in_new" size={14} /> Open CLI screen
                </a>
              </div>

              <pre
                className="text-xs mono-inline p-3 overflow-auto flex-1 min-h-0"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
{cliBlock || '# Add at least one valid host to generate commands.'}
              </pre>
            </div>
          </aside>
        </>
      )}

      {credsRowId && (() => {
        const row = rows.find((x) => x.id === credsRowId);
        if (!row) return null;
        const effectiveMode: 'key' | 'password' = row.authOverride ?? 'key';
        const onClose = () => setCredsRowId(null);
        return (
          <>
            <div
              onClick={onClose}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.45)',
                zIndex: 60,
              }}
            />
            <div
              role="dialog"
              aria-label="Per-host credentials"
              style={{
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: 'min(440px, 92%)',
                maxHeight: '90vh',
                overflowY: 'auto',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                boxShadow: '0 0 32px rgba(0,0,0,0.55)',
                zIndex: 70,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div
                className="flex items-center justify-between px-3 py-2"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <div className="flex items-center gap-2">
                  <MIcon name="vpn_key" size={16} />
                  <div className="card-title">Credentials for {row.host || 'this host'}</div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={onClose} title="Close">
                  <MIcon name="close" size={16} />
                </button>
              </div>

              <div className="flex flex-col gap-2 p-3">
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Set the SSH credential for this host. Each host needs its own key or password.
                </div>

                <div className="flex gap-2">
                  <button
                    className={`btn flex-1 btn-sm ${effectiveMode === 'key' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => updateRow(row.id, { authOverride: 'key' })}
                  >
                    <MIcon name="key" size={14} /> SSH key
                  </button>
                  <button
                    className={`btn flex-1 btn-sm ${effectiveMode === 'password' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => updateRow(row.id, { authOverride: 'password' })}
                  >
                    <MIcon name="password" size={14} /> Password
                  </button>
                </div>

                {effectiveMode === 'key' ? (
                  <>
                    <textarea
                      rows={4}
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                      value={row.privateKeyOverride ?? ''}
                      onChange={(e) =>
                        updateRow(row.id, {
                          authOverride: 'key',
                          privateKeyOverride: e.target.value,
                        })
                      }
                      className="field-input mono-inline text-xs"
                    />
                    <input
                      type="password"
                      placeholder="Passphrase (optional)"
                      value={row.passphraseOverride ?? ''}
                      onChange={(e) =>
                        updateRow(row.id, {
                          authOverride: 'key',
                          passphraseOverride: e.target.value,
                        })
                      }
                      className="field-input"
                    />
                  </>
                ) : (
                  <input
                    type="password"
                    placeholder="SSH password for this host"
                    value={row.passwordOverride ?? ''}
                    onChange={(e) =>
                      updateRow(row.id, {
                        authOverride: 'password',
                        passwordOverride: e.target.value,
                      })
                    }
                    className="field-input"
                  />
                )}

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button className="btn btn-primary btn-sm" onClick={onClose}>
                    Done
                  </button>
                </div>
              </div>
            </div>
          </>
        );
      })()}
    </div>
  );
}

interface ChipProps {
  icon: string;
  label: string;
  onClick?: () => void;
  mono?: boolean;
  tone?: string;
}

function Chip({ icon, label, onClick, mono, tone }: ChipProps) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded ${mono ? 'mono-inline' : ''}`}
      style={{
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        color: tone ?? 'var(--text)',
        fontSize: 11,
        cursor: onClick ? 'pointer' : 'default',
      }}
      title={label}
    >
      <MIcon name={icon} size={12} />
      <span className="truncate" style={{ maxWidth: 160, display: 'inline-block' }}>{label}</span>
    </button>
  );
}
