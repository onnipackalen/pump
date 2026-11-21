import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAME_CONFIG, popChance } from '@pump/engine';
import type { BalloonView, Fraction, RoundView, WalletView } from '../src/api/contract';
import { balloonScale } from '../src/balloon/Balloon';
import { balloonBeat, balloonStrain, subText } from '../src/components/BalloonCard';
import { shownRound, shownWallet } from '../src/game/useGame';
import { HOLD_GAP_MS, holdStep, type HoldTarget } from '../src/game/useHoldPump';
import { PRESS_MS, pressMs, riskStep } from '../src/game/risk';
import { balloon, round } from './fixtures';

const css = readFileSync(new URL('../src/balloon/balloon.css', import.meta.url), 'utf8');

/** --pb-press-ms as balloon.css sets it for one strain level. */
function cssPressMs(strain: number): number {
  const rule =
    strain === 0
      ? /\.pump-balloon \{[^}]*?--pb-press-ms: (\d+)ms/
      : new RegExp(`\\.pump-balloon\\[data-strain="${strain}"\\] \\{[^}]*?--pb-press-ms: (\\d+)ms`);
  const found = rule.exec(css);
  if (!found) throw new Error(`no --pb-press-ms for strain ${strain}`);
  return Number(found[1]);
}

describe('pressMs', () => {
  it('follows the published pop chance in four steps', () => {
    expect(pressMs({ num: 1, den: 100 })).toBe(300);
    expect(pressMs({ num: 24, den: 100 })).toBe(300);
    expect(pressMs({ num: 25, den: 100 })).toBe(360);
    expect(pressMs({ num: 40, den: 100 })).toBe(420);
    expect(pressMs({ num: 60, den: 100 })).toBe(480);
    expect(pressMs({ num: 99, den: 100 })).toBe(480);
  });

  it('is the shortest press when no chance is published', () => {
    expect(pressMs(null)).toBe(PRESS_MS[0]);
    expect(pressMs(undefined)).toBe(PRESS_MS[0]);
  });

  it('never gets shorter as the pop chance rises', () => {
    let last = 0;
    for (let num = 0; num <= 100; num += 1) {
      const ms = pressMs({ num, den: 100 });
      expect(ms).toBeGreaterThanOrEqual(last);
      last = ms;
    }
  });

  it('is the length the art plays, at every strain level', () => {
    expect(PRESS_MS.map((_, strain) => cssPressMs(strain))).toEqual([...PRESS_MS]);
  });

  it('gives every pump of every ladder the strain the art has a press length for, at 94, 97 and 99% RTP', () => {
    for (const rtpBp of [9400, 9700, 9900]) {
      for (const { ladder } of GAME_CONFIG.difficulties) {
        for (let pump = 1; pump <= ladder.length; pump += 1) {
          const chance = popChance(rtpBp, ladder, pump);
          const next = { popChance: chance, multiplierHundredths: 0, patchPriceCents: null };
          const strain = balloonStrain(balloon({ next }));
          expect(strain).toBe(riskStep(chance) - 1);
          expect(pressMs(chance)).toBe(cssPressMs(strain ?? 0));
        }
      }
    }
  });
});

/** The text of one @keyframes block in balloon.css. */
function keyframes(name: string): string {
  const start = css.indexOf(`@keyframes ${name} {`);
  if (start < 0) throw new Error(`no @keyframes ${name}`);
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
}

describe('the air pocket in balloon.css', () => {
  it('never reads the swell inside a keyframe, so an answer cannot resize the pocket', () => {
    // data-strain (and with it the swell) changes in the same frame as the
    // answer beat. A keyframe that read it would jump on that frame.
    for (const name of ['pb-air', 'pb-air-wait', 'pb-air-in']) {
      expect(keyframes(name)).not.toContain('--pb-air-swell');
    }
  });

  it('holds a change of swell back until the pocket has gone in', () => {
    const inMs = /--pb-air-in-ms: (\d+)ms/.exec(css);
    const rule = /\.pump-balloon \.pb-air \{[^}]*\}/.exec(css);
    expect(inMs).not.toBeNull();
    expect(rule?.[0]).toContain('scale: var(--pb-air-swell);');
    const extra = /transition: scale 0s linear calc\(var\(--pb-air-in-ms\) \+ (\d+)ms\);/.exec(
      rule?.[0] ?? '',
    );
    expect(extra).not.toBeNull();
    expect(Number(extra?.[1])).toBeGreaterThan(0);
  });

  it('waits without moving or resizing the pocket, so a late answer cannot snap it', () => {
    const wait = keyframes('pb-air-wait');
    for (const property of ['transform', 'translate', 'rotate', 'scale', 'stroke-width', ' r:']) {
      expect(wait).not.toContain(property);
    }
  });

  it('starts the entry in the exact pose the rush ends in', () => {
    const pose = (block: string): string[] =>
      ['translate', 'rotate', 'transform'].map((property) => {
        const found = new RegExp(`${property}: ([^;]+);`).exec(block);
        if (!found?.[1]) throw new Error(`no ${property}`);
        // "100.0px" and "100px" are the same length.
        return found[1].replace(/(\d)\.0px/g, '$1px');
      });
    const rush = keyframes('pb-air');
    const rushEnd = rush.slice(rush.indexOf('100.0% {'));
    const entry = keyframes('pb-air-in');
    const entryStart = entry.slice(entry.indexOf('0% {'), entry.indexOf('70% {'));
    expect(pose(entryStart)).toEqual(pose(rushEnd));
  });
});

