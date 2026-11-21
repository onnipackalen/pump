import {
  DIFFICULTIES,
  GAME_CONFIG,
  ladderProblems,
  revealAfterCashOut,
  topRungForBet,
  type Round,
} from '@pump/engine';
import { revealDrawerFor, verifyRound } from '@pump/engine/fair';
import { describe, expect, it } from 'vitest';
import type {
  AfterRoundView,
  BalloonView,
  RoundView,
  VerifiableBalloon,
  VerifiableRound,
} from '../src/api/contract';
import { DemoClient } from '../src/demo/DemoClient';
import {
  MAX_ROUNDS,
  screenAgrees,
  shownRevealStore,
  topAgrees,
  type KeyValueStore,
} from '../src/verify/shownReveals';
import { balloon, round } from './fixtures';

const RTPS = [...new Set([9400, 9700, 9900, GAME_CONFIG.rtpBp])];

const key = (): string => crypto.randomUUID();

/** A localStorage stand-in. */
function memoryStore(): KeyValueStore & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => {
      items.set(k, v);
    },
  };
}

/** A localStorage that refuses everything, like a blocked one. */
const blockedStore: KeyValueStore = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

const popped = (reachedRung: number): AfterRoundView => ({
  outcome: 'popped',
  reachedRung,
  reachedMultiplierHundredths: 150,
});

/** Cashed out on rung 2 of 10 with the given reveal. */
const cashed = (afterRound: AfterRoundView | null): BalloonView =>
  balloon({ status: 'cashed', rung: 2, drawIndex: 2, topRung: 10, afterRound });

describe('the reveal lines this device showed', () => {
  it('keeps each line of a finished round, by round and balloon', () => {
    const shown = shownRevealStore(memoryStore());
    shown.remember(
      round([
        cashed(popped(4)),
        balloon({ status: 'popped', rung: 1, drawIndex: 2 }),
        cashed({ outcome: 'top', reachedRung: 10, reachedMultiplierHundredths: 2500 }),
      ]),
    );
    expect(shown.shownOf('round-1', 0)).toEqual({ outcome: 'popped', reachedRung: 4 });
    expect(shown.shownOf('round-1', 1)).toBeNull();
    expect(shown.shownOf('round-1', 2)).toEqual({ outcome: 'top', reachedRung: 10 });
    expect(shown.shownOf('round-2', 0)).toBeNull();
  });

  it('keeps nothing from a round in progress, nor a reveal on a balloon that shows no line', () => {
    const shown = shownRevealStore(memoryStore());
    const inPlay = round([cashed(popped(4)), balloon({ status: 'active', rung: 1, drawIndex: 1 })]);
    shown.remember(inPlay);
    expect(shown.shownOf('round-1', 0)).toBeNull();
    // A stray reveal on a popped balloon is never on screen, so it is not kept.
    shown.remember(round([balloon({ status: 'popped', rung: 1, drawIndex: 2, afterRound: popped(1) })]));
    expect(shown.shownOf('round-1', 0)).toBeNull();
  });

  it('keeps the first line shown for a balloon, even if a later answer says another', () => {
    const shown = shownRevealStore(memoryStore());
    shown.remember(round([cashed(popped(4))]));
    shown.remember(round([cashed(popped(7))]));
    expect(shown.shownOf('round-1', 0)).toEqual({ outcome: 'popped', reachedRung: 4 });
  });

  it('is still there on the next visit, read back from storage', () => {
    const storage = memoryStore();
    shownRevealStore(storage).remember(round([cashed(popped(4))]));
    expect(shownRevealStore(storage).shownOf('round-1', 0)).toEqual({
      outcome: 'popped',
      reachedRung: 4,
    });
  });

  it('works for this visit when storage is blocked, and never throws', () => {
    const shown = shownRevealStore(blockedStore);
    expect(() => shown.remember(round([cashed(popped(4))]))).not.toThrow();
    expect(shown.shownOf('round-1', 0)).toEqual({ outcome: 'popped', reachedRung: 4 });
    expect(shownRevealStore(null).shownOf('round-1', 0)).toBeNull();
  });

  it('skips stored text it does not recognise', () => {
    for (const text of ['not json', '{}', '[["r", "x"]]', '[[1, []]]', '[["r", [[0, "won", 3]]]]']) {
      const storage = memoryStore();
      storage.items.set('pump.shownReveals', text);
      expect(shownRevealStore(storage).shownOf('r', 0)).toBeNull();
    }
    const storage = memoryStore();
    storage.items.set('pump.shownReveals', '[["r", [[0, "won", 3], [1, "top", 5]]]]');
    const shown = shownRevealStore(storage);
    expect(shown.shownOf('r', 0)).toBeNull();
    expect(shown.shownOf('r', 1)).toEqual({ outcome: 'top', reachedRung: 5 });
  });

  it(`keeps only the latest ${String(MAX_ROUNDS)} rounds`, () => {
    const storage = memoryStore();
    const shown = shownRevealStore(storage);
    for (let n = 0; n <= MAX_ROUNDS; n += 1) {
      shown.remember(round([cashed(popped(4))], { id: `r${String(n)}` }));
    }
    expect(shown.shownOf('r0', 0)).toBeNull();
    expect(shown.shownOf('r1', 0)).not.toBeNull();
    expect(shown.shownOf(`r${String(MAX_ROUNDS)}`, 0)).not.toBeNull();
    const reread = shownRevealStore(storage);
    expect(reread.shownOf('r0', 0)).toBeNull();
    expect(reread.shownOf('r1', 0)).not.toBeNull();
  });
});

