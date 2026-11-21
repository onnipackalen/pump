/**
 * Where the profit line goes on the chart.
 *
 * Money stays integer cents. Only the drawing positions below are fractions,
 * and they decide nothing: they place a line on the screen.
 */

import type { ProfitPoint } from '../api/contract';

/** The chart's drawing box. The SVG stretches it to whatever size it is shown at. */
export const CHART_WIDTH = 1000;
export const CHART_HEIGHT = 300;

/** Room left above the highest point and below the lowest, so the line is not cut. */
const PAD = 18;

/** A point of the line with its place on the chart. */
export interface ChartPoint extends ProfitPoint {
  readonly x: number;
  readonly y: number;
}

export interface ProfitLine {
  /** The line, starting at round 0 with a net of $0.00 before the first round. */
  readonly points: readonly ChartPoint[];
  /** The height of the $0.00 line. */
  readonly zeroY: number;
  /** The highest and lowest net on the line, counting the $0.00 start. */
  readonly highCents: number;
  readonly lowCents: number;
}

/**
 * Lays out the running net after each round. The x axis is the round number
 * (rounds are evenly spaced, as the thinned line from the server still
 * carries each point's real round number). The y axis always includes $0.00,
 * so the player sees at a glance whether they are up or down.
 */
export function profitLine(profit: readonly ProfitPoint[]): ProfitLine {
  const all: readonly ProfitPoint[] = [{ round: 0, netCents: 0 }, ...profit];
  const lastRound = all[all.length - 1]?.round ?? 0;
  const nets = all.map((point) => point.netCents);
  const highCents = Math.max(...nets);
  const lowCents = Math.min(...nets);
  // A flat line at $0.00 still needs a scale; draw it in the middle.
  const span = highCents - lowCents;
  const yOf = (net: number): number =>
    span === 0 ? CHART_HEIGHT / 2 : PAD + ((highCents - net) / span) * (CHART_HEIGHT - 2 * PAD);
  const xOf = (round: number): number => (lastRound === 0 ? 0 : (round / lastRound) * CHART_WIDTH);
  return {
    points: all.map((point) => ({ ...point, x: xOf(point.round), y: yOf(point.netCents) })),
    zeroY: yOf(0),
    highCents,
    lowCents,
  };
}

/** The index of the point closest to `x` across the chart. */
export function nearestIndex(points: readonly ChartPoint[], x: number): number {
  let best = 0;
  for (let i = 1; i < points.length; i += 1) {
    const here = points[i];
    const kept = points[best];
    if (here && kept && Math.abs(here.x - x) < Math.abs(kept.x - x)) best = i;
  }
  return best;
}
