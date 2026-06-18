import { useEffect, useState } from 'react';
import { MIcon } from '../components/MIcon';
import { useApp } from '../store/app';
import type {
  DockerOverview,
  LiveSystemStats,
  LocalSystemReport,
} from '../../../shared/types';

export function System() {
  const pushToast = useApp((s) => s.pushToast);
  const live = useApp((s) => s.systemLive);
  const stats = useApp((s) => s.systemStats);
  const setLive = useApp((s) => s.setSystemLive);
  const [report, setReport] = useState<LocalSystemReport | null>(null);
  const [docker, setDocker] = useState<DockerOverview | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      const [r, d] = await Promise.all([
        window.api.system.report(),
        window.api.docker.overview().catch(() => null),
      ]);
      setReport(r);
      setDocker(d);
    } catch (e) {
      pushToast({
        title: 'Could not read system info',
        body: e instanceof Error ? e.message : String(e),
        tone: 'error',
      });
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="page-header">
        <div className="flex items-center gap-3 flex-wrap min-w-0">
          <h1 className="page-title">System</h1>
          {report && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span
                className={`chip ${report.osCompatible ? 'chip-success' : 'chip-danger'}`}
                title={report.osCompatible ? 'Supported operating system.' : 'This OS is not supported.'}
              >
                <MIcon name="desktop_windows" size={12} />
                {report.osLabel}
              </span>
              <span
                className="chip"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-muted)',
                }}
                title="The instruction set your CPU speaks."
              >
                {report.arch}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <LiveToggle on={live} onChange={setLive} />
          <button
            className="btn btn-secondary"
            onClick={() => void load()}
            disabled={refreshing}
            title="Read CPU, RAM and Docker status again"
          >
            <MIcon name="refresh" size={14} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-3">
        {!report ? (
          <div
            className="col-span-12 card grid place-items-center"
            style={{ minHeight: 220 }}
          >
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Reading your machine's specs…
            </div>
          </div>
        ) : (
          <>
            <CpuCard report={report} live={live} stats={stats} />
            <RamCard report={report} live={live} stats={stats} />
            <CapacityCard report={report} docker={docker} />
            <CqapCard report={report} />
            {report.wsl2Backend && <WslCard report={report} />}
          </>
        )}
      </div>
    </div>
  );
}

function LiveToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      className="btn btn-secondary"
      onClick={() => onChange(!on)}
      title={
        on
          ? 'Stop polling CPU and RAM in real time.'
          : 'Sample CPU load and free RAM once a second.'
      }
      style={
        on
          ? {
              borderColor: 'color-mix(in srgb, var(--green) 50%, transparent)',
              background: 'color-mix(in srgb, var(--green) 12%, transparent)',
              color: 'var(--text)',
            }
          : undefined
      }
    >
      <span
        className="inline-block rounded-full"
        style={{
          width: 8,
          height: 8,
          background: on ? 'var(--green)' : 'var(--text-dim)',
          boxShadow: on
            ? '0 0 0 3px color-mix(in srgb, var(--green) 25%, transparent)'
            : 'none',
          transition: 'box-shadow 200ms ease, background 200ms ease',
        }}
      />
      Live Specs {on ? 'On' : 'Off'}
    </button>
  );
}

