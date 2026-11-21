import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { ProfitPoint } from '../api/contract';
import { formatSignedCents } from '../money';
import { CHART_HEIGHT, CHART_WIDTH, nearestIndex, profitLine } from './profitLine';

interface ProfitChartProps {
  /** The running net after each round, oldest first, as the server sends it. */
  readonly profit: readonly ProfitPoint[];
}

/**
 * Profit over time: one line, the running net after each round.
 *
 * Above $0.00 the area is tinted mint (a real gain); below it, grey. Pointing
 * at the chart, or using the arrow keys on it, shows the net after that
 * round; otherwise it shows the latest.
 */
export function ProfitChart({ profit }: ProfitChartProps) {
  const line = useMemo(() => profitLine(profit), [profit]);
  const [picked, setPicked] = useState<number | null>(null);
  const clipId = useId();
  const { points, zeroY } = line;
  const lastIndex = points.length - 1;
  const shownIndex = picked === null ? lastIndex : Math.min(picked, lastIndex);
  const shown = points[shownIndex];
  const last = points[lastIndex];
  if (!shown || !last) return null;

  const path = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `0,${zeroY.toFixed(1)} ${path} ${last.x.toFixed(1)},${zeroY.toFixed(1)}`;

  const pick = (event: PointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    setPicked(nearestIndex(points, ((event.clientX - box.left) / box.width) * CHART_WIDTH));
  };
  const step = (event: KeyboardEvent<HTMLDivElement>): void => {
    const moves: Record<string, number> = {
      ArrowLeft: shownIndex - 1,
      ArrowRight: shownIndex + 1,
      Home: 0,
      End: lastIndex,
    };
    const to = moves[event.key];
    if (to === undefined) return;
    event.preventDefault();
    setPicked(Math.max(0, Math.min(lastIndex, to)));
  };

  const description =
    `Net after each round, rounds 1 to ${String(last.round)}. ` +
    `Highest ${formatSignedCents(line.highCents)}, lowest ${formatSignedCents(line.lowCents)}, ` +
    `now ${formatSignedCents(last.netCents)}.`;

  return (
    <figure className="profit-chart">
      <p className="profit-readout">
        <span className="muted">{shown.round === 0 ? 'Start' : `Round ${String(shown.round)}`}</span>
        <span className={shown.netCents > 0 ? 'win' : undefined}>
          {formatSignedCents(shown.netCents)}
        </span>
      </p>
      <div
        className="profit-plot"
        role="img"
        aria-label={description}
        tabIndex={0}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setPicked(null)}
        onKeyDown={step}
        onBlur={() => setPicked(null)}
      >
        <svg
          viewBox={`0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <clipPath id={`${clipId}-up`}>
              <rect x="0" y="0" width={CHART_WIDTH} height={zeroY} />
            </clipPath>
            <clipPath id={`${clipId}-down`}>
              <rect x="0" y={zeroY} width={CHART_WIDTH} height={CHART_HEIGHT - zeroY} />
            </clipPath>
          </defs>
          <polygon className="profit-gain" points={area} clipPath={`url(#${clipId}-up)`} />
          <polygon className="profit-loss" points={area} clipPath={`url(#${clipId}-down)`} />
          <line className="profit-zero" x1="0" x2={CHART_WIDTH} y1={zeroY} y2={zeroY} />
          {picked !== null && (
            <line className="profit-cross" x1={shown.x} x2={shown.x} y1="0" y2={CHART_HEIGHT} />
          )}
          <polyline className="profit-line" points={path} />
        </svg>
        {/* The dot is HTML so it stays round however the chart is stretched. */}
        <span
          className="profit-dot"
          style={{
            left: `${String((shown.x / CHART_WIDTH) * 100)}%`,
            top: `${String((shown.y / CHART_HEIGHT) * 100)}%`,
          }}
        />
        <span className="profit-axis profit-axis-high">{formatSignedCents(line.highCents)}</span>
        <span className="profit-axis profit-axis-low">{formatSignedCents(line.lowCents)}</span>
      </div>
      <div className="profit-x muted">
        <span>Start</span>
        <span>Round {last.round}</span>
      </div>
    </figure>
  );
}
