import { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { MIcon } from '../components/MIcon';
import { QRCode } from '../components/QRCode';
import { useApp } from '../store/app';
import { fmtDVPN, shortAddr } from '../lib/format';

export function WalletSetup() {
  const { wallet, setWallet, refreshWallet, navigate, pushToast } = useApp();
  const [mode, setMode] = useState<'choose' | 'restore' | 'reveal' | 'funded'>(
    wallet?.address ? 'funded' : 'choose',
  );
  const [mnemonic, setMnemonic] = useState('');
  const [freshMnemonic, setFreshMnemonic] = useState<string | null>(null);
  const [confirmedBackup, setConfirmedBackup] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);

  const doCreate = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.api.wallet.create();
      setWallet(res.wallet);
      setFreshMnemonic(res.mnemonic);
      setMode('reveal');
      pushToast({
        title: 'Wallet created',
        body: 'Record your recovery phrase before continuing.',
        tone: 'success',
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const mnemonicWordCount = mnemonic.trim().split(/\s+/).filter(Boolean).length;
  const validBip39Lengths = [12, 15, 18, 21, 24];
  const mnemonicLengthOk = validBip39Lengths.includes(mnemonicWordCount);

  const doRestore = async () => {
    setError(null);
    if (!mnemonicLengthOk) {
      setError(
        `BIP-39 phrases are 12, 15, 18, 21, or 24 words — you pasted ${mnemonicWordCount}.`,
      );
      return;
    }
    setBusy(true);
    try {
      const w = await window.api.wallet.restore(mnemonic.trim());
      setWallet(w);
      setMode('funded');
      pushToast({
        title: 'Wallet restored',
        body: shortAddr(w.address, 10, 6),
        tone: 'success',
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doRefresh = async () => {
    setRefreshing(true);
    setChainError(null);
    try {
      await refreshWallet();
    } catch (e) {
      setChainError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  // Probe chain on entry to the funded view so a balance of 0 with a
  // dead RPC surfaces as "chain unreachable" instead of "wallet empty".
  useEffect(() => {
    if (mode !== 'funded' || !wallet?.address) return;
    let cancelled = false;
    (async () => {
      try {
        await refreshWallet();
        if (!cancelled) setChainError(null);
      } catch (e) {
        if (!cancelled) setChainError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, wallet?.address]);

  const copyAddress = async () => {
    if (!wallet?.address) return;
    await navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="flex flex-col gap-5 max-w-4xl mx-auto w-full pb-6">
      <PageHeader
        title="Wallet setup"
        subtitle="Your recovery phrase is encrypted by the OS keychain and never leaves this device."
      />

      {mode === 'choose' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ChoiceCard
            icon="add_circle"
            title="Create new wallet"
            desc="Generate a fresh 24-word BIP-39 recovery phrase. Shown only once — record it before continuing."
            cta={busy ? 'Working…' : 'Create wallet'}
            ctaIcon="arrow_forward"
            busy={busy}
            onClick={doCreate}
            tone="accent"
          />
          <ChoiceCard
            icon="restore"
            title="Restore existing wallet"
            desc="Import a Sentinel or Cosmos account using its 12 to 24-word recovery phrase."
            cta="Restore wallet"
            ctaIcon="arrow_forward"
            busy={false}
            onClick={() => setMode('restore')}
            secondary
            tone="muted"
          />
          {error && <div className="md:col-span-2 callout callout-danger">{error}</div>}
        </div>
      )}

      {mode === 'restore' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">Restore from mnemonic</div>
          </div>
          <div className="card-body flex flex-col gap-3">
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Paste your recovery phrase below. It is encrypted by the OS keychain on receipt
              and the plaintext is never written to disk.
            </p>
            <textarea
              value={mnemonic}
              onChange={(e) => setMnemonic(e.target.value)}
              rows={4}
              placeholder="tribe solution puppy eager nasty lonely …"
              className="field-input mono-inline text-sm"
              style={{ lineHeight: 1.7 }}
              aria-invalid={mnemonicWordCount > 0 && !mnemonicLengthOk}
            />
            <div
              className="flex items-center justify-between text-[11px]"
              style={{ color: 'var(--text-dim)' }}
            >
              <span>
                {mnemonicWordCount === 0
                  ? 'Awaiting input'
                  : mnemonicLengthOk
                  ? `${mnemonicWordCount} words — valid BIP-39 length`
                  : `${mnemonicWordCount} words — needs 12, 15, 18, 21, or 24`}
              </span>
              <span>BIP-39</span>
            </div>
            {error && <div className="callout callout-danger text-xs">{error}</div>}
            <div className="flex gap-2 justify-end">
              <button
                className="btn btn-secondary"
                onClick={() => setMode('choose')}
                disabled={busy}
              >
                Back
              </button>
              <button
                className="btn btn-primary"
                onClick={doRestore}
                disabled={busy || !mnemonicLengthOk}
              >
                {busy ? 'Restoring…' : 'Restore wallet'}
                <MIcon name="arrow_forward" size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

      {mode === 'reveal' && freshMnemonic && (
        <MnemonicReveal
          mnemonic={freshMnemonic}
          copied={copied}
          onCopy={async () => {
            await navigator.clipboard.writeText(freshMnemonic);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          confirmedBackup={confirmedBackup}
          onConfirm={(v) => setConfirmedBackup(v)}
          onContinue={() => {
            setFreshMnemonic(null);
            setMode('funded');
          }}
        />
      )}

      {mode === 'funded' && wallet?.address && (
        <>
          <div className="card">
            <div className="card-header">
              <div className="card-title">Funding status</div>
              <span className="chip chip-success">
                <MIcon name="verified" size={12} />
                Ready
              </span>
            </div>
            <div className="card-body flex flex-col gap-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                <QRCode value={wallet.address} size={104} />
                <div className="flex-1 min-w-0 w-full">
                  <div
                    className="text-[11px] uppercase tracking-wider mb-1"
                    style={{ color: 'var(--text-dim)' }}
                  >
                    Wallet address
                  </div>
                  <div
                    className="mono-inline text-[13px] break-all leading-relaxed"
                    style={{ color: 'var(--text)' }}
                  >
                    {wallet.address}
                  </div>
                  <div
                    className="mt-2 flex items-center gap-3 text-[11px]"
                    style={{ color: 'var(--text-dim)' }}
                  >
                    <span>{shortAddr(wallet.address, 10, 8)}</span>
                    <button
                      onClick={copyAddress}
                      className="flex items-center gap-1"
                      style={{ color: 'var(--accent)' }}
                    >
                      <MIcon name="content_copy" size={12} />
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              </div>
              {chainError && (
                <div className="callout callout-danger text-xs flex items-start gap-2">
                  <MIcon name="cloud_off" size={14} />
                  <div className="flex-1">
                    <div className="font-semibold">Sentinel chain unreachable</div>
                    <div style={{ color: 'var(--text-muted)' }}>
                      The balance below may be stale. The RPC endpoint did not respond:{' '}
                      <span className="mono-inline">{chainError}</span>
                    </div>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <div
                    className="text-[11px] uppercase tracking-wider"
                    style={{ color: 'var(--text-dim)' }}
                  >
                    Current balance
                  </div>
                  <div
                    className="mt-1 text-2xl font-semibold"
                    style={{ color: 'var(--text)' }}
                  >
                    {fmtDVPN(wallet.balanceDVPN)}{' '}
                    <span className="text-lg" style={{ color: 'var(--text-muted)' }}>
                      $P2P
                    </span>
                  </div>
                </div>
                <div>
                  <div
                    className="text-[11px] uppercase tracking-wider"
                    style={{ color: 'var(--text-dim)' }}
                  >
                    Recommended for deploy
                  </div>
                  <div
                    className="mt-1 text-2xl font-semibold"
                    style={{ color: 'var(--text)' }}
                  >
                    10.00{' '}
                    <span className="text-lg" style={{ color: 'var(--text-muted)' }}>
                      $P2P
                    </span>
                  </div>
                </div>
              </div>
              <div
                className="text-xs leading-relaxed px-3 py-2.5"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-muted)',
                }}
              >
                <b style={{ color: 'var(--text)' }}>About the app wallet.</b> The app wallet
                holds gas for transactions and receives rewards withdrawn from your nodes. Each
                node has its own operator key, generated during sentinel-dvpnx initialization.
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <button
              className="btn btn-ghost"
              onClick={() => setMode('choose')}
            >
              <MIcon name="arrow_back" size={14} />
              Back to selection
            </button>
            <div className="flex gap-2">
              <button
                className="btn btn-secondary"
                onClick={doRefresh}
                disabled={refreshing}
              >
                <MIcon name="refresh" size={14} />
                {refreshing ? 'Querying chain…' : 'Refresh balance'}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => navigate({ name: 'overview' })}
              >
                Proceed to dashboard
                <MIcon name="arrow_forward" size={14} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MnemonicReveal({
  mnemonic,
  copied,
  onCopy,
  confirmedBackup,
  onConfirm,
  onContinue,
}: {
  mnemonic: string;
  copied: boolean;
  onCopy: () => void | Promise<void>;
  confirmedBackup: boolean;
  onConfirm: (v: boolean) => void;
  onContinue: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const words = mnemonic.trim().split(/\s+/);

  return (
    <div
      className="card"
      style={{
        borderColor: 'color-mix(in srgb, var(--yellow) 45%, var(--border))',
      }}
    >
      <div className="card-header">
        <div
          className="card-title flex items-center gap-2"
          style={{ color: 'var(--yellow)' }}
        >
          <MIcon name="warning" size={18} />
          Record your recovery phrase
        </div>
        <span
          className="text-[10px] uppercase tracking-wider px-2 py-1 rounded"
          style={{
            background: 'color-mix(in srgb, var(--yellow) 14%, transparent)',
            border: '1px solid color-mix(in srgb, var(--yellow) 35%, transparent)',
            color: 'var(--yellow)',
          }}
        >
          Displayed only once
        </span>
      </div>
      <div className="card-body flex flex-col gap-4">
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Write these {words.length} words down in order. Anyone with this phrase can spend
          your funds. The phrase is shown once and is never displayed again.
        </p>

        <div className="relative">
          <div
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2"
            style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: '14px',
              transition: 'filter 200ms ease',
            }}
          >
            {/* L-12: render the actual words only once the user reveals them.
              * The previous build kept every word in the DOM and merely
              * CSS-blurred them, so the live recovery phrase was readable in
              * DevTools / accessibility tree the whole time. Before reveal we
              * render inert placeholder dots — no secret enters the tree. */}
            {words.map((word, i) => (
              <div
                key={`${i}-${revealed ? word : 'hidden'}`}
                className="flex items-center gap-2 px-2.5 py-2"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm, 8px)',
                }}
              >
                <span
                  className="tabular-nums text-[11px] font-semibold"
                  style={{ color: 'var(--text-dim)', minWidth: '1.5rem' }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span
                  className="font-mono text-[13px] truncate"
                  style={{ color: revealed ? 'var(--text)' : 'var(--text-dim)' }}
                  aria-hidden={!revealed}
                >
                  {revealed ? word : '••••••'}
                </span>
              </div>
            ))}
          </div>

          {!revealed && (
            <button
              type="button"
              onClick={() => setRevealed(true)}
              className="absolute inset-0 flex flex-col items-center justify-center gap-2"
              style={{
                background: 'color-mix(in srgb, var(--bg) 55%, transparent)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--text)',
              }}
            >
              <MIcon name="visibility" size={22} />
              <span className="text-sm font-semibold">Click to reveal phrase</span>
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Make sure no one is looking at your screen
              </span>
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn btn-secondary text-xs"
            onClick={() => void onCopy()}
            disabled={!revealed}
          >
            <MIcon name="content_copy" size={14} />
            {copied ? 'Copied' : 'Copy phrase'}
          </button>
          {revealed && (
            <button
              className="btn btn-ghost text-xs"
              onClick={() => setRevealed(false)}
              title="Hide the phrase again"
            >
              <MIcon name="visibility_off" size={14} />
              Hide
            </button>
          )}
          <span
            className="text-[11px] ml-auto"
            style={{ color: 'var(--text-dim)' }}
          >
            {words.length} words · BIP-39
          </span>
        </div>

        <label
          className="flex items-start gap-2 text-sm cursor-pointer select-none"
          style={{ color: 'var(--text)' }}
        >
          <input
            type="checkbox"
            checked={confirmedBackup}
            onChange={(e) => onConfirm(e.target.checked)}
            className="h-4 w-4 mt-0.5 flex-shrink-0"
          />
          <span className="leading-snug">
            I have securely stored my recovery phrase. The wallet cannot be recovered if this
            phrase is lost.
          </span>
        </label>

        <div className="flex justify-end">
          <button
            className="btn btn-primary"
            disabled={!confirmedBackup}
            onClick={onContinue}
          >
            Continue
            <MIcon name="arrow_forward" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ChoiceCard({
  icon,
  title,
  desc,
  cta,
  ctaIcon,
  onClick,
  busy,
  secondary,
  tone = 'accent',
}: {
  icon: string;
  title: string;
  desc: string;
  cta: string;
  ctaIcon: string;
  onClick: () => void;
  busy: boolean;
  secondary?: boolean;
  tone?: 'accent' | 'muted';
}) {
  const isAccent = tone === 'accent';
  const tileBg = isAccent
    ? 'color-mix(in srgb, var(--accent) 14%, transparent)'
    : 'color-mix(in srgb, var(--text-muted) 10%, transparent)';
  const tileBorder = isAccent
    ? '1px solid color-mix(in srgb, var(--accent) 35%, transparent)'
    : '1px solid var(--border)';
  const tileColor = isAccent ? 'var(--accent)' : 'var(--text-muted)';
  return (
    <div className="card flex flex-col h-full">
      <div className="card-body flex flex-col items-center text-center flex-1 gap-5 p-8">
        <div
          className="rounded-2xl grid place-items-center"
          style={{
            height: 88,
            width: 88,
            background: tileBg,
            border: tileBorder,
            color: tileColor,
          }}
        >
          <MIcon name={icon} size={44} />
        </div>
        <div className="flex flex-col gap-2 items-center">
          <div className="text-xl font-semibold leading-tight" style={{ color: 'var(--text)' }}>
            {title}
          </div>
          <p className="text-sm leading-relaxed max-w-xs" style={{ color: 'var(--text-muted)' }}>
            {desc}
          </p>
        </div>
        <div className="flex-1" />
        <button
          onClick={onClick}
          disabled={busy}
          className={`btn ${secondary ? 'btn-secondary' : 'btn-primary'} w-full`}
        >
          <MIcon name={ctaIcon} size={14} />
          {cta}
        </button>
      </div>
    </div>
  );
}