function CpuCard({
  report,
  live,
  stats,
}: {
  report: LocalSystemReport;
  live: boolean;
  stats: LiveSystemStats | null;
}) {
  const speed = Number.isFinite(report.cpuSpeedMhz) ? report.cpuSpeedMhz : 0;
  const ghz = speed > 0 ? (speed / 1000).toFixed(2) : null;
  const cores = Number.isFinite(report.cpuCores) ? report.cpuCores : 0;
  const showLive = live && stats !== null;
  const loadPct = showLive ? Math.round(stats!.cpuLoadPct) : null;
  const loadColor =
    loadPct === null
      ? 'var(--accent)'
      : loadPct > 85
        ? 'var(--red)'
        : loadPct > 60
          ? 'var(--yellow, #f5b04a)'
          : 'var(--green)';
  return (
    <div className="card col-span-12 lg:col-span-6">
      <div className="card-header py-2">
        <div className="flex items-center gap-2 min-w-0">
          <MIcon name="memory" size={14} style={{ color: 'var(--accent)' }} />
          <div className="card-title text-sm">CPU</div>
          <div
            className="text-xs truncate"
            style={{ color: 'var(--text-muted)' }}
            title={report.cpuModel ?? '—'}
          >
            · {report.cpuModel ?? '—'}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {showLive && <LivePill compact />}
          <span className="mono-tag">{report.arch ?? '—'}</span>
        </div>
      </div>
      <div className="card-body py-4 flex flex-col gap-3.5">
        <div className="grid grid-cols-3 gap-3">
          <Stat
            label="Cores"
            value={cores > 0 ? `${cores}` : '—'}
            help="Each core can do its own job at the same time. More cores = more nodes you can run."
            size="lg"
            align="center"
          />
          <Stat
            label="Speed"
            value={ghz ? `${ghz} GHz` : '—'}
            help="How fast each core runs. Higher is faster."
            size="lg"
            align="center"
          />
          <Stat
            label="Load"
            value={loadPct === null ? '—' : `${loadPct}%`}
            help={
              showLive
                ? 'How busy your CPU is right now, averaged across all cores.'
                : 'Turn Live Specs on to see how busy the CPU is right now.'
            }
            valueColor={loadPct === null ? undefined : loadColor}
            size="lg"
            align="center"
          />
        </div>
        <Bar
          value={loadPct ?? 0}
          max={100}
          color={loadPct === null ? 'var(--border)' : loadColor}
        />
        {showLive && stats!.cpuPerCorePct.length > 1 && (
          <PerCoreGrid cores={stats!.cpuPerCorePct} />
        )}
        {!showLive && (
          <div className="text-[11px] text-center" style={{ color: 'var(--text-dim)' }}>
            Turn on <b>Live Specs</b> in the top-right to watch CPU load update each second.
          </div>
        )}
      </div>
    </div>
  );
}

