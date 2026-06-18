import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { MIcon } from '../components/MIcon';
import { CountryFlag } from '../components/CountryFlag';
import { useApp } from '../store/app';
import { fmtDVPN, relativeTime } from '../lib/format';
import type { NodeStatus, VpnServiceType, NodeDeployTarget } from '../../../shared/types';

type TargetFilter = 'all' | NodeDeployTarget;
type ProtocolFilter = 'all' | VpnServiceType;

const BULK_CONCURRENCY = 8;

async function runWithLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        await worker(items[idx]!);
        results[idx] = { status: 'fulfilled', value: undefined };
      } catch (err) {
        results[idx] = { status: 'rejected', reason: err };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export function Nodes() {
  const {
    nodes,
    navigate,
    refreshStatus,
    liveStatuses,
    refreshNodes,
    reapStuckNodes,
    confirm,
    pushToast,
    dismissToast,
  } = useApp();
  const [targetFilter, setTargetFilter] = useState<TargetFilter>('all');
  const [protocolFilter, setProtocolFilter] = useState<ProtocolFilter>('all');
  const [bulkRunning, setBulkRunning] = useState<'start' | 'stop' | 'claim' | null>(null);

  const claimable = useMemo(
    () => nodes.filter((n) => n.balanceDVPN > 0.001),
    [nodes],
  );
  const totalClaimable = useMemo(
    () => claimable.reduce((sum, n) => sum + n.balanceDVPN, 0),
    [claimable],
  );

  // M-16: only kick a status refresh for nodes we haven't seen before. The
  // previous version re-fetched EVERY node on any add/remove (the memo key
  // changes wholesale), firing an N-way RPC burst that defeats the poller's
  // 15 s stagger every time a node appeared or was deleted. Diffing against
  // the last-seen id set keeps it to just the genuinely-new nodes.
  const seenNodeIds = useRef<Set<string>>(new Set());
  const nodeIdsKey = useMemo(() => nodes.map((n) => n.id).sort().join(','), [nodes]);
  useEffect(() => {
    const current = nodeIdsKey.split(',').filter(Boolean);
    const seen = seenNodeIds.current;
    for (const id of current) {
      if (!seen.has(id)) void refreshStatus(id);
    }
    seenNodeIds.current = new Set(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeIdsKey]);

  const stoppable = useMemo(
    () => nodes.filter((n) => n.status === 'offline' || n.status === 'error'),
    [nodes],
  );
  const running = useMemo(
    () => nodes.filter((n) => n.status === 'online' || n.status === 'loading'),
    [nodes],
  );
  const stuckCount = useMemo(
    () => nodes.filter((n) => n.target === 'local' && n.status === 'loading').length,
    [nodes],
  );

  const handleReapStuck = async () => {
    const ok = await confirm({
      title: stuckCount > 0 ? `Clear ${stuckCount} stuck node${stuckCount === 1 ? '' : 's'}?` : 'Clear stuck nodes?',
      body:
        'Drops local nodes that are stuck on "Starting" but whose container is not actually running. ' +
        'The node entry, on-disk data dir, and any container leftovers are removed. ' +
        'Use this when a deploy hung mid-flight and the node is wedged in the inventory.',
      tone: 'warning',
      confirmLabel: 'Clear stuck',
    });
    if (!ok) return;
    await reapStuckNodes();
  };

  const bulkAction = async (mode: 'start' | 'stop') => {
    const targets = mode === 'start' ? stoppable : running;
    if (targets.length === 0) return;
    const ok = await confirm({
      title: mode === 'start' ? `Start ${targets.length} nodes?` : `Stop ${targets.length} nodes?`,
      body:
        mode === 'start'
          ? 'Each node will be started in its Docker container locally, or via SSH for remote nodes.'
          : 'Each node will be stopped. Container data is preserved on disk and nodes can be restarted using Start all.',
      tone: mode === 'stop' ? 'warning' : 'info',
      confirmLabel: mode === 'start' ? 'Start all' : 'Stop all',
    });
    if (!ok) return;

    if (mode === 'start' && targets.some((n) => n.target === 'local')) {
      const report = await window.api.system.report().catch(() => null);
      if (!report?.dockerReachable) {
        pushToast({
          title: 'Docker is not running',
          body:
            report?.dockerError?.slice(0, 140) ??
            'Docker Desktop must be running before local nodes can be started. Open Manage Docker to launch it.',
          tone: 'error',
        });
        return;
      }
    }

    setBulkRunning(mode);
    const progressId = pushToast({
      title: mode === 'start' ? `Starting ${targets.length} nodes…` : `Stopping ${targets.length} nodes…`,
      tone: 'info',
      durationMs: 60_000,
    });

    const results = await runWithLimit(targets, BULK_CONCURRENCY, async (n) => {
      if (mode === 'start') await window.api.nodes.start(n.id);
      else await window.api.nodes.stop(n.id);
    });

    dismissToast(progressId);
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - fulfilled;
    const verb = mode === 'start' ? 'Started' : 'Stopped';
    if (failed === 0) {
      pushToast({
        title: `${verb} ${fulfilled} node${fulfilled === 1 ? '' : 's'}`,
        tone: 'success',
      });
    } else {
      const firstErr = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
      pushToast({
        title: `${verb} ${fulfilled} · ${failed} failed`,
        body: firstErr ? (firstErr.reason instanceof Error ? firstErr.reason.message : String(firstErr.reason)) : undefined,
        tone: 'warn',
      });
    }

    await refreshNodes();
    for (const n of targets) void refreshStatus(n.id);
    setBulkRunning(null);
  };

  const bulkClaim = async () => {
    if (claimable.length === 0) return;
    const ok = await confirm({
      title: `Withdraw rewards from ${claimable.length} node${claimable.length === 1 ? '' : 's'}?`,
      body:
        `This sends each node's earnings to your app wallet (a tiny amount is kept on each node to pay network fees). ` +
        `Total ready to withdraw: ${fmtDVPN(totalClaimable)} P2P. Each node sends its own earnings — they need their saved recovery info, which is already stored safely in this app.`,
      tone: 'info',
      confirmLabel: `Withdraw ${fmtDVPN(totalClaimable)} P2P`,
    });
    if (!ok) return;

    setBulkRunning('claim');
    const progressId = pushToast({
      title: `Withdrawing from ${claimable.length} node${claimable.length === 1 ? '' : 's'}…`,
      tone: 'info',
      durationMs: 120_000,
    });

    let claimed = 0;
    let claimedAmount = 0;
    const failures: { moniker: string; error: string }[] = [];

    // Sequential — each withdraw signs + broadcasts on the same RPC pool.
    // Parallel claims would race nonces on the same chain client and pile
    // onto one RPC node's mempool; one-at-a-time is the safe default.
    for (const node of claimable) {
      try {
        const res = await window.api.nodes.withdraw({ nodeId: node.id });
        if (res.ok) {
          claimed += 1;
          claimedAmount += node.balanceDVPN;
        } else {
          failures.push({ moniker: node.moniker, error: res.error ?? 'unknown' });
        }
      } catch (err) {
        failures.push({ moniker: node.moniker, error: (err as Error).message });
      }
    }

    dismissToast(progressId);
    if (failures.length === 0) {
      pushToast({
        title: `Withdrew about ${fmtDVPN(claimedAmount)} P2P from ${claimed} node${claimed === 1 ? '' : 's'}`,
        tone: 'success',
      });
    } else {
      pushToast({
        title: `Withdrew from ${claimed} · ${failures.length} failed`,
        body: failures[0]
          ? `${failures[0].moniker}: ${failures[0].error.slice(0, 140)}`
          : undefined,
        tone: claimed > 0 ? 'warn' : 'error',
      });
    }

    await refreshNodes();
    setBulkRunning(null);
  };

  const counts = useMemo(() => {
    let local = 0;
    let ssh = 0;
    for (const n of nodes) {
      if (n.target === 'local') local++;
      else ssh++;
    }
    return { local, ssh };
  }, [nodes]);

  const filtered = useMemo(() => {
    return nodes.filter((n) => {
      if (targetFilter !== 'all' && n.target !== targetFilter) return false;
      if (protocolFilter !== 'all' && n.serviceType !== protocolFilter) return false;
      return true;
    });
  }, [nodes, targetFilter, protocolFilter]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Nodes"
        subtitle={
          nodes.length === 0
            ? 'No nodes deployed yet'
            : `${counts.local} local · ${counts.ssh} SSH · ${nodes.length} total`
        }
        right={
          <>
            <button
              className="btn btn-secondary"
              onClick={() => void bulkAction('start')}
              disabled={stoppable.length === 0 || bulkRunning !== null}
              title={stoppable.length === 0 ? 'No stopped nodes available to start.' : `Start ${stoppable.length} stopped node${stoppable.length === 1 ? '' : 's'}`}
            >
              <MIcon name={bulkRunning === 'start' ? 'hourglass_top' : 'play_arrow'} size={14} />
              {bulkRunning === 'start' ? 'Starting…' : `Start all${stoppable.length ? ` (${stoppable.length})` : ''}`}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => void bulkAction('stop')}
              disabled={running.length === 0 || bulkRunning !== null}
              title={running.length === 0 ? 'No running nodes available to stop.' : `Stop ${running.length} running node${running.length === 1 ? '' : 's'}`}
            >
              <MIcon name={bulkRunning === 'stop' ? 'hourglass_top' : 'stop'} size={14} />
              {bulkRunning === 'stop' ? 'Stopping…' : `Stop all${running.length ? ` (${running.length})` : ''}`}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => void bulkClaim()}
              disabled={claimable.length === 0 || bulkRunning !== null}
              title={
                claimable.length === 0
                  ? 'None of your nodes have earnings ready to withdraw yet.'
                  : `Withdraw about ${fmtDVPN(totalClaimable)} P2P from ${claimable.length} node${claimable.length === 1 ? '' : 's'} to your app wallet.`
              }
            >
              <MIcon
                name={bulkRunning === 'claim' ? 'hourglass_top' : 'savings'}
                size={14}
              />
              {bulkRunning === 'claim'
                ? 'Withdrawing…'
                : claimable.length
                  ? `Claim all (${fmtDVPN(totalClaimable)})`
                  : 'Claim all'}
            </button>
            {stuckCount > 0 ? (
              <button
                className="btn btn-secondary"
                onClick={() => void handleReapStuck()}
                disabled={bulkRunning !== null}
                title={`Clear ${stuckCount} node${stuckCount === 1 ? '' : 's'} that got stuck on "Starting" but never finished. This removes them so you can try again.`}
                style={{ color: 'var(--yellow)' }}
              >
                <MIcon name="cleaning_services" size={14} />
                Clear stuck ({stuckCount})
              </button>
            ) : null}
            <button
              className="btn btn-secondary"
              onClick={() => {
                void refreshNodes();
                for (const n of nodes) void refreshStatus(n.id);
              }}
              disabled={bulkRunning !== null}
            >
              <MIcon name="refresh" size={14} />
              Refresh
            </button>
          </>
        }
      />

      {nodes.length === 0 ? (
        <div className="card">
          <div className="card-body">
            <div
              className="flex flex-col items-center text-center"
              style={{ padding: '28px 24px', gap: 10 }}
            >
              <div
                className="rounded-2xl grid place-items-center"
                style={{
                  height: 64,
                  width: 64,
                  background:
                    'color-mix(in srgb, var(--accent) 14%, transparent)',
                  border:
                    '1px solid color-mix(in srgb, var(--accent) 35%, transparent)',
                  color: 'var(--accent)',
                }}
              >
                <MIcon name="dns" size={32} />
              </div>
              <div
                className="font-semibold"
                style={{
                  color: 'var(--text)',
                  fontSize: 'clamp(18px, 2vw, 24px)',
                  lineHeight: 1.2,
                  letterSpacing: '-0.01em',
                }}
              >
                No nodes deployed yet
              </div>
              <p
                className="max-w-lg"
                style={{
                  color: 'var(--text-muted)',
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                Spin up your first Sentinel dVPN node to start earning $P2P.
                Run one locally in Docker, or provision a remote VPS over SSH.
              </p>
              <div className="flex items-center gap-2 flex-wrap justify-center mt-1">
                <button
                  className="btn btn-primary"
                  onClick={() => navigate({ name: 'deploy-local' })}
                  style={{ fontSize: 14, padding: '10px 18px', height: 'auto' }}
                >
                  <MIcon name="desktop_windows" size={16} />
                  Deploy local
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => navigate({ name: 'deploy-ssh' })}
                  style={{ fontSize: 14, padding: '10px 18px', height: 'auto' }}
                >
                  <MIcon name="dns" size={16} />
                  Deploy SSH
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => navigate({ name: 'deploy-ssh-batch' })}
                  style={{ fontSize: 14, padding: '10px 18px', height: 'auto' }}
                >
                  <MIcon name="grid_view" size={16} />
                  Batch deploy
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="card-header flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <div className="card-title">All nodes</div>
              <span className="mono-tag">{filtered.length} shown</span>
            </div>
            <div className="flex items-center gap-2">
              <FilterGroup
                label="Location"
                options={[
                  { value: 'all', label: `All · ${nodes.length}` },
                  { value: 'local', label: `Local · ${counts.local}` },
                  { value: 'remote', label: `SSH · ${counts.ssh}` },
                ]}
                value={targetFilter}
                onChange={(v) => setTargetFilter(v as TargetFilter)}
              />
              <FilterGroup
                label="Protocol"
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'wireguard', label: 'WireGuard' },
                  { value: 'v2ray', label: 'V2Ray' },
                ]}
                value={protocolFilter}
                onChange={(v) => setProtocolFilter(v as ProtocolFilter)}
              />
            </div>
          </div>
          {filtered.length === 0 ? (
            <div className="card-body">
              <div className="empty-state">
                <MIcon name="filter_alt" size={24} />
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  No nodes match the current filters.
                </div>
              </div>
            </div>
          ) : (
            <div className="overflow-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Moniker</th>
                    <th style={{ textAlign: 'left' }}>Location</th>
                    <th style={{ textAlign: 'left' }}>Status</th>
                    <th style={{ textAlign: 'left' }}>Protocol</th>
                    <th style={{ textAlign: 'right' }}>Balance</th>
                    <th style={{ textAlign: 'right' }}>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((n) => {
                    const s = liveStatuses[n.id];
                    return (
                      <tr
                        key={n.id}
                        onClick={() => navigate({ name: 'node-details', id: n.id })}
                        style={{ cursor: 'pointer' }}
                      >
                        <td style={{ color: 'var(--text)', fontWeight: 500, textAlign: 'left', maxWidth: 200 }}>
                          <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
                            <MIcon name="dns" size={16} />
                            <span
                              className="truncate"
                              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              title={n.moniker}
                            >
                              {n.moniker}
                            </span>
                          </div>
                        </td>
                        <td style={{ textAlign: 'left' }}>
                          <div className="flex items-center gap-1.5">
                            {n.target === 'local' ? null : (
                              <>
                                <CountryFlag code={n.country} />
                                <span
                                  className="text-[11px]"
                                  style={{ color: 'var(--text)' }}
                                >
                                  {n.countryName ?? n.country ?? 'Remote'}
                                </span>
                              </>
                            )}
                            <span
                              className={`chip ${n.target === 'local' ? 'chip-accent' : 'chip-success'}`}
                            >
                              <MIcon
                                name={n.target === 'local' ? 'desktop_windows' : 'cloud'}
                                size={12}
                              />
                              {n.target === 'local' ? 'Local' : 'SSH'}
                            </span>
                            <span
                              className="mono-inline text-[11px] truncate"
                              style={{ color: 'var(--text-dim)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              title={n.target === 'local' ? `:${n.port}` : `${n.host}:${n.port}`}
                            >
                              {n.target === 'local' ? `:${n.port}` : `${n.host}:${n.port}`}
                            </span>
                          </div>
                        </td>
                        <td style={{ textAlign: 'left' }}>
                          <StatusChip status={n.status} reachable={s?.reachable} />
                        </td>
                        <td
                          className="uppercase text-[10px] tracking-wider"
                          style={{ color: 'var(--text-muted)', textAlign: 'left' }}
                        >
                          {n.serviceType}
                        </td>
                        <td
                          className="mono-inline"
                          style={{ color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap' }}
                        >
                          {fmtDVPN(n.balanceDVPN)} $P2P
                        </td>
                        <td style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
                          {relativeTime(n.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface FilterOption {
  value: string;
  label: string;
}

function FilterGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: FilterOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="text-[10px] uppercase tracking-wider font-semibold"
        style={{ color: 'var(--text-dim)' }}
      >
        {label}
      </span>
      <div
        className="flex items-center gap-0.5 p-0.5 rounded"
        style={{
          background: 'var(--bg-input)',
          border: '1px solid var(--border)',
        }}
      >
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className="text-[11px] px-2 py-1 rounded transition-colors"
            style={{
              background: value === opt.value ? 'var(--accent)' : 'transparent',
              color: value === opt.value ? '#fff' : 'var(--text-muted)',
              fontWeight: value === opt.value ? 600 : 500,
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function StatusChip({ status, reachable }: { status: NodeStatus; reachable?: boolean }) {
  if (status === 'loading')
    return (
      <span className="chip chip-warn">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--yellow)' }} />
        Starting
      </span>
    );
  if (status === 'error' || status === 'offline')
    return (
      <span className="chip chip-danger">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--red)' }} />
        {status === 'error' ? 'Error' : 'Offline'}
      </span>
    );
  return reachable ? (
    <span className="chip chip-success">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--green)' }} />
      Online
    </span>
  ) : (
    <span
      className="chip chip-warn"
      title="The node process is running but its API endpoint is not yet responding. This usually resolves within 60 to 120 seconds of starting."
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--yellow)' }} />
      Syncing
    </span>
  );
}
