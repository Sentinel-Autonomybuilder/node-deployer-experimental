import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { PageHeader } from '../components/PageHeader';
import { MIcon } from '../components/MIcon';
import { useApp } from '../store/app';
import { KIND_ICON } from '../lib/events';
import { relativeTime, shortAddr } from '../lib/format';
import type {
  AppEvent,
  DockerOverview,
  LocalSystemReport,
} from '../../../shared/types';

export function OnChainSpecs() {
  const pushToast = useApp((s) => s.pushToast);
  const nodes = useApp((s) => s.nodes);
  const navigate = useApp((s) => s.navigate);

  const [report, setReport] = useState<LocalSystemReport | null>(null);
  const [docker, setDocker] = useState<DockerOverview | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [events, setEvents] = useState<AppEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const firstLoadRef = useRef(true);
  const cancelledRef = useRef(false);

  const loadSystem = useCallback(async () => {
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
  }, [pushToast]);

  const loadEvents = useCallback(async () => {
    if (firstLoadRef.current) setLoadingEvents(true);
    try {
      const next = await window.api.events.list(500);
      if (!cancelledRef.current) setEvents(next);
    } finally {
      if (firstLoadRef.current && !cancelledRef.current) setLoadingEvents(false);
      firstLoadRef.current = false;
    }
  }, []);

  useEffect(() => {
    void loadSystem();
  }, [loadSystem]);

  useEffect(() => {
    cancelledRef.current = false;
    void loadEvents();
    const off = window.api.events.onChanged(() => void loadEvents());
    return () => {
      cancelledRef.current = true;
      off();
    };
  }, [loadEvents]);

  const specsEvents = useMemo(
    () => events.filter((e) => e.kind === 'specs-reported'),
    [events],
  );
  const nodeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) m.set(n.id, n.moniker);
    return m;
  }, [nodes]);

  const publishPending = nodes.some((n) => n.specsPublishPending);

  return (
    <div className="flex flex-col gap-3" style={{ height: 'calc(100vh - 96px)' }}>
      <PageHeader
        title="On-Chain Specs Reporting"
        right={
          <>
            {publishPending && (
              <span
                className="chip inline-flex items-center gap-1.5"
                style={{
                  background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--accent) 50%, transparent)',
                  color: 'var(--text)',
                }}
                title="A specs:v1 broadcast is currently in flight."
              >
                <span
                  aria-hidden
                  className="ring-spin"
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    border: '2px solid var(--border)',
                    borderTopColor: 'var(--accent)',
                  }}
                />
                Posting on-chain…
              </span>
            )}
            <span
              className="chip inline-flex items-center gap-1.5"
              style={{
                background: 'color-mix(in srgb, var(--green) 14%, transparent)',
                border: '1px solid color-mix(in srgb, var(--green) 50%, transparent)',
                color: 'var(--text)',
              }}
              title="Every node creation and every node start publishes a specs:v1 self-MsgSend on-chain."
            >
              <span
                className="inline-block rounded-full"
                style={{ width: 6, height: 6, background: 'var(--green)' }}
              />
              Enabled
            </span>
            <button
              className="btn btn-secondary"
              onClick={() => void loadSystem()}
              disabled={refreshing}
              title="Re-read CPU, RAM and Docker resource availability"
            >
              <MIcon name="refresh" size={14} />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </>
        }
      />

      <div className="grid grid-cols-12 gap-3 flex-1 min-h-0">
        <div className="col-span-12 lg:col-span-7 flex flex-col gap-3 overflow-auto min-h-0">
          <ExplainerCard />
          {report ? (
            <>
              <SpecsSnapshotCard report={report} docker={docker} />
              <SpecsMemoCard report={report} docker={docker} />
            </>
          ) : (
            <div className="card">
              <div className="card-body">
                <div className="loading-state">Reading your machine's specs…</div>
              </div>
            </div>
          )}
        </div>

        <div className="col-span-12 lg:col-span-5 card flex flex-col overflow-hidden">
          <div className="card-header">
            <div className="card-title flex items-center gap-2">
              <MIcon name="history" size={14} />
              On-chain specs feed
            </div>
            <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
              {specsEvents.length === 0
                ? 'no posts yet'
                : `${specsEvents.length} post${specsEvents.length === 1 ? '' : 's'}`}
            </div>
          </div>
          <div className="overflow-auto flex-1 min-h-0">
            {loadingEvents && events.length === 0 ? (
              <div className="loading-state">Loading…</div>
            ) : specsEvents.length === 0 ? (
              <div className="empty-state" style={{ padding: '40px 16px' }}>
                <MIcon name="receipt_long" size={28} />
                <div className="font-semibold" style={{ color: 'var(--text)' }}>
                  No on-chain specs posts yet
                </div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Deploy a node — the app will broadcast a specs:v1 memo and
                  this feed will start filling in.
                </div>
              </div>
            ) : (
              <ul className="flex flex-col">
                {specsEvents.map((e, idx) => {
                  const Icon = KIND_ICON[e.kind];
                  const moniker = e.relatedNodeId
                    ? nodeNameById.get(e.relatedNodeId)
                    : null;
                  const ts = new Date(e.timestamp);
                  const tsAbs = ts.toLocaleString();
                  return (
                    <li
                      key={e.id}
                      className="flex items-start gap-3 px-4 py-3"
                      style={{
                        borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                      }}
                    >
                      <div
                        className="h-8 w-8 rounded-md grid place-items-center flex-shrink-0"
                        style={{
                          background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
                          color: 'var(--accent)',
                        }}
                      >
                        <Icon size={16} weight="regular" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span
                            className="text-sm font-medium"
                            style={{ color: 'var(--text)' }}
                          >
                            {e.title}
                          </span>
                          <span
                            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                            style={{
                              background: 'var(--bg-input)',
                              border: '1px solid var(--border)',
                              color: 'var(--text-muted)',
                            }}
                          >
                            Specs reporting
                          </span>
                        </div>
                        {e.subtitle && (
                          <div
                            className="text-xs mt-0.5"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {e.subtitle}
                          </div>
                        )}
                        <div
                          className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5 text-[11px]"
                          style={{ color: 'var(--text-dim)' }}
                        >
                          <span title={tsAbs}>
                            <MIcon name="schedule" size={11} /> {relativeTime(e.timestamp)}
                          </span>
                          <span className="mono-inline" style={{ color: 'var(--text-muted)' }}>
                            {tsAbs}
                          </span>
                          {moniker && e.relatedNodeId && (
                            <button
                              type="button"
                              onClick={() =>
                                navigate({
                                  name: 'node-details',
                                  id: e.relatedNodeId!,
                                })
                              }
                              style={{ color: 'var(--accent)', cursor: 'pointer' }}
                              title="Open node"
                            >
                              <MIcon name="dns" size={11} /> {moniker}
                            </button>
                          )}
                          {e.txHash && (
                            <>
                              <span
                                className="mono-inline"
                                title={e.txHash}
                                style={{ color: 'var(--text-muted)' }}
                              >
                                tx {shortAddr(e.txHash, 8, 6)}
                              </span>
                              <a
                                href={`https://p2pscan.com/transactions/${e.txHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Open on p2pscan.com"
                                style={{ color: 'var(--accent)' }}
                              >
                                <MIcon name="open_in_new" size={11} /> View TX
                              </a>
                            </>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}

function ExplainerCard() {
  return (
    <div className="card">
      <div className="card-header py-2">
        <div className="flex items-center gap-2 min-w-0">
          <MIcon name="receipt_long" size={14} style={{ color: 'var(--accent)' }} />
          <div className="card-title text-sm">What gets published</div>
        </div>
      </div>
      <div
        className="card-body py-3 flex flex-col gap-2 text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        <div>
          Every node creation and every node start publishes a hardware
          snapshot on the Sentinel chain. The node sends a 1 udvpn
          self-transfer from its own operator address; the memo carries the
          snapshot. Operator-reported, not consensus-validated.
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
          <ExplainerRow icon="memory" text="CPU model (truncated to 64 chars)." />
          <ExplainerRow
            icon="developer_board"
            text="Total logical host cores and the cores available to the dvpn-node container (Docker/WSL2 VM)."
          />
          <ExplainerRow icon="storage" text="Total host RAM (MiB) and the RAM available to the container (Docker/WSL2 VM)." />
          <ExplainerRow
            icon="receipt_long"
            text="Detection rule: fromAddress === toAddress + specs:v1: memo prefix."
          />
        </div>
      </div>
    </div>
  );
}

function ExplainerRow({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="flex items-start gap-2">
      <MIcon
        name={icon}
        size={12}
        style={{ marginTop: 2, color: 'var(--accent)' }}
      />
      <span>{text}</span>
    </div>
  );
}

type CpuVendor = 'amd' | 'nvidia' | 'intel' | 'apple' | 'arm' | 'unknown';

function detectCpuVendor(model: string): CpuVendor {
  const m = model.toLowerCase();
  if (/\bamd\b|ryzen|epyc|threadripper|radeon/.test(m)) return 'amd';
  if (/nvidia|geforce|quadro|tesla|grace/.test(m)) return 'nvidia';
  if (/\bintel\b|core\s*i[3579]|xeon|pentium|celeron/.test(m)) return 'intel';
  if (/\bapple\b|\bm[123]\b/.test(m)) return 'apple';
  if (/\barm\b|cortex|snapdragon|ampere/.test(m)) return 'arm';
  return 'unknown';
}

/**
 * Vendor wordmarks. Rendered as text-based SVGs so they read clearly at any
 * size and stay sharp under HiDPI. Brand colours used directly. The hosting
 * badge in `SpecsSnapshotCard` paints a neutral light tile behind these so
 * the AMD/Intel/Nvidia hues stay legible in both light and dark themes.
 */
function VendorMark({ vendor, size = 18 }: { vendor: CpuVendor; size?: number }) {
  switch (vendor) {
    case 'amd':
      // AMD pre-2013 wordmark — sourced from
      // https://commons.wikimedia.org/wiki/File:AMD_logo_pre-2013.svg
      // (public domain). Black "AMD" + the green arrow tile.
      return (
        <svg
          width={size * 3.2}
          height={size * 0.76}
          viewBox="0 0 800 190.803"
          aria-label="AMD"
          role="img"
        >
          <g>
            <path
              fill="#000000"
              d="M187.888,178.12H143.52l-13.573-32.735H56.003L43.637,178.12H0L66.667,12.776h47.761L187.888,178.12z M91.155,52.285L66.912,116.53h50.913L91.155,52.285z"
            />
            <path
              fill="#000000"
              d="M349.056,12.776h35.88V178.12h-41.219V74.842l-44.608,51.878h-6.301l-44.605-51.878V178.12h-41.219V12.776h35.88l53.093,61.336L349.056,12.776z"
            />
            <path
              fill="#000000"
              d="M489.375,12.776c60.364,0,91.391,37.573,91.391,82.909c0,47.517-30.058,82.435-96,82.435h-68.369V12.776H489.375z M457.613,147.815h26.906c41.457,0,53.823-28.127,53.823-52.375c0-28.368-15.276-52.363-54.308-52.363h-26.422V147.815L457.613,147.815z"
            />
          </g>
          <g>
            <polygon
              fill="#00A76D"
              points="748.028,51.981 662.769,51.981 610.797,0 800,0 800,189.21 748.028,137.235"
            />
            <polygon
              fill="#00A76D"
              points="662.708,137.296 662.708,62.397 609.2,115.901 609.2,190.804 684.089,190.804 737.594,137.296"
            />
          </g>
        </svg>
      );
    case 'nvidia':
      // NVIDIA wordmark in brand green.
      return (
        <svg
          width={size * 3}
          height={size}
          viewBox="0 0 120 40"
          aria-label="NVIDIA"
          role="img"
        >
          <text
            x="60"
            y="30"
            textAnchor="middle"
            fontFamily="'Inter', 'Helvetica Neue', Arial, sans-serif"
            fontWeight="800"
            fontSize="26"
            letterSpacing="0.5"
            fill="#76B900"
          >
            NVIDIA
          </text>
        </svg>
      );
    case 'intel':
      // Intel wordmark in brand blue, rounded lowercase.
      return (
        <svg
          width={size * 2.4}
          height={size}
          viewBox="0 0 96 40"
          aria-label="Intel"
          role="img"
        >
          <text
            x="48"
            y="30"
            textAnchor="middle"
            fontFamily="'Inter', 'Helvetica Neue', Arial, sans-serif"
            fontWeight="700"
            fontSize="26"
            letterSpacing="-0.5"
            fill="#0071C5"
          >
            intel
          </text>
        </svg>
      );
    case 'apple':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="#000000"
          aria-label="Apple"
          role="img"
        >
          <path d="M16.5 12.5 C16.5 10.5 18 9.5 18 9.5 C17 8 15.5 8 14.5 8 C13 8 12.5 8.7 11.5 8.7 C10.5 8.7 9.5 8 8.2 8 C6.5 8 4.5 9.2 4.5 12.5 C4.5 16 7 19 8.5 19 C9.4 19 10 18.3 11.5 18.3 C13 18.3 13.4 19 14.5 19 C15.7 19 17 17 17.5 15.5 C17 15.3 16.5 14.3 16.5 12.5 Z M13.5 7 C14.2 6.2 14.5 5 14.4 4 C13.4 4.1 12.4 4.7 11.7 5.5 C11.1 6.2 10.7 7.4 10.8 8.4 C11.8 8.5 12.8 7.9 13.5 7 Z" />
        </svg>
      );
    case 'arm':
      return (
        <svg
          width={size * 2.4}
          height={size}
          viewBox="0 0 96 40"
          aria-label="Arm"
          role="img"
        >
          <text
            x="48"
            y="30"
            textAnchor="middle"
            fontFamily="'Inter', 'Helvetica Neue', Arial, sans-serif"
            fontWeight="800"
            fontSize="26"
            fill="#0091BD"
          >
            arm
          </text>
        </svg>
      );
    default:
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="#6b7280"
          aria-hidden
        >
          <rect x="6" y="6" width="12" height="12" rx="2" />
          <rect x="9" y="9" width="6" height="6" rx="1" fill="#ffffff" />
        </svg>
      );
  }
}

function SpecsSnapshotCard({
  report,
  docker,
}: {
  report: LocalSystemReport;
  docker: DockerOverview | null;
}) {
  const cpu = (report.cpuModel ?? 'Unknown CPU').replace(/\s+/g, ' ').trim();
  const vendor = detectCpuVendor(cpu);
  const totalCores = Number.isFinite(report.cpuCores) ? report.cpuCores : 0;
  const totalRamMb = Number.isFinite(report.memoryMb) ? report.memoryMb : 0;
  const dockerOk = !!docker && docker.reachable;
  // Resources AVAILABLE to the container (Docker engine / WSL2 VM view), not
  // reserved — the node container runs uncapped, so this is its real ceiling.
  const availCores =
    dockerOk && Number.isFinite(docker!.ncpu) && docker!.ncpu! > 0
      ? docker!.ncpu!
      : totalCores;
  const availRamMb =
    dockerOk &&
    Number.isFinite(docker!.totalMemoryMb) &&
    docker!.totalMemoryMb! > 0
      ? docker!.totalMemoryMb!
      : totalRamMb;
  const coreRatio = totalCores > 0 ? availCores / totalCores : 0;
  const ramRatio = totalRamMb > 0 ? availRamMb / totalRamMb : 0;
  const totalRamGb = totalRamMb / 1024;
  const availRamGb = availRamMb / 1024;
  const fmtRam = (mb: number, gb: number) =>
    mb > 0 ? `${gb.toFixed(1)} GB` : '—';
  return (
    <div className="card overflow-hidden">
      <div className="card-header py-2">
        <div className="flex items-center gap-2 min-w-0">
          <MIcon name="memory" size={14} style={{ color: 'var(--accent)' }} />
          <div className="card-title text-[13.3px]">Snapshot for this machine</div>
        </div>
      </div>
      <div className="card-body flex flex-col gap-3" style={{ paddingTop: 15, paddingBottom: 16 }}>
        {/* CPU hero */}
        <div
          className="flex items-center gap-3 rounded-lg px-3 py-2.5"
          style={{
            background:
              'linear-gradient(180deg, var(--bg-input) 0%, transparent 100%)',
            border: '1px solid var(--border)',
          }}
        >
          <div
            className="flex items-center justify-center rounded-md flex-shrink-0 px-2"
            style={{
              minWidth: 56,
              height: 36,
              background: '#ffffff',
              border: '1px solid var(--border)',
              boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
            }}
          >
            <VendorMark vendor={vendor} size={18} />
          </div>
          <div className="flex flex-col min-w-0 leading-tight">
            <span
              className="text-[9.5px] uppercase tracking-[0.12em]"
              style={{ color: 'var(--text-dim)' }}
            >
              Processor
            </span>
            <span
              className="text-[13.3px] font-semibold truncate"
              style={{ color: 'var(--text)' }}
              title={cpu}
            >
              {cpu}
            </span>
          </div>
        </div>

        {/* Available-to-container / host-total meters */}
        <div className="flex flex-col gap-2.5">
          <SpecsMeter
            icon="developer_board"
            label="Cores"
            available={`${availCores}`}
            total={`${totalCores}`}
            ratio={coreRatio}
          />
          <SpecsMeter
            icon="storage"
            label="RAM"
            available={fmtRam(availRamMb, availRamGb)}
            total={fmtRam(totalRamMb, totalRamGb)}
            ratio={ramRatio}
          />
        </div>
      </div>
    </div>
  );
}

function SpecsMeter({
  icon,
  label,
  available,
  total,
  ratio,
}: {
  icon: string;
  label: string;
  available: string;
  total: string;
  ratio: number;
}) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <MIcon name={icon} size={14} style={{ color: 'var(--accent)' }} />
          <span
            className="text-[10.5px] uppercase tracking-[0.1em] font-medium"
            style={{ color: 'var(--text-muted)' }}
          >
            {label}
          </span>
        </span>
        <div className="flex flex-col items-end leading-tight">
          <span
            className="text-[8.5px] uppercase tracking-[0.12em]"
            style={{ color: 'var(--text-dim)' }}
          >
            Available / Total
          </span>
          <span
            className="text-[13.3px] tabular-nums"
            style={{ color: 'var(--text-muted)' }}
          >
            <span className="font-semibold" style={{ color: 'var(--text)' }}>
              {available}
            </span>
            <span className="opacity-60 mx-1.5">/</span>
            <span>{total}</span>
          </span>
        </div>
      </div>
      <div
        className="relative rounded-full overflow-hidden"
        style={{
          height: 6,
          background: 'var(--bg-input)',
          border: '1px solid var(--border)',
        }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out"
          style={{
            width: `${pct}%`,
            background:
              'linear-gradient(90deg, var(--accent) 0%, var(--accent) 70%, color-mix(in srgb, var(--accent) 70%, white) 100%)',
            boxShadow: '0 0 8px color-mix(in srgb, var(--accent) 40%, transparent)',
          }}
        />
      </div>
    </div>
  );
}

function SpecsMemoCard({
  report,
  docker,
}: {
  report: LocalSystemReport;
  docker: DockerOverview | null;
}) {
  const { snapshot, memo, bytes } = buildSpecsPreview(report, docker);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(memo);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable; ignore */
    }
  };
  return (
    <div className="card">
      <div className="card-header py-2">
        <div className="flex items-center gap-2 min-w-0">
          <MIcon name="receipt_long" size={14} style={{ color: 'var(--accent)' }} />
          <div className="card-title text-[13.3px]">On-chain memo preview</div>
        </div>
      </div>
      <div className="card-body py-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div
            className="text-[9.5px] uppercase tracking-wider"
            style={{ color: 'var(--text-dim)' }}
          >
            Memo (UTF-8, {bytes} / 240 bytes)
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void copy()}
            style={{ padding: '2px 8px' }}
          >
            <MIcon name={copied ? 'check' : 'content_copy'} size={12} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre
          className="mono-inline text-[10.5px] p-2.5 overflow-auto whitespace-pre-wrap break-all"
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text)',
            margin: 0,
          }}
        >
          {memo}
        </pre>
        <div
          className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[10.5px]"
          style={{ color: 'var(--text-muted)' }}
        >
          <FieldRow k="cpu" v={snapshot.cpu} desc="CPU model (≤ 64 chars)" />
          <FieldRow k="c" v={String(snapshot.c)} desc="Total logical host cores" />
          <FieldRow
            k="cr"
            v={String(snapshot.cr)}
            desc="Cores available to container (Docker/WSL2 VM)"
          />
          <FieldRow k="r" v={String(snapshot.r)} desc="Total host RAM (MiB)" />
          <FieldRow
            k="rr"
            v={String(snapshot.rr)}
            desc="RAM available to container (Docker/WSL2 VM, MiB)"
          />
        </div>
      </div>
    </div>
  );
}

function buildSpecsPreview(
  report: LocalSystemReport,
  docker: DockerOverview | null,
): { snapshot: { cpu: string; c: number; cr: number; r: number; rr: number }; memo: string; bytes: number } {
  const cpu = (report.cpuModel ?? 'Unknown CPU').replace(/\s+/g, ' ').trim().slice(0, 64);
  const c = Number.isFinite(report.cpuCores) ? report.cpuCores : 0;
  const r = Number.isFinite(report.memoryMb) ? report.memoryMb : 0;
  const dockerOk = docker && docker.reachable;
  const cr =
    dockerOk && Number.isFinite(docker!.ncpu) && docker!.ncpu! > 0
      ? docker!.ncpu!
      : c;
  const rr =
    dockerOk &&
    Number.isFinite(docker!.totalMemoryMb) &&
    docker!.totalMemoryMb! > 0
      ? docker!.totalMemoryMb!
      : r;
  const snapshot = { cpu, c, cr, r, rr };
  const memo = `specs:v1:${JSON.stringify(snapshot)}`;
  return { snapshot, memo, bytes: new TextEncoder().encode(memo).length };
}

function FieldRow({ k, v, desc }: { k: string; v: string; desc: string }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <code
        className="mono-inline text-[10px] flex-shrink-0"
        style={{
          background: 'var(--bg-input)',
          border: '1px solid var(--border)',
          color: 'var(--text)',
          padding: '1px 6px',
          borderRadius: 4,
        }}
      >
        {k}
      </code>
      <span className="font-medium truncate" style={{ color: 'var(--text)' }} title={v}>
        {v}
      </span>
      <span className="flex-shrink-0" style={{ color: 'var(--text-dim)' }}>
        — {desc}
      </span>
    </div>
  );
}