/** A balloon about to make pump number `pump` on a ladder, as the server would send it. */
function atRung(ladder: readonly number[], rtpBp: number, rung: number): BalloonView {
  const multiplier = rung === 0 ? null : (ladder[rung - 1] ?? null);
  return balloon({
    rung,
    drawIndex: rung,
    topRung: ladder.length,
    multiplierHundredths: multiplier,
    cashOutCents: multiplier,
    next: {
      popChance: popChance(rtpBp, ladder, rung + 1),
      multiplierHundredths: ladder[rung] ?? 0,
      patchPriceCents: null,
    },
  });
}

/** What BalloonCard reads from a balloon while its beat is "press". */
function drawn(b: BalloonView | undefined, top: number) {
  if (!b) throw new Error('no balloon');
  return {
    beat: balloonBeat(b, 'press', true),
    strain: balloonStrain(b),
    pressMs: cssPressMs(balloonStrain(b) ?? 0),
    scale: balloonScale(b.multiplierHundredths, top),
    status: b.status,
    sub: subText(b, 'press', false, null),
  };
}

describe('a balloon in its press, when another balloon\'s answer arrives first', () => {
  // Two balloons on one ladder: the first far enough up that its next pump
  // has a longer press than a first pump. Found from config, at each RTP.
  function mixedRound(rtpBp: number): { before: RoundView; chance: Fraction; top: number } {
    for (const { id, ladder } of GAME_CONFIG.difficulties) {
      for (let rung = 1; rung < ladder.length - 1; rung += 1) {
        const chance = popChance(rtpBp, ladder, rung + 1);
        if (pressMs(chance) > pressMs(popChance(rtpBp, ladder, 1))) {
          const before = round([atRung(ladder, rtpBp, rung), atRung(ladder, rtpBp, 0)], {
            difficultyId: id,
            rtpBp,
            ladder,
          });
          return { before, chance, top: ladder[ladder.length - 1] ?? 0 };
        }
      }
    }
    throw new Error('no ladder has a pump with a longer press than its first pump');
  }

  for (const rtpBp of [9400, 9700, 9900]) {
    it(`keeps the pressed view through a pop, at RTP ${rtpBp}`, () => {
      const { before, chance, top } = mixedRound(rtpBp);
      const [a, b] = before.balloons;
      if (!a || !b) throw new Error('fixture');
      // The second balloon's press is shorter, so its answer is applied first.
      expect(pressMs(b.next?.popChance)).toBeLessThan(pressMs(chance));
      // That answer holds the whole round: the first balloon has popped in it.
      const answer = round(
        [
          { ...a, status: 'popped', drawIndex: a.drawIndex + 1, next: null, cashOutCents: null },
          { ...b, rung: 1, drawIndex: 1, multiplierHundredths: before.ladder[0] ?? null },
        ],
        { difficultyId: before.difficultyId, rtpBp, ladder: before.ladder },
      );
      const pressed = [a, null];
      const shown = shownRound(answer, pressed);

      // The first balloon is drawn exactly as it was pressed, and the art's
      // press length is still the one the game is waiting on.
      expect(drawn(shown?.balloons[0], top)).toEqual(drawn(a, top));
      expect(drawn(shown?.balloons[0], top).pressMs).toBe(pressMs(chance));
      expect(shown?.balloons[0]?.status).toBe('active');
      // The second balloon's own answer is shown at once.
      expect(shown?.balloons[1]).toBe(answer.balloons[1]);
      // Without the pressed view the result would be on screen already.
      expect(drawn(answer.balloons[0], top).sub).not.toBe(drawn(a, top).sub);
      expect(drawn(answer.balloons[0], top).strain).toBeUndefined();

      // Its own answer clears the pressed view: now the result shows.
      expect(shownRound(answer, [null, null])).toBe(answer);
    });

    it(`keeps the pressed view through a survive, at RTP ${rtpBp}`, () => {
      const { before, top } = mixedRound(rtpBp);
      const [a, b] = before.balloons;
      if (!a || !b) throw new Error('fixture');
      const grown = atRung(before.ladder, rtpBp, a.rung + 1);
      const answer = round([grown, { ...b, rung: 1, drawIndex: 1 }], {
        difficultyId: before.difficultyId,
        rtpBp,
        ladder: before.ladder,
      });
      const shown = shownRound(answer, [a, null]);
      expect(drawn(shown?.balloons[0], top)).toEqual(drawn(a, top));
      // Never bigger before its own answer.
      expect(drawn(answer.balloons[0], top).scale).toBeGreaterThan(drawn(a, top).scale);
    });
  }

  it('keeps the round in play while a pressed balloon is held back', () => {
    const a = balloon({ rung: 3, drawIndex: 3 });
    const b = balloon({ rung: 2, drawIndex: 2 });
    // The second balloon cashed out; the answer shows the first one popped too.
    const answer = round([
      { ...a, status: 'popped', drawIndex: 4 },
      { ...b, status: 'cashed', payoutCents: 150 },
    ]);
    expect(answer.status).toBe('finished');
    expect(shownRound(answer, [a, null])?.status).toBe('active');
    expect(shownRound(answer, [null, null])?.status).toBe('finished');
  });

  it('gives back the same round when nothing is held back', () => {
    const a = balloon({ rung: 3, drawIndex: 3 });
    const r = round([a, balloon()]);
    expect(shownRound(r, [null, null])).toBe(r);
    // Pressed, but no answer has changed it yet.
    expect(shownRound(r, [r.balloons[0] ?? null, null])).toBe(r);
    expect(shownRound(null, [])).toBeNull();
  });

  it('holds back the payout of a top pump until its own answer is shown', () => {
    const a = balloon({ rung: 9, drawIndex: 9 });
    const answer = round([{ ...a, status: 'cashed', rung: 10, drawIndex: 10, payoutCents: 2500 }, balloon()]);
    const wallet: WalletView = { balanceCents: 100_000 };
    expect(shownWallet(wallet, answer, [a, null])).toEqual({ balanceCents: 97_500 });
    expect(shownWallet(wallet, answer, [null, null])).toBe(wallet);
    // A pop pays nothing, so the balance is the same either way.
    const popped = round([{ ...a, status: 'popped', drawIndex: 10 }, balloon()]);
    expect(shownWallet(wallet, popped, [a, null])).toBe(wallet);
  });
});