function PerCoreGrid({ cores }: { cores: number[] }) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--text-dim)' }}
      >
        Per-core load
      </div>
      <div
        className="grid gap-1.5"
        style={{
          gridTemplateColumns: `repeat(${Math.min(cores.length, 8)}, minmax(0, 1fr))`,
        }}
      >
        {cores.map((c, i) => {
          const v = Math.round(c);
          const color =
            v > 85 ? 'var(--red)' : v > 60 ? 'var(--yellow, #f5b04a)' : 'var(--green)';
          return (
            <div
              key={i}
              title={`Core ${i}: ${v}%`}
              className="flex flex-col items-stretch gap-1"
            >
              <div
                style={{
                  height: 4,
                  borderRadius: 999,
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${v}%`,
                    height: '100%',
                    background: color,
                    transition: 'width 250ms ease',
                  }}
                />
              </div>
              <div
                className="text-[9px] text-center mono-inline"
                style={{ color: 'var(--text-dim)' }}
              >
                {v}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RamCard({
  report,
  live,
  stats,
}: {
  report: LocalSystemReport;
  live: boolean;
  stats: LiveSystemStats | null;
}) {
  const showLive = live && stats !== null;
  const totalMb = showLive
    ? stats!.totalMemoryMb
    : Number.isFinite(report.memoryMb)
      ? report.memoryMb
      : 0;
  const freeMb = showLive
    ? stats!.freeMemoryMb
    : Number.isFinite(report.freeMemoryMb)
      ? report.freeMemoryMb
      : 0;
  const totalGb = totalMb / 1024;
  const freeGb = freeMb / 1024;
  const usedGb = Math.max(0, totalGb - freeGb);
  const usedPct = totalGb > 0 ? (usedGb / totalGb) * 100 : 0;
  const color =
    usedPct > 90
      ? 'var(--red)'
      : usedPct > 75
        ? 'var(--yellow, #f5b04a)'
        : 'var(--green)';
  return (
    <div className="card col-span-12 lg:col-span-6">
      <div className="card-header py-2">
        <div className="flex items-center gap-2 min-w-0">
          <MIcon name="dataset" size={14} style={{ color: 'var(--accent)' }} />
          <div className="card-title text-sm">RAM</div>
          <div
            className="text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            · {totalGb.toFixed(1)} GB total
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {showLive && <LivePill compact />}
        </div>
      </div>
      <div className="card-body py-4 flex flex-col gap-3.5">
        <div className="grid grid-cols-3 gap-3">
          <Stat
            label="Total"
            value={`${totalGb.toFixed(1)} GB`}
            help="How much memory your machine has in total."
            size="lg"
            align="center"
          />
          <Stat
            label="Used"
            value={`${usedGb.toFixed(1)} GB`}
            help="Memory currently in use by the OS, this app, and everything else."
            valueColor={showLive ? color : undefined}
            size="lg"
            align="center"
          />
          <Stat
            label="Free"
            value={`${freeGb.toFixed(1)} GB`}
            help={
              showLive
                ? 'How much memory is unused right now.'
                : 'How much was unused when this page loaded. Turn on Live Specs for a real-time number.'
            }
            size="lg"
            align="center"
          />
        </div>
        <Bar value={usedPct} max={100} color={color} />
        <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
          {usedGb.toFixed(1)} GB used of {totalGb.toFixed(1)} GB ({usedPct.toFixed(0)}%)
          {showLive ? ' · live' : ' · snapshot'}
        </div>
        {!report.memoryOk && (
          <div
            className="text-xs leading-snug px-3 py-2"
            style={{
              background: 'color-mix(in srgb, var(--red) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--red) 30%, transparent)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text)',
            }}
          >
            We recommend at least <b>2 GB</b> of RAM to run a node. With less,
            the node may crash or run very slowly.
          </div>
        )}
      </div>
    </div>
  );
}

type Bottleneck = 'cpu' | 'ram';

interface ProtocolEstimate {
  users: number;
  cpuLimit: number;
  ramLimit: number;
  bottleneck: Bottleneck;
}

interface CapacityEstimate {
  wireguard: ProtocolEstimate;
  v2ray: ProtocolEstimate;
  cores: number;
  ramGb: number;
  source: 'docker' | 'host';
}

/**
 * Estimated concurrent users a single node can serve on this hardware.
 *
 * Uses the locked formulas:
 *   WireGuard: min((vCPU − 0.5) / 0.04,  (RAM_GB − 0.5) / 0.025)
 *   V2Ray:     min((vCPU − 1.0) / 0.06,  (RAM_GB − 1.0) / 0.045)
 *
 * Docker reservation wins when reachable (containers can't exceed it);
 * otherwise we use host specs. The result is a hardware ceiling — it does
 * not factor live CPU load, because the formula models how many tunnels
 * the box can sustain at peak, not how many it could open right now.
 */
function estimateConcurrency(
  report: LocalSystemReport,
  docker: DockerOverview | null,
): CapacityEstimate {
  const dockerOk =
    docker && docker.reachable &&
    Number.isFinite(docker.totalMemoryMb) && docker.totalMemoryMb! > 0 &&
    Number.isFinite(docker.ncpu) && docker.ncpu! > 0;

  const totalMb = dockerOk
    ? docker!.totalMemoryMb!
    : Number.isFinite(report.memoryMb) ? report.memoryMb : 0;
  const cores = dockerOk
    ? docker!.ncpu!
    : Number.isFinite(report.cpuCores) ? report.cpuCores : 0;

  const ramGb = totalMb / 1024;

  const wg = applyFormula(cores, ramGb, 0.5, 0.5, 0.04, 0.025);
  const v2 = applyFormula(cores, ramGb, 1.0, 1.0, 0.06, 0.045);

  return {
    wireguard: wg,
    v2ray: v2,
    cores,
    ramGb,
    source: dockerOk ? 'docker' : 'host',
  };
}

function applyFormula(
  cores: number,
  ramGb: number,
  cpuReserve: number,
  ramReserve: number,
  cpuPerUser: number,
  ramPerUser: number,
): ProtocolEstimate {
  const cpuLimit = Math.max(0, Math.floor((cores - cpuReserve) / cpuPerUser));
  const ramLimit = Math.max(0, Math.floor((ramGb - ramReserve) / ramPerUser));
  const users = Math.min(cpuLimit, ramLimit);
  return {
    users,
    cpuLimit,
    ramLimit,
    bottleneck: cpuLimit <= ramLimit ? 'cpu' : 'ram',
  };
}

function DockerLimitsRow({
  docker,
  report,
}: {
  docker: DockerOverview | null;
  report: LocalSystemReport;
}) {
  const reachable = !!docker && docker.reachable;
  // Docker engine pool = resources available to containers (on Windows this is
  // the WSL2 VM allocation, which sits below the host total). Not "reserved" —
  // the node container itself runs uncapped.
  const availRamMb =
    reachable && Number.isFinite(docker!.totalMemoryMb) ? docker!.totalMemoryMb! : 0;
  const availCores =
    reachable && Number.isFinite(docker!.ncpu) ? docker!.ncpu! : 0;
  const totalRamMb = Number.isFinite(report.memoryMb) ? report.memoryMb : 0;
  const totalCores = Number.isFinite(report.cpuCores) ? report.cpuCores : 0;
  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ background: 'var(--bg-input)', border: '1px solid var(--border)' }}
    >
      <div
        className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider"
        style={{
          color: 'var(--text-dim)',
          borderBottom: '1px solid var(--border)',
          background: 'color-mix(in srgb, var(--bg-input) 60%, transparent)',
        }}
      >
        <MIcon name="settings" size={11} style={{ color: 'var(--accent)' }} />
        Docker resource settings
      </div>
      <div className="grid grid-cols-2" style={{ gap: 0 }}>
        <DockerLimitCell
          label="RAM available"
          value={availRamMb / 1024}
          total={totalRamMb / 1024}
          unit="GB"
          decimals={1}
          help="Memory the Docker engine makes available to containers (on Windows this is the WSL2 VM allocation, typically below the host total). Edit in Docker Desktop → Settings → Resources."
          dim={!reachable}
        />
        <DockerLimitCell
          label="Cores available"
          value={availCores}
          total={totalCores}
          unit="cores"
          decimals={0}
          help="Logical CPU cores the Docker engine makes available to containers (on Windows this is the WSL2 VM allocation). Edit in Docker Desktop → Settings → Resources."
          dim={!reachable}
          divider
        />
      </div>
    </div>
  );
}

function DockerLimitCell({
  label,
  value,
  total,
  unit,
  decimals,
  help,
  dim,
  divider,
}: {
  label: string;
  value: number;
  total: number;
  unit: string;
  decimals: number;
  help: string;
  dim?: boolean;
  divider?: boolean;
}) {
  const fmt = (n: number) =>
    Number.isFinite(n) && n > 0 ? n.toFixed(decimals) : '—';
  const pct =
    total > 0 && value > 0
      ? Math.max(0, Math.min(100, (value / total) * 100))
      : 0;
  return (
    <div
      className="flex flex-col gap-1.5 px-3 py-2"
      title={help}
      style={divider ? { borderLeft: '1px solid var(--border)' } : undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
        <span
          className="text-sm font-semibold tabular-nums"
          style={{ color: dim ? 'var(--text-dim)' : 'var(--text)' }}
        >
          {fmt(value)}
          <span
            className="text-[11px] font-normal"
            style={{ color: 'var(--text-dim)' }}
          >
            {' / '}
            {fmt(total)} {unit}
          </span>
        </span>
      </div>
      <div
        style={{
          height: 4,
          borderRadius: 999,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: dim ? 'var(--text-dim)' : 'var(--accent)',
            transition: 'width 250ms ease',
          }}
        />
      </div>
    </div>
  );
}

function CapacityCard({
  report,
  docker,
}: {
  report: LocalSystemReport;
  docker: DockerOverview | null;
}) {
  const [showFormula, setShowFormula] = useState(false);
  const cap = estimateConcurrency(report, docker);

  return (
    <div className="card col-span-12">
      <div className="card-header">
        <div className="flex items-center gap-3">
          <CardIcon name="group" />
          <div>
            <div className="card-title">Estimated concurrent users</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Hardware ceiling per node, derived from {cap.source === 'docker' ? 'Docker reservation' : 'host specs'}.
            </div>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setShowFormula((v) => !v)}
          title="Show the formula used to compute these numbers"
        >
          <MIcon name="info" size={14} />
          How it's calculated
        </button>
      </div>
      <div className="card-body flex flex-col gap-3">
        {showFormula && (
          <FormulaModal cap={cap} onClose={() => setShowFormula(false)} />
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          <UserCountTile
            protocol="WireGuard"
            logo="/brand/protocols/wireguard.svg"
            est={cap.wireguard}
          />
          <UserCountTile
            protocol="V2Ray"
            logo="/brand/protocols/v2ray.png"
            est={cap.v2ray}
          />
        </div>
        <DockerLimitsRow docker={docker} report={report} />
      </div>
    </div>
  );
}

function UserCountTile({
  protocol,
  logo,
  est,
}: {
  protocol: string;
  logo: string;
  est: ProtocolEstimate;
}) {
  return (
    <div
      className="flex flex-col gap-3 px-4 py-4 rounded-lg"
      style={{ background: 'var(--bg-input)', border: '1px solid var(--border)' }}
    >
      <div className="flex flex-col items-center gap-3">
        <div
          className="h-16 w-16 rounded-lg grid place-items-center flex-shrink-0"
          style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
        >
          <img
            src={logo}
            alt={`${protocol} logo`}
            className="h-11 w-11 object-contain"
            draggable={false}
          />
        </div>
        <div className="flex items-baseline justify-center gap-2 flex-wrap text-center">
          <span
            className="text-base font-semibold leading-none"
            style={{ color: 'var(--text)' }}
          >
            {protocol}
          </span>
          <span
            className="text-base font-semibold leading-none tabular-nums"
            style={{ color: 'var(--text)' }}
          >
            {est.users.toLocaleString()}
          </span>
          <span
            className="text-base font-medium leading-none"
            style={{ color: 'var(--text-muted)' }}
          >
            users
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <LimitPill
          label="CPU limit"
          value={est.cpuLimit}
          active={est.bottleneck === 'cpu'}
        />
        <LimitPill
          label="RAM limit"
          value={est.ramLimit}
          active={est.bottleneck === 'ram'}
        />
      </div>
    </div>
  );
}

function LimitPill({
  label,
  value,
  active,
}: {
  label: string;
  value: number;
  active: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between px-2.5 py-1.5 rounded-md"
      style={{
        background: active
          ? 'color-mix(in srgb, var(--accent) 12%, transparent)'
          : 'var(--bg)',
        border: active
          ? '1px solid color-mix(in srgb, var(--accent) 35%, transparent)'
          : '1px solid var(--border)',
      }}
      title={
        active
          ? `${label} is the bottleneck — this is the hard ceiling.`
          : `${label} would allow more users; ${label === 'CPU limit' ? 'RAM' : 'CPU'} is the bottleneck.`
      }
    >
      <span
        className="text-[10px] uppercase tracking-wider"
        style={{ color: active ? 'var(--accent)' : 'var(--text-dim)' }}
      >
        {label}
        {active ? ' ·' : ''}
      </span>
      <span
        className="text-sm font-semibold tabular-nums"
        style={{ color: active ? 'var(--text)' : 'var(--text-muted)' }}
      >
        {value.toLocaleString()}
      </span>
    </div>
  );
}

function FormulaModal({
  cap,
  onClose,
}: {
  cap: CapacityEstimate;
  onClose: () => void;
}) {
  const ramGb = cap.ramGb.toFixed(1);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'color-mix(in srgb, black 55%, transparent)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl shadow-2xl flex flex-col overflow-hidden w-full max-w-xl"
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          maxHeight: '90vh',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <MIcon name="info" size={16} style={{ color: 'var(--accent)' }} />
            <div className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
              How it's calculated
            </div>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            title="Close"
            style={{ padding: '4px 8px' }}
          >
            <MIcon name="close" size={14} />
          </button>
        </div>

        <div
          className="px-4 py-4 flex flex-col gap-3 overflow-auto text-xs leading-relaxed"
          style={{ color: 'var(--text-muted)' }}
        >
          <div
            className="text-[11px] leading-snug px-3 py-2 rounded-md"
            style={{
              background: 'color-mix(in srgb, var(--yellow, #f5b04a) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--yellow, #f5b04a) 35%, transparent)',
              color: 'var(--text)',
            }}
          >
            <b>Disclaimer:</b> these numbers are an estimation and may not
            conform to reality. Research is ongoing.
          </div>

          <div>
            We take the lower of two limits per protocol — the CPU limit and the
            RAM limit — and that's the hard ceiling. A small reserve is held back
            for the OS and the protocol runtime itself.
          </div>
          <div className="flex flex-col gap-2">
            <FormulaLine
              protocol="WireGuard"
              formula="U = min( (vCPU − 0.5) ÷ 0.04 ,  (RAM_GB − 0.5) ÷ 0.025 )"
              notes="Reserve 0.5 cores / 0.5 GB for the OS · 0.04 cores per user (≈25 users per dedicated core) · 25 MB per user."
            />
            <FormulaLine
              protocol="V2Ray"
              formula="U = min( (vCPU − 1.0) ÷ 0.06 ,  (RAM_GB − 1.0) ÷ 0.045 )"
              notes="Reserve 1.0 cores / 1.0 GB for the V2Ray core + GeoIP/Site DBs · 0.06 cores per user (≈16 users per dedicated core) · 45 MB per user."
            />
          </div>
          <div
            className="text-[11px] flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-2 rounded-md"
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border)' }}
          >
            <span style={{ color: 'var(--text-dim)' }}>
              Plugged in for this machine
              {cap.source === 'docker' ? ' (Docker reservation)' : ' (host specs)'}:
            </span>
            <span className="mono-inline" style={{ color: 'var(--text)' }}>
              vCPU = {cap.cores}
            </span>
            <span className="mono-inline" style={{ color: 'var(--text)' }}>
              RAM_GB = {ramGb}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function FormulaLine({
  protocol,
  formula,
  notes,
}: {
  protocol: string;
  formula: string;
  notes: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="text-[11px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text)' }}
      >
        {protocol}
      </div>
      <code
        className="mono-inline text-[11px] px-2 py-1.5 rounded-md break-words"
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          color: 'var(--text)',
        }}
      >
        {formula}
      </code>
      <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
        {notes}
      </div>
    </div>
  );
}

function CqapCard({ report: _report }: { report: LocalSystemReport }) {
  return (
    <div className="card col-span-12">
      <div className="card-header py-2">
        <div className="flex items-center gap-3">
          <CardIcon name="speed" />
          <div className="card-title text-sm">CQAP</div>
        </div>
        <span className="chip chip-warn">Disabled</span>
      </div>
      <div className="card-body py-2">
        <div
          className="text-[11px] leading-snug px-2.5 py-1.5"
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-muted)',
          }}
        >
          <b style={{ color: 'var(--text)' }}>Upcoming integration.</b> CQAP is
          software that verifies a node's system specs.
        </div>
      </div>
    </div>
  );
}

function WslCard({ report: _report }: { report: LocalSystemReport }) {
  return (
    <div className="card col-span-12">
      <div className="card-header">
        <div className="flex items-center gap-3">
          <CardIcon name="terminal" />
          <div>
            <div className="card-title">WSL2 memory tuning</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Docker Desktop on Windows runs inside a small Linux machine called WSL2.
            </div>
          </div>
        </div>
        <span className="chip chip-warn">Optional</span>
      </div>
      <div className="card-body flex flex-col gap-3">
        <div className="text-sm leading-snug" style={{ color: 'var(--text)' }}>
          If you see a process called <b>vmmemwsl</b> using a lot of RAM in
          Task Manager, that's WSL2 holding onto memory. You can cap it.
        </div>
        <ol
          className="text-xs leading-relaxed pl-5 space-y-1"
          style={{ color: 'var(--text-muted)', listStyle: 'decimal' }}
        >
          <li>
            Open the file <code className="mono-inline">.wslconfig</code> in your
            user folder. Create it if it doesn't exist.
          </li>
          <li>Add the lines below and save the file.</li>
          <li>
            In PowerShell, run <code className="mono-inline">wsl --shutdown</code>,
            then start Docker Desktop again.
          </li>
        </ol>
        <pre
          className="mono-inline text-[11px] p-2 overflow-auto"
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text)',
          }}
        >
{`[wsl2]
memory=4GB
processors=2
swap=2GB`}
        </pre>
        <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
          Pick numbers that fit your machine. 4 GB is plenty for one or two nodes.
        </div>
      </div>
    </div>
  );
}

function LivePill({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-medium uppercase tracking-wider rounded-full ${
        compact ? 'text-[9px] px-1.5 py-0.5' : 'text-[10px] px-2 py-0.5'
      }`}
      style={{
        background: 'color-mix(in srgb, var(--green) 15%, transparent)',
        border: '1px solid color-mix(in srgb, var(--green) 35%, transparent)',
        color: 'var(--green)',
      }}
    >
      <span
        className="inline-block rounded-full"
        style={{
          width: compact ? 5 : 6,
          height: compact ? 5 : 6,
          background: 'var(--green)',
          animation: 'pulse 1.4s ease-in-out infinite',
        }}
      />
      Live
    </span>
  );
}

function CardIcon({ name }: { name: string }) {
  return (
    <div
      className="h-9 w-9 rounded-lg grid place-items-center flex-shrink-0"
      style={{
        background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
        border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
        color: 'var(--accent)',
      }}
    >
      <MIcon name={name} size={18} />
    </div>
  );
}

function Stat({
  label,
  value,
  help,
  valueColor,
  size = 'md',
  align = 'left',
}: {
  label: string;
  value: string;
  help?: string;
  valueColor?: string;
  size?: 'md' | 'lg';
  align?: 'left' | 'center';
}) {
  const valueClass =
    size === 'lg'
      ? 'text-xl font-semibold tracking-tight'
      : 'text-sm font-medium';
  return (
    <div
      className={`flex flex-col gap-1 ${align === 'center' ? 'items-center text-center' : ''}`}
      title={help}
    >
      <div
        className="text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--text-dim)' }}
      >
        {label}
      </div>
      <div
        className={`${valueClass} break-words leading-none`}
        style={{ color: valueColor ?? 'var(--text)' }}
      >
        {value}
      </div>
    </div>
  );
}

function Bar({
  value,
  max,
  color,
}: {
  value: number;
  max: number;
  color: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      style={{
        height: 8,
        borderRadius: 999,
        background: 'var(--bg-input)',
        border: '1px solid var(--border)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          background: color,
          transition: 'width 250ms ease',
        }}
      />
    </div>
  );
}
