import { useEffect, useRef, useState } from 'react';

interface Props {
  percent: number;
  size?: number;
  stroke?: number;
  /** Accepted for API compatibility; the rotating overlay was removed because
   * it visually read as the bar regressing. */
  spinning?: boolean;
  label?: string;
  sublabel?: string;
}

/**
 * Circular progress indicator used on the Progress / Installing Node screen.
 *
 * The deploy backend emits coarse milestones (1 → 6 → 10 → 36 → 45 → 55 →
 * 62 → 72 → 78 → 82 → 90 → 96 → 100). If we just plug those numbers into
 * the ring it visibly jumps and then sits frozen for many seconds during
 * long phases like the image build. To paper over that, the ring renders
 * a smoothed value that:
 *   1. eases toward the latest target percent on every change, and
 *   2. while a milestone is sitting still, slowly creeps forward toward
 *      (but never past) the next milestone so the user sees life.
 */
const MILESTONES = [0, 1, 3, 6, 10, 12, 36, 45, 55, 62, 72, 78, 82, 90, 96, 100];

function nextMilestoneAfter(p: number): number {
  for (const m of MILESTONES) if (m > p + 0.05) return m;
  return 100;
}

export function ProgressRing({
  percent,
  size = 200,
  stroke = 14,
  label,
  sublabel,
}: Props) {
  const target = Math.max(0, Math.min(100, percent));
  // `effectiveTarget` is monotonic for the lifetime of a single deploy so
  // momentary backend regressions (e.g. a log frame re-asserting a lower
  // phase) don't cause the visible bar to flow backwards. We only allow a
  // hard reset when the target collapses all the way to 0 — the renderer
  // does this between deploys.
  //
  // L-12: this used to be a ref mutated *during render*, which is impure —
  // under StrictMode double-render / concurrent discard a thrown-away render
  // could leave the peak corrupted. The peak now lives in state and is
  // advanced from an effect (the rAF loop reads it via a mirror ref so it
  // doesn't need to re-subscribe on every creep).
  const [effectiveTarget, setEffectiveTarget] = useState<number>(target);
  const peakTargetRef = useRef<number>(target);

  useEffect(() => {
    setEffectiveTarget((prev) => {
      const next = target <= 0.05 ? 0 : Math.max(prev, target);
      peakTargetRef.current = next;
      return next;
    });
  }, [target]);

  const [shown, setShown] = useState(target);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  useEffect(() => {
    const tick = (now: number) => {
      const last = lastTickRef.current || now;
      const dt = Math.min(now - last, 1000); // ms
      lastTickRef.current = now;

      setShown((curr) => {
        const t = peakTargetRef.current;
        if (t >= 100) {
          // Smoothly close the last gap to 100 instead of snapping.
          if (curr >= 99.95) return 100;
          const gain = 1 - Math.exp(-dt / 180);
          return curr + (100 - curr) * gain;
        }
        const ceiling = Math.min(100, nextMilestoneAfter(t) - 1);

        let next: number;
        if (curr < t - 0.25) {
          // Phase A: ease toward the real backend target.
          const gain = 1 - Math.exp(-dt / 220);
          next = curr + (t - curr) * gain;
        } else {
          // Phase B: creep toward the ceiling while sitting on a milestone.
          const room = Math.max(0, ceiling - curr);
          if (room < 0.05) return curr;
          const creepRate = Math.max(0.06, room * 0.018); // %/s
          next = Math.min(ceiling, curr + (creepRate * dt) / 1000);
        }
        // Hard monotonicity: visible bar never moves backwards within a
        // single deploy.
        return next < curr ? curr : next;
      });

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastTickRef.current = 0;
    };
  }, [effectiveTarget]);

  // When target collapses all the way to 0 (new deploy), reset the visible
  // ring too. We never snap back for any other reason — see the
  // monotonicity comment above.
  useEffect(() => {
    if (target <= 0.05) setShown(0);
  }, [target]);

  const clamped = Math.max(0, Math.min(100, shown));
  // Below ~3% the SVG arc is too short to look like an arc — round caps
  // make a stuck blue blob at the top of the ring, butt caps still show a
  // tiny floating sliver. Suppress the arc entirely until we have real
  // progress to show.
  const showArc = clamped >= 3;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - clamped / 100);
  // Only enable round caps once we're well past the threshold so the cap
  // overhang never extends past the arc start at 12 o'clock.
  const useRoundCap = clamped > 6;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="var(--border)"
          strokeWidth={stroke}
          fill="none"
        />
        {showArc && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke="url(#grad)"
            strokeWidth={stroke}
            strokeLinecap={useRoundCap ? 'round' : 'butt'}
            fill="none"
            strokeDasharray={circ}
            strokeDashoffset={offset}
          />
        )}
        <defs>
          <linearGradient id="grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--accent-strong, var(--accent))" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div
          className="text-center"
          style={{ maxWidth: size - stroke * 2 - 12, paddingInline: 4 }}
        >
          <div className="text-4xl font-semibold text-text leading-none">
            {Math.round(clamped)}
            <span className="text-xl text-text-muted">%</span>
          </div>
          {label && (
            <div
              className="mt-1.5 text-[9.5px] uppercase tracking-[0.14em] text-text-muted leading-tight break-words"
              style={{ wordBreak: 'break-word', hyphens: 'auto' }}
            >
              {label}
            </div>
          )}
          {sublabel && (
            <div
              className="mt-1 text-[10px] text-text-dim leading-tight break-words"
              style={{ wordBreak: 'break-word' }}
            >
              {sublabel}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
