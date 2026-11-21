import { GAME_CONFIG } from '@pump/engine';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AutoPlayPanel } from '../src/components/AutoPlayPanel';
import { PreviewCard } from '../src/components/BalloonCard';
import { multiplierAt } from '../src/game/rules';
import { stepAnchor, stepTarget } from '../src/game/stepRow';
import { stepTargetPumps, targetPumpsOf } from '../src/game/targetSteps';
import { formatMultiplier } from '../src/money';

/** − and + beside auto-play's Target: one step along the ladder each. */
describe('stepTargetPumps', () => {
  it('moves one pump up or down, on every difficulty, from 1 to the top', () => {
    for (const { ladder } of GAME_CONFIG.difficulties) {
      const top = ladder.length;
      expect(stepTargetPumps('1', -1, top, top)).toBeNull();
      expect(stepTargetPumps('1', 1, top, top)).toBe('2');
      expect(stepTargetPumps('3', -1, top, top)).toBe('2');
      expect(stepTargetPumps(String(top), 1, top, top)).toBeNull();
      expect(stepTargetPumps(String(top), -1, top, top)).toBe(String(top - 1));
    }
  });

  it('goes no higher than the top the bets can reach, and comes back to it from above', () => {
    expect(stepTargetPumps('6', 1, 10, 7)).toBe('7');
    expect(stepTargetPumps('7', 1, 10, 7)).toBeNull();
    expect(stepTargetPumps('9', 1, 10, 7)).toBeNull();
    expect(stepTargetPumps('9', -1, 10, 7)).toBe('7');
    expect(stepTargetPumps('40', -1, 10, 10)).toBe('10');
  });

  it('turns text that is not a count yet into 1', () => {
    for (const text of ['', ' ', 'abc', '0', '2.5']) {
      expect(stepTargetPumps(text, 1, 10, 10)).toBe('1');
      expect(stepTargetPumps(text, -1, 10, 10)).toBe('1');
    }
  });
});

describe('the Target row', () => {
  it('has − and + beside the box, − greyed out only at 1 pump', () => {
    const difficulty = GAME_CONFIG.difficulties[0];
    if (!difficulty) throw new Error('no difficulty');
    const html = renderToStaticMarkup(
      createElement(AutoPlayPanel, {
        ladder: difficulty.ladder,
        topRung: difficulty.ladder.length,
        difficultyLabel: difficulty.label,
        roundBetCents: 100,
        betsValid: true,
        limits: GAME_CONFIG.limits,
        betSizing: true,
        roundActive: false,
        starting: false,
        status: {
          running: false,
          stopping: false,
          settings: null,
          progress: { roundsPlayed: 0, netCents: 0 },
          bets: null,
          handCashOuts: null,
          stopReason: null,
        },
        round: null,
        onStart: () => undefined,
        onStop: () => undefined,
        onCashOut: () => undefined,
      }),
    );
    const row = /<div class="target-row">(.*?)<\/div>/.exec(html)?.[1] ?? '';
    expect(row).toContain('<span class="field-label">Target</span>');
    // The form starts at 3 pumps: both buttons work.
    expect(row).toMatch(/<button[^>]*aria-label="One pump fewer"(?![^>]*disabled)[^>]*>−<\/button>/);
    expect(row).toMatch(/<button[^>]*aria-label="One pump more"(?![^>]*disabled)[^>]*>\+<\/button>/);
  });
});

describe('the target on the stage', () => {
  const ladder = GAME_CONFIG.difficulties[0]?.ladder ?? [];
  const preview = (target: number | null, topRung = ladder.length) =>
    ({ ladder, rung: 0, topRung, status: 'preview', target }) as const;

  it('reads the typed target the way the form does', () => {
    expect(targetPumpsOf('5', ladder.length)).toBe(5);
    expect(targetPumpsOf(' 5 ', ladder.length)).toBe(5);
    for (const text of ['', '0', '2.5', 'x', String(ladder.length + 1)]) {
      expect(targetPumpsOf(text, ladder.length)).toBeNull();
    }
  });

  it('marks the target step, or the top when the bet tops out lower', () => {
    expect(stepTarget(preview(5))).toBe(5);
    expect(stepTarget(preview(5, 3))).toBe(3);
    expect(stepTarget(preview(null))).toBeNull();
    // A balloon that cannot be pumped any more has no target.
    expect(stepTarget({ ...preview(5), status: 'cashed', rung: 2 })).toBeNull();
  });

  it('slides the row before the round so the target sits where the next step does', () => {
    expect(stepAnchor(preview(null))).toBe(0);
    for (let target = 1; target <= ladder.length; target += 1) {
      expect(stepAnchor(preview(target))).toBe(target - 1);
    }
    // During a round the row follows the balloon, not the target.
    expect(stepAnchor({ ladder, rung: 2, topRung: ladder.length, status: 'active', target: 9 })).toBe(2);
  });

  it('draws the ring on the target step of a set-up card', () => {
    const html = renderToStaticMarkup(
      createElement(PreviewCard, {
        slot: 1,
        difficultyId: GAME_CONFIG.difficulties[0]?.id ?? 'easy',
        betCents: 100,
        ladder,
        maxPayoutCents: GAME_CONFIG.limits.maxPayoutCents,
        target: 4,
      }),
    );
    const ringed = [...html.matchAll(/<li class="step"[^>]*data-target="true"[^>]*>([^<]*)<\/li>/g)];
    expect(ringed.map((m) => m[1])).toEqual([formatMultiplier(multiplierAt(ladder, 4))]);
  });
});
