import { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { MIcon } from '../components/MIcon';
import { useApp } from '../store/app';
import { fmtDVPN } from '../lib/format';
import type { LocalSystemReport, VpnServiceType } from '../../../shared/types';

const DEPLOY_MIN_DVPN = 1.05;

export function DeployLocal() {
  const { navigate, nodes, pushToast, wallet, settings, saveSettings, refreshSettings } =
    useApp();
  const [report, setReport] = useState<LocalSystemReport | null>(null);
  const [starting, setStarting] = useState(false);
  const [dockerStarting, setDockerStarting] = useState(false);
  const [moniker, setMoniker] = useState(defaultMoniker());
  const [service, setService] = useState<VpnServiceType>('wireguard');
  const [gigabytePrice, setGigabytePrice] = useState('0.05');
  const [hourlyPrice, setHourlyPrice] = useState('0.001');

  const MAX_LOCAL_NODES = 3;
  const SUGGESTED_PORTS = [7777, 7778, 7779];
  const localNodes = nodes.filter((n) => n.target === 'local');
  const usedPorts = new Set(localNodes.map((n) => n.port));
  const suggestedPort = SUGGESTED_PORTS.find((p) => !usedPorts.has(p)) ?? 7777;
  const [port, setPort] = useState(suggestedPort);
  const atCap = localNodes.length >= MAX_LOCAL_NODES;
  const nearCap = localNodes.length >= MAX_LOCAL_NODES - 1 && !atCap;

  const portInUse = usedPorts.has(port);
  const portValid =
    Number.isInteger(port) && port >= 1024 && port <= 65535 && !portInUse;
  const portError = !Number.isInteger(port)
    ? 'Port must be a whole number.'
    : port < 1024 || port > 65535
      ? 'Port must be between 1024 and 65535.'
      : portInUse
        ? `Port ${port} is already used by another local node.`
        : null;

  const gbPriceNum = Number(gigabytePrice);
  const hrPriceNum = Number(hourlyPrice);
  const gbPriceOver = Number.isFinite(gbPriceNum) && gbPriceNum > 80;
  const hrPriceOver = Number.isFinite(hrPriceNum) && hrPriceNum > 80;
  const priceOverNetwork = gbPriceOver || hrPriceOver;

  useEffect(() => {
    void window.api.system.report().then(setReport);
  }, []);

  useEffect(() => {
    if (!settings) void refreshSettings();
  }, [settings, refreshSettings]);

  const startDocker = async () => {
    setDockerStarting(true);
    try {
      const res = await window.api.docker.start();
      if (!res.started) {
        pushToast({
          title: 'Could not start Docker Desktop',
          body: res.error ?? 'Launcher did not spawn.',
          tone: 'error',
        });
        setDockerStarting(false);
        return;
      }
      const deadline = Date.now() + 60_000;
      let attempts = 0;
      while (Date.now() < deadline && attempts < 30) {
        attempts += 1;
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const next = await window.api.system.report();
          setReport(next);
          if (next.dockerReachable) break;
        } catch {
          // transient IPC failure while daemon is still coming up — keep polling
        }
      }
      if (!(await window.api.system.report().catch(() => null))?.dockerReachable) {
        pushToast({
          title: 'Docker did not come up',
          body: 'The daemon is still not reachable after 60 seconds. Check Docker Desktop.',
          tone: 'warn',
        });
      }
    } finally {
      setDockerStarting(false);
    }
  };

  const startLocal = async () => {
    setStarting(true);
    try {
      const { jobId } = await window.api.deploy.start({
        target: 'local',
        moniker: moniker.trim(),
        serviceType: service,
        gigabytePriceDVPN: Number(gigabytePrice) || 0,
        hourlyPriceDVPN: Number(hourlyPrice) || 0,
        port,
      });
      navigate({ name: 'progress', jobId, moniker: moniker.trim(), origin: 'local' });
    } catch (e) {
      pushToast({ title: 'Could not start deploy', body: (e as Error).message, tone: 'error' });
    } finally {
      setStarting(false);
    }
  };

  const walletBalance = wallet?.balanceDVPN ?? 0;
  const fundsOk = walletBalance >= DEPLOY_MIN_DVPN;

  const localReady =
    report?.osCompatible &&
    report?.memoryOk &&
    report?.dockerReachable &&
    moniker.trim().length >= 3 &&
    portValid &&
    !atCap &&
    fundsOk;

  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      <PageHeader
        title="Deploy Local"
        subtitle="Run sentinel-dvpnx in a Docker container on this machine."
        right={
          <span className="mono-tag">
            {nodes.length} node{nodes.length === 1 ? '' : 's'} in inventory
          </span>
        }
      />

      <div className="grid grid-cols-12 gap-3">
        <div className="card col-span-12 lg:col-span-8 flex flex-col overflow-hidden">
          <div className="card-header">
            <div className="flex items-center gap-3">
              <div
                className="h-9 w-9 rounded-lg grid place-items-center flex-shrink-0"
                style={{
                  background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
                  color: 'var(--accent)',
                }}
              >
                <MIcon name="desktop_windows" size={18} />
              </div>
              <div>
                <div className="card-title">This device</div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Deploy on the machine running this app.
                </div>
              </div>
            </div>
            <span className="chip chip-accent">Local</span>
          </div>

          <div className="card-body flex flex-col gap-2">
            <SystemChecksRow report={report} />

            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-8">
                <div className="field-label">Moniker</div>
                <input
                  value={moniker}
                  onChange={(e) => setMoniker(e.target.value)}
                  className="field-input mono-inline"
                  placeholder="my-dvpn-node"
                />
              </div>
              <div className="col-span-4">
                <div className="field-label">Port</div>
                <input
                  type="number"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  className="field-input"
                  aria-invalid={!portValid}
                />
              </div>
              {portError && (
                <div
                  className="col-span-12 text-[11px] -mt-1"
                  style={{ color: 'var(--red)' }}
                >
                  {portError}
                </div>
              )}
            </div>

            <div>
              <div className="field-label">Protocol</div>
              <ProtocolTiles value={service} onChange={setService} />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="field-label">$P2P / GB</div>
                <input
                  type="number"
                  step="0.0001"
                  min="0.0001"
                  max="80"
                  value={gigabytePrice}
                  onChange={(e) => setGigabytePrice(e.target.value)}
                  className="field-input"
                  aria-invalid={gbPriceOver}
                />
              </div>
              <div>
                <div className="field-label">$P2P / hour</div>
                <input
                  type="number"
                  step="0.0001"
                  min="0.0001"
                  max="80"
                  value={hourlyPrice}
                  onChange={(e) => setHourlyPrice(e.target.value)}
                  className="field-input"
                  aria-invalid={hrPriceOver}
                />
              </div>
            </div>

            {priceOverNetwork && (
              <div className="callout callout-warn text-xs flex items-start gap-2 py-1.5">
                <MIcon name="warning" size={14} />
                <span>
                  Network rules cap pricing at <b>80 $P2P</b> per GB or per hour. Nodes
                  priced above will be rejected by the chain.
                </span>
              </div>
            )}

            {!fundsOk && wallet && (
              <div className="callout callout-warn text-xs flex items-center gap-2 py-1.5">
                <MIcon name="account_balance_wallet" size={14} />
                <span className="flex-1">
                  Your app wallet has <b>{fmtDVPN(walletBalance, 4)} P2P</b>. You need{' '}
                  <b>{fmtDVPN(DEPLOY_MIN_DVPN, 2)} P2P</b> to start a new node
                  (1 P2P for the node, plus a small amount for network fees).
                </span>
                <button
                  type="button"
                  onClick={() => navigate({ name: 'wallet' })}
                  className="btn btn-secondary btn-sm flex-shrink-0"
                >
                  Open Wallet
                  <MIcon name="arrow_forward" size={12} />
                </button>
              </div>
            )}
            {atCap && (
              <div className="callout callout-warn py-2">
                <div className="flex items-start gap-2">
                  <MIcon name="info" size={14} style={{ marginTop: 2 }} />
                  <div className="flex-1">
                    <div className="text-xs font-semibold" style={{ color: 'var(--text)' }}>
                      Maximum {MAX_LOCAL_NODES} local nodes reached on this machine.
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      Remove one from the Nodes page before deploying another.
                    </div>
                    <button
                      type="button"
                      onClick={() => navigate({ name: 'nodes' })}
                      className="btn btn-secondary mt-1.5"
                    >
                      Open Nodes
                      <MIcon name="arrow_forward" size={14} />
                    </button>
                  </div>
                </div>
              </div>
            )}
            {nearCap && (
              <div className="callout callout-warn py-2">
                <div className="flex items-start gap-2">
                  <MIcon name="info" size={14} style={{ marginTop: 2 }} />
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    You already host {localNodes.length} local node
                    {localNodes.length === 1 ? '' : 's'}. The chain treats nodes on the same
                    public IP as duplicates for directory ranking, and each one shares this
                    machine's CPU, disk, and bandwidth. Max {MAX_LOCAL_NODES} per host.
                  </div>
                </div>
              </div>
            )}

            {report && !report.dockerReachable && (
              <div className="callout callout-warn py-2">
                {report.dockerReason === 'desktop-not-running' ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Docker Desktop isn't running.
                    </span>
                    <button
                      type="button"
                      onClick={startDocker}
                      disabled={
                        dockerStarting || !(report.dockerDesktop?.startable ?? false)
                      }
                      className="btn btn-secondary"
                    >
                      {dockerStarting ? 'Starting…' : 'Start Docker Desktop'}
                      <MIcon
                        name={dockerStarting ? 'hourglass_top' : 'play_arrow'}
                        size={14}
                      />
                    </button>
                  </div>
                ) : report.dockerReason === 'engine-not-running' ? (
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Engine not running. Start with{' '}
                    <span className="mono-inline" style={{ color: 'var(--text)' }}>
                      sudo systemctl start docker
                    </span>
                    .
                  </div>
                ) : (
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Install{' '}
                    <a
                      href="https://www.docker.com/products/docker-desktop/"
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: 'var(--accent)' }}
                    >
                      Docker Desktop
                    </a>{' '}
                    or Docker Engine (Linux), then reopen this page.
                  </div>
                )}
              </div>
            )}

            {settings && (
              <div
                className="flex flex-col gap-2 px-3 py-2"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                <label className="flex items-start gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.minimizeToTrayOnClose}
                    onChange={(e) =>
                      void saveSettings({ minimizeToTrayOnClose: e.target.checked })
                    }
                    style={{ marginTop: 2 }}
                  />
                  <div className="flex-1">
                    <div style={{ color: 'var(--text)' }}>Minimize to tray on close</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Closing the window hides it to the tray so the app keeps polling your
                      node.
                    </div>
                  </div>
                </label>
                <label className="flex items-start gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.stopNodesOnQuit}
                    onChange={(e) =>
                      void saveSettings({ stopNodesOnQuit: e.target.checked })
                    }
                    style={{ marginTop: 2 }}
                  />
                  <div className="flex-1">
                    <div style={{ color: 'var(--text)' }}>Stop running nodes on exit</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Off by default. Your node keeps earning in Docker even after you exit.
                    </div>
                  </div>
                </label>
              </div>
            )}

            <div className="pt-1">
              <button
                onClick={startLocal}
                disabled={!report || starting || !localReady}
                className="btn btn-primary w-full"
              >
                {starting ? 'Starting…' : 'Initialize local node'}
                <MIcon name="arrow_forward" size={14} />
              </button>
            </div>
          </div>
        </div>

        <div className="col-span-12 lg:col-span-4 flex flex-col min-h-0 gap-3">
          <div className="card flex flex-col overflow-hidden">
            <div className="card-header">
              <div className="card-title">Why local?</div>
            </div>
            <div className="card-body flex flex-col gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
              <Bullet>No hosting bill: uses your bandwidth.</Bullet>
              <Bullet>Home labs and residential IPs.</Bullet>
              <Bullet>Machine must stay online to earn.</Bullet>
            </div>
          </div>

          <CurrentRules />

          <OnChainSpecsCard />

          <a
            className="text-xs inline-flex items-center gap-1"
            style={{ color: 'var(--accent)' }}
            href="https://github.com/sentinel-official/sentinel-dvpnx"
            target="_blank"
            rel="noreferrer"
          >
            Upstream docs
            <MIcon name="open_in_new" size={12} />
          </a>
        </div>
      </div>
    </div>
  );
}

