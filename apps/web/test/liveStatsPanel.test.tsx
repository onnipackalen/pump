import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveStats, LiveStatsOpener } from '../src/stats/LiveStats';
import { addRound, NO_LIVE_STATS, type LiveStats as Figures } from '../src/stats/liveTally';
import { ProfitChart } from '../src/stats/ProfitChart';
import { sheetUpTop, SLIDE_MAX_MS, slideOver } from '../src/stats/slideSheet';
import { heldBy, tapOpener, type InPlay, type LiveStatsControl } from '../src/stats/useLiveStats';
import { balloon, round } from './fixtures';

function control(stats: Figures, open = true, held: InPlay = null): LiveStatsControl {
  const nothing = (): void => undefined;
  return {
    stats,
    open,
    heldBy: held,
    shown: open && held === null,
    upright: false,
    reveal: false,
    revealed: nothing,
    panelId: 'live-panel',
    openerId: 'live-opener',
    toggle: nothing,
    close: nothing,
    reset: nothing,
  };
}

const cashed = (id: string, betCents: number, payoutCents: number) =>
  round([balloon({ status: 'cashed', betCents, payoutCents, rung: 2 })], { id });
const popped = (id: string, betCents: number) =>
  round([balloon({ status: 'popped', betCents, rung: 1 })], { id });

/** The text of each figure, by its label. */
function figures(html: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of html.matchAll(/<dt>([^<]+)<\/dt><dd[^>]*>([^<]+)<\/dd>/g)) {
    const [, label, value] = match;
    if (label !== undefined && value !== undefined) found[label] = value;
  }
  return found;
}

describe('LiveStats panel', () => {
  it('shows the four figures in whole cents', () => {
    const stats = [cashed('a', 100, 250), popped('b', 100), cashed('c', 10, 10)].reduce(
      addRound,
      NO_LIVE_STATS,
    );
    const html = renderToStaticMarkup(<LiveStats live={control(stats)} />);
    expect(figures(html)).toEqual({
      Profit: '+$0.50',
      Wagered: '$2.10',
      Wins: '1',
      Losses: '1',
    });
  });

  it('colours Profit mint only for a real gain', () => {
    const up = renderToStaticMarkup(
      <LiveStats live={control(addRound(NO_LIVE_STATS, cashed('a', 100, 250)))} />,
    );
    expect(up).toContain('<dd class="win">+$1.50</dd>');
    const down = renderToStaticMarkup(
      <LiveStats live={control(addRound(NO_LIVE_STATS, popped('a', 100)))} />,
    );
    expect(down).toContain('<dd>-$1.00</dd>');
    const even = renderToStaticMarkup(<LiveStats live={control(NO_LIVE_STATS)} />);
    expect(even).toContain('<dd>$0.00</dd>');
  });

  it('says that a break-even round is neither a win nor a loss', () => {
    const html = renderToStaticMarkup(<LiveStats live={control(NO_LIVE_STATS)} />);
    expect(html.match(/neither a win nor a loss/g)).toHaveLength(2);
  });

  it('names its buttons', () => {
    const html = renderToStaticMarkup(<LiveStats live={control(NO_LIVE_STATS)} />);
    expect(html).toContain('id="live-panel"');
    expect(html).toContain('aria-label="Reset live stats"');
    expect(html).toContain('aria-label="Close live stats"');
    expect(html).toContain('No rounds yet.');
  });

  it('draws an unmoved line with no amounts beside it and no dot', () => {
    // No rounds yet (the panel as it first opens, and after Reset): no
    // "$0.00" twice over the chart.
    const empty = renderToStaticMarkup(<LiveStats live={control(NO_LIVE_STATS)} />);
    expect(empty).not.toContain('profit-axis');
    expect(empty).not.toContain('profit-dot');
    // Only break-even rounds: still flat, but the dot marks the latest round.
    const even = renderToStaticMarkup(
      <LiveStats live={control(addRound(NO_LIVE_STATS, cashed('a', 10, 10)))} />,
    );
    expect(even).not.toContain('profit-axis');
    expect(even).toContain('profit-dot');
    // Once the line moves, its highest and lowest are named.
    const moved = renderToStaticMarkup(
      <LiveStats live={control(addRound(NO_LIVE_STATS, popped('a', 100)))} />,
    );
    expect(moved).toContain('profit-axis-high');
    expect(moved).toContain('-$1.00');
  });

  it('has no live region, so auto-play does not chatter', () => {
    const html = renderToStaticMarkup(<LiveStats live={control(NO_LIVE_STATS)} />);
    expect(html).not.toContain('aria-live');
    expect(html).not.toContain('role="status"');
  });
});