describe('a held pump', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Plays a hold the way useHoldPump and useGame do, on fake timers: holdStep
   * says which balloons to pump, each pump is busy (pending) for its press,
   * and the next step comes HOLD_GAP_MS after the last answer. The server is
   * instant and every pump survives. Returns when each step was sent.
   */
  function playHold(chances: readonly Fraction[], hold: HoldTarget, steps: number): number[] {
    vi.useFakeTimers();
    const next = (chance: Fraction) => ({
      popChance: chance,
      multiplierHundredths: 0,
      patchPriceCents: null,
    });
    const r = round(chances.map((chance) => balloon({ next: next(chance) })));
    const pending = r.balloons.map(() => false);
    const sentAt: number[] = [];
    const start = Date.now();

    const pumpAll = (indexes: readonly number[]): void => {
      sentAt.push(Date.now() - start);
      for (const index of indexes) {
        pending[index] = true;
        setTimeout(() => {
          pending[index] = false;
          afterAnswer();
        }, pressMs(r.balloons[index]?.next?.popChance));
      }
    };
    const afterAnswer = (): void => {
      const step = holdStep(r, pending, hold);
      if (!step || step.length === 0 || sentAt.length >= steps) return;
      setTimeout(() => pumpAll(step), HOLD_GAP_MS);
    };

    pumpAll(holdStep(r, pending, hold) ?? []);
    vi.runAllTimers();
    return sentAt;
  }

  it('pumps one balloon every press + gap, at every strain level', () => {
    const chances: Fraction[] = [
      { num: 10, den: 100 },
      { num: 30, den: 100 },
      { num: 50, den: 100 },
      { num: 70, den: 100 },
    ];
    chances.forEach((chance, strain) => {
      const cycle = (PRESS_MS[strain] ?? 0) + HOLD_GAP_MS;
      const sentAt = playHold([chance], { kind: 'one', roundId: 'round-1', index: 0 }, 4);
      expect(sentAt).toEqual([0, cycle, 2 * cycle, 3 * cycle]);
    });
  });

  it('on Pump all, waits for the longest press, so mixed balloons stay in step', () => {
    const sentAt = playHold(
      [
        { num: 70, den: 100 },
        { num: 10, den: 100 },
        { num: 10, den: 100 },
      ],
      { kind: 'all', roundId: 'round-1' },
      3,
    );
    const cycle = PRESS_MS[3] + HOLD_GAP_MS;
    expect(sentAt).toEqual([0, cycle, 2 * cycle]);
  });
});
