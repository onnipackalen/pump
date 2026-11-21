import { useId, useMemo } from 'react';
import { formatCents, formatSignedCents } from '../money';
import { thinLine } from './liveTally';
import { ProfitChart } from './ProfitChart';
import type { LiveStatsControl } from './useLiveStats';
import './stats.css';
import './live-stats.css';

const iconProps = {
  viewBox: '0 0 24 24',
  width: 24,
  height: 24,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const;

/**
 * The small chart button that opens and closes the live stats. App puts it
 * in the top bar (see there for why).
 *
 * While the panel is held back (an upright screen during play), the button
 * says so: it is unavailable, unlit, and its title says when the panel
 * comes back. It never claims to be open while nothing shows.
 */
export function LiveStatsOpener({ live }: { readonly live: LiveStatsControl }) {
  const waitingFor = live.heldBy === 'round' ? 'this round' : 'auto-play';
  return (
    <button
      id={live.openerId}
      type="button"
      className="btn icon-btn live-opener"
      aria-label="Live stats"
      title={live.heldBy === null ? 'Live stats' : `Live stats after ${waitingFor}`}
      aria-expanded={live.shown}
      aria-controls={live.shown ? live.panelId : undefined}
      aria-disabled={live.heldBy === null ? undefined : true}
      onClick={live.heldBy === null ? live.toggle : undefined}
    >
      <svg {...iconProps}>
        <path d="M4 4v16h16" />
        <path d="M7.5 15l3.5-4.5 3 2.5 5-6" />
      </svg>
    </button>
  );
}

/**
 * Live stats: this visit's Profit, Wagered, Wins and Losses, and the profit
 * line, with Reset and Close. Figures come from stats/liveTally.ts.
 *
 * No live region: during auto-play the figures change every round, and
 * reading each change out would never stop. The balance in the top bar
 * already speaks up when play is by hand.
 */
export function LiveStats({ live }: { readonly live: LiveStatsControl }) {
  const { stats } = live;
  const titleId = useId();
  // The figures are exact; only the drawing is thinned on a very long visit.
  const line = useMemo(() => thinLine(stats.profit), [stats.profit]);
  // A round that paid back exactly what it cost is neither: say so where
  // the counts are explained.
  const evenNote = 'A round that paid back exactly its cost is neither a win nor a loss.';

  return (
    <section id={live.panelId} className="live-stats" aria-labelledby={titleId}>
      <div className="ls-head">
        <h2 id={titleId} className="ls-title">
          Live stats
        </h2>
        <div className="ls-tools">
          <button
            type="button"
            className="btn icon-btn ls-tool"
            aria-label="Reset live stats"
            title="Reset"
            onClick={live.reset}
          >
            <svg {...iconProps}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
          <button
            type="button"
            className="btn icon-btn ls-tool"
            aria-label="Close live stats"
            title="Close"
            onClick={live.close}
          >
            <svg {...iconProps}>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>

      <dl className="ls-figures">
        <div title="Paid out minus bets and Patches, for the rounds ended since this page opened or Reset">
          <dt>Profit</dt>
          <dd className={stats.netCents > 0 ? 'win' : undefined}>
            {formatSignedCents(stats.netCents)}
          </dd>
        </div>
        <div title="Bets played plus Patches bought. A bet handed back unplayed is left out.">
          <dt>Wagered</dt>
          <dd>{formatCents(stats.wageredCents)}</dd>
        </div>
        <div title={`Rounds that paid back more than they cost. ${evenNote}`}>
          <dt>Wins</dt>
          <dd>{stats.wins.toLocaleString('en-US')}</dd>
        </div>
        <div title={`Rounds that paid back less than they cost. ${evenNote}`}>
          <dt>Losses</dt>
          <dd>{stats.losses.toLocaleString('en-US')}</dd>
        </div>
      </dl>

      <ProfitChart profit={line} compact />
    </section>
  );
}
