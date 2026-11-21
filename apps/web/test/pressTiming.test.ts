import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAME_CONFIG, popChance } from '@pump/engine';
import type { BalloonView, RoundView, WalletView } from '../src/api/contract';
import { balloonBeat, cardScale, subText } from '../src/components/BalloonCard';
import { shownRound, shownWallet } from '../src/game/useGame';
import { HOLD_GAP_MS, holdStep, type HoldTarget } from '../src/game/useHoldPump';
import { balloonTension, PRESS_MS, pressMs, tensionFloor, type Tension } from '../src/game/risk';
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

const RTPS = [9400, 9700, 9900] as const;

describe('press length and strain: one number, from the balloon\'s own range', () => {
  it('is the length the art plays, at every strain level', () => {
    expect(PRESS_MS.map((_, strain) => cssPressMs(strain))).toEqual([...PRESS_MS]);
  });

  it('gives every pump of every ladder the press the art plays for its strain, at 94, 97 and 99% RTP', () => {
    for (const rtpBp of RTPS) {
      for (const { ladder } of GAME_CONFIG.difficulties) {
        // The full ladder, and a balloon whose bet the payout cap stops halfway.
        for (const topRung of [ladder.length, Math.ceil(ladder.length / 2)]) {
          const r = round([], { rtpBp, ladder });
          let last = 0;
          for (let rung = 0; rung < topRung; rung += 1) {
            const b = atRung(ladder, rtpBp, rung, topRung);
            const strain = balloonTension(r, b);
            if (strain === undefined) throw new Error('a balloon in play has a strain');
            // The game waits exactly as long as the art's press at that strain.
            expect(pressMs(r, b)).toBe(cssPressMs(strain));
            // Never calmer as the pop chance rises.
            expect(strain).toBeGreaterThanOrEqual(last);
            last = strain;
          }
        }
      }
    }
  });

  it('runs from the first pump\'s own floor up to most tense on the top pump, on every difficulty (Easy too)', () => {
    for (const rtpBp of RTPS) {
      for (const { ladder } of GAME_CONFIG.difficulties) {
        for (const topRung of [ladder.length, Math.ceil(ladder.length / 2)]) {
          const r = round([], { rtpBp, ladder });
          const first = atRung(ladder, rtpBp, 0, topRung);
          const top = atRung(ladder, rtpBp, topRung - 1, topRung);
          // The first pump is the bottom of its own range, so only the
          // absolute floor can lift it: calm below 25%, never calm at 40%+.
          const floor = tensionFloor(popChance(rtpBp, ladder, 1));
          expect(balloonTension(r, first)).toBe(floor);
          expect(pressMs(r, first)).toBe(PRESS_MS[floor]);
          expect(balloonTension(r, top)).toBe(3);
          expect(pressMs(r, top)).toBe(PRESS_MS[3]);
        }
      }
    }
  });

  it('never draws a pump calmer than its absolute floor, on any difficulty', () => {
    for (const rtpBp of RTPS) {
      for (const { ladder } of GAME_CONFIG.difficulties) {
        const r = round([], { rtpBp, ladder });
        for (let rung = 0; rung < ladder.length; rung += 1) {
          const b = atRung(ladder, rtpBp, rung);
          const floor = tensionFloor(popChance(rtpBp, ladder, rung + 1));
          expect(balloonTension(r, b)).toBeGreaterThanOrEqual(floor);
        }
      }
    }
  });

  it('is the shortest press, with no strain, for a balloon with no next pump', () => {
    const r = round([]);
    expect(balloonTension(r, balloon({ next: null }))).toBeUndefined();
    expect(pressMs(r, balloon({ next: null }))).toBe(PRESS_MS[0]);
    expect(pressMs(r, balloon({ status: 'popped' }))).toBe(PRESS_MS[0]);
  });
});

/** The text of one @keyframes block in balloon.css. */
function keyframes(name: string): string {
  const start = css.indexOf(`@keyframes ${name} {`);
  if (start < 0) throw new Error(`no @keyframes ${name}`);
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
}