describe('the top rung this device showed', () => {
  it('keeps each balloon’s top as the round was first seen, whatever later answers say', () => {
    const storage = memoryStore();
    const shown = shownRevealStore(storage);
    shown.rememberTops(round([balloon({ topRung: 7 }), balloon({ index: 1, topRung: 4 })]));
    shown.rememberTops(round([balloon({ topRung: 2 }), balloon({ index: 1, topRung: 2 })]));
    expect(shown.topOf('round-1', 0)).toBe(7);
    expect(shown.topOf('round-1', 1)).toBe(4);
    expect(shown.topOf('round-1', 2)).toBeNull();
    expect(shown.topOf('round-2', 0)).toBeNull();
    // Read back on the next visit, next to the lines.
    shown.remember(round([cashed(popped(4))]));
    const reread = shownRevealStore(storage);
    expect(reread.topOf('round-1', 0)).toBe(7);
    expect(reread.shownOf('round-1', 0)).toEqual({ outcome: 'popped', reachedRung: 4 });
  });

  it('still reads lines kept before tops were kept, with no top for them', () => {
    const storage = memoryStore();
    storage.items.set('pump.shownReveals', '[["r", [[0, "popped", 4]]]]');
    const shown = shownRevealStore(storage);
    expect(shown.shownOf('r', 0)).toEqual({ outcome: 'popped', reachedRung: 4 });
    expect(shown.topOf('r', 0)).toBeNull();
    shown.rememberTops(round([cashed(popped(4))], { id: 'r' }));
    expect(shownRevealStore(storage).topOf('r', 0)).toBe(10);
    expect(shownRevealStore(storage).shownOf('r', 0)).toEqual({ outcome: 'popped', reachedRung: 4 });
  });

  it('agrees only with the same top, and says nothing when there is no replayed balloon', () => {
    expect(topAgrees(7, 7)).toBe(true);
    expect(topAgrees(7, 2)).toBe(false);
    expect(topAgrees(7, null)).toBe(true);
  });

  it.each(RTPS)(
    'catches a record whose lower cap carries a shorter reveal that checks out, at RTP %i',
    async (rtpBp) => {
      const config = { ...GAME_CONFIG, rtpBp };
      const betCents = config.limits.maxBetCents;
      // A cap low enough to put the top at rung 2, yet one the record's own
      // checks accept, on a difficulty whose real top is higher.
      const lieCapOf = (ladder: readonly number[]): number =>
        Math.floor((betCents * (ladder[1] ?? 0)) / 100);
      const difficulty = config.difficulties.find(
        (d) =>
          topRungForBet(d.ladder, betCents, config.limits.maxPayoutCents) > 2 &&
          topRungForBet(d.ladder, betCents, lieCapOf(d.ladder)) === 2 &&
          ladderProblems(rtpBp, d.ladder, { ...config.limits, maxPayoutCents: lieCapOf(d.ladder) })
            .length === 0,
      );
      expect(difficulty).toBeDefined();
      if (!difficulty) return;

      const client = new DemoClient(config, 0);
      await client.setClientSeed('cap-lie', key());
      const shown = shownRevealStore(memoryStore());
      // Play until a balloon survives its first pump, then cash it out on
      // rung 1: it has a reveal, which stops at its top.
      let finished: RoundView | null = null;
      while (finished === null) {
        const started = (
          await client.startRound({ difficultyId: difficulty.id, betsCents: [betCents] }, key())
        ).round;
        shown.rememberTops(started);
        const pumped = (
          await client.pump(started.id, { balloonIndex: 0, expectedDrawIndex: 0, patch: false }, key())
        ).round;
        if (pumped.status !== 'active') continue;
        finished = (
          await client.cashOut(pumped.id, { balloonIndex: 0, expectedDrawIndex: 1 }, key())
        ).round;
      }
      shown.remember(finished);
      await client.rotateSeed(key());
      const record = await client.getVerifiableRound(finished.id);
      const stored = record.balloons[0];
      expect(stored?.afterRound).not.toBeNull();
      if (!stored) return;

      // The honest record checks out, and its top is the one shown.
      const honest = verifyRound(record);
      expect(honest.ok).toBe(true);
      const shownTop = shown.topOf(record.id, 0);
      expect(shownTop).toBe(stored.topRung);
      expect(topAgrees(shownTop ?? 0, honest.balloons[0]?.balloon?.topRung ?? null)).toBe(true);

      // The lie: a lower cap, the top it gives, and the reveal worked out
      // honestly against that top.
      const maxPayoutCents = lieCapOf(difficulty.ladder);
      const cashedAt: Round = {
        difficultyId: record.difficultyId,
        rtpBp: record.rtpBp,
        ladder: record.ladder,
        balloons: [
          {
            betCents: stored.betCents,
            status: 'cashed',
            rung: stored.rung,
            drawIndex: stored.drawIndex,
            topRung: 2,
            patchesCents: stored.patchesCents,
            payoutCents: stored.payoutCents,
          },
        ],
      };
      const reveal = revealAfterCashOut(
        cashedAt,
        0,
        revealDrawerFor({
          serverSeed: record.serverSeed,
          clientSeed: record.clientSeed,
          nonce: record.nonce,
          balloonIndex: 0,
          drawIndex: stored.drawIndex,
        }),
      );
      const liedBalloon: VerifiableBalloon = { ...stored, topRung: 2, afterRound: reveal };
      const lied: VerifiableRound = { ...record, maxPayoutCents, balloons: [liedBalloon] };

      // The record checks out against itself, so only this device can tell.
      const check = verifyRound(lied);
      expect(check.problems).toEqual([]);
      expect(check.balloons[0]?.balloon?.topRung).toBe(2);
      expect(topAgrees(shownTop ?? 0, check.balloons[0]?.balloon?.topRung ?? null)).toBe(false);
    },
  );
});