describe('LiveStatsOpener', () => {
  it('is a named toggle that points at the panel only while it is open', () => {
    const closed = renderToStaticMarkup(<LiveStatsOpener live={control(NO_LIVE_STATS, false)} />);
    expect(closed).toContain('aria-label="Live stats"');
    expect(closed).toContain('title="Live stats"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('aria-controls');
    const open = renderToStaticMarkup(<LiveStatsOpener live={control(NO_LIVE_STATS, true)} />);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('aria-controls="live-panel"');
    expect(open).not.toContain('aria-disabled');
  });

  it('says it is waiting, and never claims to be open, while play holds the panel back', () => {
    // Open before the round: on an upright screen the strip waits for it to end.
    const round = renderToStaticMarkup(
      <LiveStatsOpener live={control(NO_LIVE_STATS, true, 'round')} />,
    );
    expect(round).toContain('aria-disabled="true"');
    expect(round).toContain('aria-expanded="false"');
    expect(round).not.toContain('aria-controls');
    expect(round).toContain('title="Live stats after this round"');
    expect(round).toContain('aria-label="Live stats"');
    const auto = renderToStaticMarkup(
      <LiveStatsOpener live={control(NO_LIVE_STATS, false, 'auto-play')} />,
    );
    expect(auto).toContain('title="Live stats after auto-play"');
    expect(auto).toContain('aria-disabled="true"');
  });
});

describe('heldBy', () => {
  it('holds the panel back during play on an upright screen only', () => {
    expect(heldBy('round', true)).toBe('round');
    expect(heldBy('auto-play', true)).toBe('auto-play');
    expect(heldBy(null, true)).toBeNull();
    // Beside the game it has its own room.
    expect(heldBy('round', false)).toBeNull();
    expect(heldBy('auto-play', false)).toBeNull();
  });
});

describe('tapOpener', () => {
  it('opens and closes the card beside the game', () => {
    expect(tapOpener(false, false)).toEqual({ open: true, reveal: false });
    expect(tapOpener(true, false)).toEqual({ open: false, reveal: false });
  });

  it('on an upright screen always shows the panel and slides the sheet up to it', () => {
    // The panel sits at the bottom of the sheet, out of sight while the sheet
    // is down: a tap that closed it would seem to do nothing.
    expect(tapOpener(false, true)).toEqual({ open: true, reveal: true });
    expect(tapOpener(true, true)).toEqual({ open: true, reveal: true });
  });
});

describe('where the live stats sit on an upright screen', () => {
  const css = readFileSync(new URL('../src/stats/live-stats.css', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const upright = css.slice(css.indexOf('@media (orientation: portrait) {'));

  it('puts them at the end of the controls, after Manual | Auto, so Bet never moves', () => {
    const controls = app.slice(app.indexOf('<aside className="controls"'), app.indexOf('</aside>'));
    const inSheet = controls.indexOf('liveStats.shown && liveStats.upright && <LiveStats');
    expect(inSheet).toBeGreaterThan(controls.indexOf('Manual'));
    expect(inSheet).toBeGreaterThan(controls.indexOf('<BetPanel'));
    // Beside the game only when the screen is not upright, so never twice.
    expect(app).toContain('liveStats.shown && !liveStats.upright && <LiveStats');
  });

  it('styles them as part of the sheet, not as a strip above Bet', () => {
    expect(upright).toMatch(/\.controls > \.live-stats \{[^}]*height: 190px/);
    expect(upright).not.toContain('.layout > .live-stats');
    expect(upright).not.toMatch(/margin-top: auto/);
  });

  it('keeps a resting place just above them, so no band of a tall sheet is out of reach', () => {
    expect(upright).toMatch(/\.controls > :has\(\+ \.live-stats\) \{\s*scroll-snap-align: end;/);
  });

  it('turns snapping off while the chart button slides the sheet up', () => {
    expect(upright).toMatch(/html\[data-sheet-slide\] \{\s*scroll-snap-type: none;/);
  });

  it('lets the panel take focus on an upright screen only', () => {
    const phone = renderToStaticMarkup(<LiveStats live={{ ...control(NO_LIVE_STATS), upright: true }} />);
    expect(phone).toMatch(/<section[^>]*tabindex="-1"/);
    const computer = renderToStaticMarkup(<LiveStats live={control(NO_LIVE_STATS)} />);
    expect(computer).not.toMatch(/<section[^>]*tabindex/);
  });
});

describe('slideSheet', () => {
  it('aims at the sheet\'s own end, never above the top of the page', () => {
    // The sheet ends 300px below a 844px screen, the page at its top.
    expect(sheetUpTop(1144, 0, 844)).toBe(300);
    // Already partly up: the same place in page terms.
    expect(sheetUpTop(944, 200, 844)).toBe(300);
    expect(sheetUpTop(500, 0, 844)).toBe(0);
  });

  it('ends when it arrives, stops moving, or runs out of time', () => {
    expect(slideOver(300, 300, 0, 10)).toBe(true);
    expect(slideOver(299.5, 300, 0, 10)).toBe(true);
    expect(slideOver(150, 300, 0, 10)).toBe(false);
    expect(slideOver(150, 300, 6, 10)).toBe(true);
    expect(slideOver(150, 300, 0, SLIDE_MAX_MS)).toBe(true);
  });
});

describe('ProfitChart', () => {
  const profit = [
    { round: 1, netCents: -100 },
    { round: 2, netCents: 150 },
  ];

  it('keeps the stats page chart as it was: readout and round numbers', () => {
    const html = renderToStaticMarkup(<ProfitChart profit={profit} />);
    expect(html).toContain('class="profit-chart"');
    expect(html).toContain('profit-readout');
    expect(html).toContain('profit-x');
  });

  it('draws the compact chart without them until a point is picked', () => {
    const html = renderToStaticMarkup(<ProfitChart profit={profit} compact />);
    expect(html).toContain('class="profit-chart profit-chart-compact"');
    expect(html).not.toContain('profit-readout');
    expect(html).not.toContain('profit-x');
    expect(html).toContain('profit-line');
  });
});