/** One CSS rule's text, found by its exact selector. */
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule ${selector}`);
  return css.slice(start, css.indexOf('}', start) + 1);
}

/** The --pb-air-s values of a keyframes block, in order. */
function distances(block: string): number[] {
  return [...block.matchAll(/--pb-air-s: ([\d.]+);/g)].map((m) => Number(m[1]));
}

describe('the air pocket in balloon.css', () => {
  it('never reads the swell inside a keyframe, so an answer cannot resize the pocket', () => {
    // data-strain (and with it the swell) changes in the same frame as the
    // answer beat. A keyframe that read it would jump on that frame.
    for (const name of ['pb-air', 'pb-air-in']) {
      expect(keyframes(name)).not.toContain('--pb-air-swell');
    }
  });

  it('holds a change of swell back until the pocket has gone in', () => {
    const inMs = /--pb-air-in-ms: (\d+)ms/.exec(css);
    const dash = rule('.pump-balloon .pb-air path');
    expect(inMs).not.toBeNull();
    // The swell sets only the width of the dashes ...
    expect(dash).toMatch(/stroke-width: calc\([^;]*var\(--pb-air-swell\)[^;]*\);/);
    // ... and a change of width waits until the pocket has gone in.
    const extra = /transition: stroke-width 0s linear calc\(var\(--pb-air-in-ms\) \+ (\d+)ms\);/.exec(
      dash,
    );
    expect(extra).not.toBeNull();
    expect(Number(extra?.[1])).toBeGreaterThan(0);
  });

  it('stands still while it waits: no loop, so no flashing and nothing to snap', () => {
    // The user asked for a steady pocket while the answer is late
    // (2026-11-20). The rush runs once and holds its last frame.
    expect(css).not.toContain('@keyframes pb-air-wait');
    const press = rule('.pump-balloon[data-beat="press"] .pb-air');
    expect(press).toContain('animation: pb-air var(--pb-press-ms) linear forwards;');
    expect(press).not.toContain('infinite');
  });

  it('moves only along the hose, and only forwards', () => {
    // Only the distance along the hose and the opacity change, so the
    // pocket can never leave the hose, even at the bend.
    for (const name of ['pb-air', 'pb-air-in']) {
      const block = keyframes(name);
      for (const property of ['transform', 'translate', 'rotate', 'scale', 'stroke-width']) {
        expect(block).not.toContain(property);
      }
      const s = distances(block);
      expect(s.length).toBeGreaterThan(1);
      for (let i = 1; i < s.length; i += 1) expect(s[i]).toBeGreaterThanOrEqual(s[i - 1] ?? 0);
    }
  });

  it('starts the entry exactly where the rush ends', () => {
    const rush = distances(keyframes('pb-air'));
    const entry = distances(keyframes('pb-air-in'));
    expect(entry[0]).toBe(rush[rush.length - 1]);
    // The rush stops on the hose (79.2 long); the entry ends past its end.
    expect(rush[rush.length - 1]).toBeLessThan(79.2);
    expect(entry[entry.length - 1]).toBeGreaterThan(79.2);
  });
});

/**
 * A balloon at `rung` on a ladder, about to make pump rung + 1, as the server
 * would send it. Its top is the whole ladder unless `topRung` says lower.
 */
function atRung(
  ladder: readonly number[],
  rtpBp: number,
  rung: number,
  topRung = ladder.length,
): BalloonView {
  const multiplier = rung === 0 ? null : (ladder[rung - 1] ?? null);
  return balloon({
    rung,
    drawIndex: rung,
    topRung,
    multiplierHundredths: multiplier,
    cashOutCents: multiplier,
    next: {
      popChance: popChance(rtpBp, ladder, rung + 1),
      multiplierHundredths: ladder[rung] ?? 0,
      patchPriceCents: null,
    },
  });
}

/**
 * What BalloonCard reads from a balloon of round `r` while its beat is
 * "press". The size is the card's own rule (cardScale), so this cannot
 * drift from the card.
 */
function drawn(b: BalloonView | undefined, r: RoundView) {
  if (!b) throw new Error('no balloon');
  return {
    beat: balloonBeat(b, 'press', true),
    strain: balloonTension(r, b),
    pressMs: cssPressMs(balloonTension(r, b) ?? 0),
    scale: cardScale(b),
    status: b.status,
    sub: subText(b, 'press', false, null),
  };
}

describe('a balloon in its press, when another balloon\'s answer arrives first', () => {
  // Two balloons on one ladder: the first far enough up that its next pump
  // has a longer press than a first pump. Found from config, at each RTP.
  function mixedRound(rtpBp: number): { before: RoundView; longPress: number } {
    for (const { id, ladder } of GAME_CONFIG.difficulties) {
      const on = { rtpBp, ladder };
      for (let rung = 1; rung < ladder.length - 1; rung += 1) {
        const up = atRung(ladder, rtpBp, rung);
        if (pressMs(on, up) > pressMs(on, atRung(ladder, rtpBp, 0))) {
          const before = round([up, atRung(ladder, rtpBp, 0)], {
            difficultyId: id,
            rtpBp,
            ladder,
          });
          return { before, longPress: pressMs(on, up) };
        }
      }
    }
    throw new Error('no ladder has a pump with a longer press than its first pump');
  }

  for (const rtpBp of [9400, 9700, 9900]) {
    it(`keeps the pressed view through a pop, at RTP ${rtpBp}`, () => {
      const { before, longPress } = mixedRound(rtpBp);
      const [a, b] = before.balloons;
      if (!a || !b) throw new Error('fixture');
      // The second balloon's press is shorter, so its answer is applied first.
      expect(pressMs(before, b)).toBeLessThan(longPress);
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
      expect(drawn(shown?.balloons[0], before)).toEqual(drawn(a, before));
      expect(drawn(shown?.balloons[0], before).pressMs).toBe(longPress);
      expect(shown?.balloons[0]?.status).toBe('active');
      // The second balloon's own answer is shown at once.
      expect(shown?.balloons[1]).toBe(answer.balloons[1]);
      // Without the pressed view the result would be on screen already.
      expect(drawn(answer.balloons[0], before).sub).not.toBe(drawn(a, before).sub);
      expect(drawn(answer.balloons[0], before).strain).toBeUndefined();

      // Its own answer clears the pressed view: now the result shows.
      expect(shownRound(answer, [null, null])).toBe(answer);
    });

    it(`keeps the pressed view through a survive, at RTP ${rtpBp}`, () => {
      const { before } = mixedRound(rtpBp);
      const [a, b] = before.balloons;
      if (!a || !b) throw new Error('fixture');
      const grown = atRung(before.ladder, rtpBp, a.rung + 1);
      const answer = round([grown, { ...b, rung: 1, drawIndex: 1 }], {
        difficultyId: before.difficultyId,
        rtpBp,
        ladder: before.ladder,
      });
      const shown = shownRound(answer, [a, null]);
      expect(drawn(shown?.balloons[0], before)).toEqual(drawn(a, before));
      // Never bigger before its own answer.
      expect(drawn(answer.balloons[0], before).scale).toBeGreaterThan(drawn(a, before).scale);
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
  function playHold(
    balloons: readonly BalloonView[],
    on: Pick<RoundView, 'rtpBp' | 'ladder'>,
    hold: HoldTarget,
    steps: number,
  ): number[] {
    vi.useFakeTimers();
    const r = round(balloons, on);
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
        }, pressMs(r, r.balloons[index] ?? balloon()));
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

  /** A balloon on a configured ladder whose next pump is at this tension, at the configured RTP. */
  function atTension(tension: Tension): { b: BalloonView; on: Pick<RoundView, 'rtpBp' | 'ladder'> } {
    const rtpBp = GAME_CONFIG.rtpBp;
    for (const { ladder } of GAME_CONFIG.difficulties) {
      const on = { rtpBp, ladder };
      for (let rung = 0; rung < ladder.length; rung += 1) {
        const b = atRung(ladder, rtpBp, rung);
        if (balloonTension(on, b) === tension) return { b, on };
      }
    }
    throw new Error(`no pump at tension ${tension}`);
  }

  it('pumps one balloon every press + gap, at every strain level', () => {
    for (const tension of [0, 1, 2, 3] as const) {
      const { b, on } = atTension(tension);
      const cycle = PRESS_MS[tension] + HOLD_GAP_MS;
      const sentAt = playHold([b], on, { kind: 'one', roundId: 'round-1', index: 0 }, 4);
      expect(sentAt).toEqual([0, cycle, 2 * cycle, 3 * cycle]);
    }
  });

  it('on Pump all, waits for the longest press, so mixed balloons stay in step', () => {
    const ladder = GAME_CONFIG.difficulties[0]?.ladder ?? [];
    const rtpBp = GAME_CONFIG.rtpBp;
    const sentAt = playHold(
      [
        atRung(ladder, rtpBp, ladder.length - 1),
        atRung(ladder, rtpBp, 0),
        atRung(ladder, rtpBp, 0),
      ],
      { rtpBp, ladder },
      { kind: 'all', roundId: 'round-1' },
      3,
    );
    const cycle = PRESS_MS[3] + HOLD_GAP_MS;
    expect(sentAt).toEqual([0, cycle, 2 * cycle]);
  });
});