describe('the screen against the seeds', () => {
  const recomputed = { outcome: 'popped', reachedRung: 4 } as const;

  it('agrees on the same ending on the same rung', () => {
    expect(screenAgrees({ outcome: 'popped', reachedRung: 4 }, recomputed)).toBe(true);
  });

  it('disagrees on another rung, another ending, or a line where no reveal is due', () => {
    expect(screenAgrees({ outcome: 'popped', reachedRung: 3 }, recomputed)).toBe(false);
    expect(screenAgrees({ outcome: 'top', reachedRung: 4 }, recomputed)).toBe(false);
    expect(screenAgrees({ outcome: 'popped', reachedRung: 4 }, null)).toBe(false);
  });

  it.each(RTPS)('agrees with every reveal a demo round showed, at RTP %i', async (rtpBp) => {
    const client = new DemoClient({ ...GAME_CONFIG, rtpBp }, 0);
    await client.setClientSeed('shown-reveals', key());
    const shown = shownRevealStore(memoryStore());
    const finished: RoundView[] = [];
    for (let n = 0; n < 12; n += 1) {
      const difficultyId = DIFFICULTIES[n % DIFFICULTIES.length]?.id ?? 'easy';
      let now = (await client.startRound({ difficultyId, betsCents: [100, 1000] }, key())).round;
      for (const b of now.balloons) {
        // Pump once, then cash out if it survived: a reveal is due then.
        now = (
          await client.pump(now.id, { balloonIndex: b.index, expectedDrawIndex: 0, patch: false }, key())
        ).round;
        const after = now.balloons[b.index];
        if (now.status === 'active' && after?.status === 'active') {
          now = (
            await client.cashOut(now.id, { balloonIndex: b.index, expectedDrawIndex: after.drawIndex }, key())
          ).round;
        }
      }
      expect(now.status).toBe('finished');
      shown.remember(now);
      finished.push(now);
    }
    await client.rotateSeed(key());

    let checked = 0;
    for (const view of finished) {
      const result = verifyRound(await client.getVerifiableRound(view.id));
      for (const check of result.balloons) {
        const line = shown.shownOf(view.id, check.balloonIndex);
        if (line === null) continue;
        checked += 1;
        expect(screenAgrees(line, check.afterRound)).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
