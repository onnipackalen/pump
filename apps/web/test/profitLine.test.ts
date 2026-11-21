import { describe, expect, it } from 'vitest';
import { CHART_HEIGHT, CHART_WIDTH, nearestIndex, profitLine } from '../src/stats/profitLine';

describe('profitLine', () => {
  it('starts at round 0 with $0.00 and spans the whole width', () => {
    const line = profitLine([
      { round: 1, netCents: -500 },
      { round: 2, netCents: 1500 },
    ]);
    expect(line.points.map((p) => [p.round, p.netCents])).toEqual([
      [0, 0],
      [1, -500],
      [2, 1500],
    ]);
    expect(line.points[0]?.x).toBe(0);
    expect(line.points.at(-1)?.x).toBe(CHART_WIDTH);
    expect(line.highCents).toBe(1500);
    expect(line.lowCents).toBe(-500);
  });

  it('puts higher nets higher up, with $0.00 between the high and the low', () => {
    const line = profitLine([
      { round: 1, netCents: -500 },
      { round: 2, netCents: 1500 },
    ]);
    const [start, down, up] = line.points;
    expect(up?.y).toBeLessThan(start?.y ?? 0);
    expect(down?.y).toBeGreaterThan(start?.y ?? 0);
    expect(line.zeroY).toBe(start?.y);
    for (const point of line.points) {
      expect(point.y).toBeGreaterThan(0);
      expect(point.y).toBeLessThan(CHART_HEIGHT);
    }
  });

  it('keeps $0.00 on the chart when the player has only lost', () => {
    const line = profitLine([
      { round: 1, netCents: -100 },
      { round: 2, netCents: -300 },
    ]);
    expect(line.highCents).toBe(0);
    expect(line.zeroY).toBeLessThan(line.points.at(-1)?.y ?? 0);
  });

  it('draws a line that never moved through the middle', () => {
    const line = profitLine([{ round: 1, netCents: 0 }]);
    expect(line.points.every((p) => p.y === CHART_HEIGHT / 2)).toBe(true);
  });

  it('spaces thinned points by their real round number', () => {
    const line = profitLine([
      { round: 10, netCents: 1 },
      { round: 1000, netCents: 2 },
    ]);
    expect(line.points[1]?.x).toBe(10);
  });
});

describe('nearestIndex', () => {
  it('finds the point closest across the chart', () => {
    const { points } = profitLine([
      { round: 1, netCents: 1 },
      { round: 2, netCents: 2 },
      { round: 3, netCents: 3 },
      { round: 4, netCents: 4 },
    ]);
    expect(nearestIndex(points, 0)).toBe(0);
    expect(nearestIndex(points, 260)).toBe(1);
    expect(nearestIndex(points, 640)).toBe(3);
    expect(nearestIndex(points, CHART_WIDTH + 50)).toBe(4);
  });
});