function SystemChecksRow({ report }: { report: LocalSystemReport | null }) {
  const items: { label: string; status: 'ok' | 'warn' | 'err' | 'loading'; detail?: string }[] = [
    {
      label: 'OS',
      status: report ? (report.osCompatible ? 'ok' : 'err') : 'loading',
      detail: report?.osLabel,
    },
    {
      label: 'RAM',
      status: report ? (report.memoryOk ? 'ok' : 'warn') : 'loading',
      detail: report ? `${(report.memoryMb / 1024).toFixed(1)} GB` : undefined,
    },
    {
      label: 'Docker',
      status: report ? (report.dockerReachable ? 'ok' : 'err') : 'loading',
      detail: report
        ? report.dockerReachable
          ? (report.dockerVersion ?? 'ok')
          : 'not reachable'
        : undefined,
    },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((it) => (
        <CheckCompact key={it.label} {...it} />
      ))}
    </div>
  );
}

function CheckCompact({
  label,
  status,
  detail,
}: {
  label: string;
  status: 'ok' | 'warn' | 'err' | 'loading';
  detail?: string;
}) {
  const dotColor =
    status === 'ok'
      ? 'var(--green)'
      : status === 'warn'
        ? 'var(--yellow, #f5b04a)'
        : status === 'err'
          ? 'var(--red)'
          : 'var(--text-dim)';
  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5"
      style={{
        background: 'var(--bg-input)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: dotColor,
          flexShrink: 0,
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold" style={{ color: 'var(--text)' }}>
          {label}
        </div>
        <div
          className="text-[10px] truncate"
          style={{ color: 'var(--text-dim)', minHeight: 14 }}
          title={detail}
        >
          {status === 'loading' ? '…' : (detail ?? ' ')}
        </div>
      </div>
    </div>
  );
}

function defaultMoniker(): string {
  const suffix = Math.random().toString(36).slice(2, 6);
  return `dvpn-${suffix}`;
}

type ProtocolOption = {
  id: VpnServiceType | 'amneziawg';
  label: string;
  logo: string;
  blurb: string;
  comingSoon?: boolean;
};

const PROTOCOL_OPTIONS: ProtocolOption[] = [
  {
    id: 'wireguard',
    label: 'WireGuard',
    logo: '/brand/protocols/wireguard.svg',
    blurb: 'Fast, UDP-based, kernel-friendly.',
  },
  {
    id: 'v2ray',
    label: 'V2Ray',
    logo: '/brand/protocols/v2ray.png',
    blurb: 'Obfuscated; works on restrictive networks.',
  },
  {
    id: 'amneziawg',
    label: 'AmneziaWG',
    logo: '/brand/protocols/amneziawg.svg',
    blurb: 'WireGuard fork hardened against DPI.',
    comingSoon: true,
  },
];

export function ProtocolTiles({
  value,
  onChange,
}: {
  value: VpnServiceType;
  onChange: (next: VpnServiceType) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {PROTOCOL_OPTIONS.map((opt) => {
        const active = value === opt.id;
        const disabled = !!opt.comingSoon;
        return (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            onClick={() => !disabled && onChange(opt.id as VpnServiceType)}
            className="p-2.5 text-left transition-colors relative"
            style={{
              background: active
                ? 'color-mix(in srgb, var(--accent) 12%, transparent)'
                : 'var(--bg-input)',
              border: `1px solid ${
                active
                  ? 'color-mix(in srgb, var(--accent) 55%, transparent)'
                  : 'var(--border)'
              }`,
              borderRadius: 'var(--radius-md)',
              color: 'var(--text)',
              opacity: disabled ? 0.6 : 1,
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            <div className="flex items-center justify-center gap-2">
              <div
                className="h-8 w-8 rounded grid place-items-center flex-shrink-0 overflow-hidden"
                style={{
                  background: '#ffffff',
                  border: '1px solid var(--border)',
                }}
              >
                <img
                  src={opt.logo}
                  alt={`${opt.label} logo`}
                  style={{
                    width: '22px',
                    height: '22px',
                    objectFit: 'contain',
                  }}
                  draggable={false}
                />
              </div>
              <div className="text-sm font-semibold flex items-center gap-1.5">
                {opt.label}
                {opt.comingSoon && (
                  <span
                    className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                    style={{
                      background: 'color-mix(in srgb, var(--text-muted) 18%, transparent)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    Soon
                  </span>
                )}
              </div>
              {active && !disabled && (
                <MIcon name="check_circle" size={16} style={{ color: 'var(--accent)' }} />
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <MIcon
        name="check_circle"
        size={14}
        style={{ marginTop: 2, color: 'var(--green)' }}
      />
      <span>{children}</span>
    </div>
  );
}

function CurrentRules() {
  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">Current rules</div>
      </div>
      <div
        className="card-body flex flex-col gap-2 text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        <Bullet>Node should be active and healthy.</Bullet>
        <Bullet>Node should not be behind CGNAT.</Bullet>
        <Bullet>Max price should be 80 $P2P per hour.</Bullet>
        <Bullet>Maximum nodes per country: 300.</Bullet>
        <Bullet>Maximum nodes per city: 20.</Bullet>
        <Bullet>Maximum nodes per ASN: 50.</Bullet>
      </div>
    </div>
  );
}

function OnChainSpecsCard() {
  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">On-chain hardware reporting</div>
      </div>
      <div
        className="card-body flex flex-col gap-2 text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        <Bullet>
          After deploy, the node publishes a 1 udvpn self-transfer from its own
          operator address with a <code>specs:v1</code> memo.
        </Bullet>
        <Bullet>
          The memo carries CPU model, total host cores and RAM, and the cores
          and RAM available to the dvpn-node container (Docker/WSL2 VM).
        </Bullet>
        <Bullet>
          Operator-reported &mdash; not consensus-validated. Surfaced in
          Activity as <em>Specs reporting</em> with the tx hash.
        </Bullet>
      </div>
    </div>
  );
}

