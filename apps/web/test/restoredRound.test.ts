/*
 * A round restored after a page load (found in the final review, 2026-11-22).
 *
 * The bet panel always opens on its default set-up. A restored round in play
 * may have another difficulty or number of balloons, and once it was over the
 * stage took the panel's set-up for a new one and hid how the round ended.
 * The header's session net also started from the balance after the round's
 * bets, so the round's payout counted as profit but its bets never did.
 */
import { GAME_CONFIG, type Difficulty } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import type { SessionView } from '../src/api/contract';
import { setupForRound, type BetSetup } from '../src/game/betSetup';
import { stageRound } from '../src/game/stage';
import { openedState } from '../src/game/useGame';
import { roundNetCents } from '../src/game/winTier';
import { balloon, round } from './fixtures';

const DIFFICULTIES = GAME_CONFIG.difficulties;
const FIRST = DIFFICULTIES[0] as Difficulty;
/** Any configured difficulty other than the first, or the first if there is only one. */
const OTHER = DIFFICULTIES[DIFFICULTIES.length - 1] ?? FIRST;
const DEFAULT_SETUP: BetSetup = { difficultyId: FIRST.id, bets: ['1.00'] };

describe('setupForRound: a restored round takes its set-up into the bet panel', () => {
  const restored = round(
    [
      balloon({ betCents: 100_000, rung: 1, drawIndex: 1 }),
      balloon({ betCents: 100 }),
      balloon({ betCents: 1234, rung: 2, drawIndex: 3 }),
    ],
    { difficultyId: OTHER.id },
  );

  it("takes the round's difficulty and each balloon's bet, as the bet inputs show them", () => {
    expect(setupForRound(restored, DEFAULT_SETUP, DIFFICULTIES)).toEqual({
      difficultyId: OTHER.id,
      bets: ['1000.00', '1.00', '12.34'],
    });
  });

  it('leaves a panel that already has the round difficulty and number of balloons alone', () => {
    const same = round([balloon({ betCents: 500 })], { difficultyId: FIRST.id });
    expect(setupForRound(same, DEFAULT_SETUP, DIFFICULTIES)).toBeNull();
    // Auto-play's raised bets: same difficulty and count, other amounts.
    const raised = round([balloon({ betCents: 150 })], { difficultyId: FIRST.id });
    expect(setupForRound(raised, DEFAULT_SETUP, DIFFICULTIES)).toBeNull();
  });

  it('leaves the panel alone for a difficulty the config no longer has', () => {
    const gone = round([balloon(), balloon()], { difficultyId: 'no-such-difficulty' });
    expect(setupForRound(gone, DEFAULT_SETUP, DIFFICULTIES)).toBeNull();
  });

  it('keeps the finished round on the stage once the panel has its set-up', () => {
    const finished = round(
      restored.balloons.map((b) => ({ ...b, status: 'cashed' as const, payoutCents: b.betCents })),
      { difficultyId: OTHER.id },
    );
    const synced = setupForRound(restored, DEFAULT_SETUP, DIFFICULTIES) ?? DEFAULT_SETUP;
    expect(stageRound(finished, synced.difficultyId, synced.bets.length)).toBe(finished);
  });
});

describe("openedState: a restored round counts in full in the session's net", () => {
  it('starts the session from the balance before the round, less what it already paid', () => {
    // $10 and $5 bets, a $2 Patch, and the first balloon already cashed for $12.
    const restored = round([
      balloon({ betCents: 1000, status: 'cashed', rung: 2, drawIndex: 3, patchesCents: 200, payoutCents: 1200 }),
      balloon({ betCents: 500, rung: 1, drawIndex: 1 }),
    ]);
    const balanceCents = 1_000_000 - 1000 - 500 - 200 + 1200;
    const session: SessionView = {
      wallet: { balanceCents },
      fairness: { serverSeedHash: 'a'.repeat(64), clientSeed: 'seed', nextNonce: 1 },
      activeRound: restored,
    };
    const opened = openedState(
      {
        phase: 'loading',
        wallet: null,
        fairness: null,
        round: null,
        history: [],
        revealed: [],
        beats: [],
        pending: [],
        patched: [],
        pressed: [],
        outcomes: [],
        held: [],
        winShownFor: null,
        endedElsewhere: null,
        starting: false,
        notice: null,
        session: null,
      },
      { session, fairness: session.fairness, history: [] },
      42,
    );
    expect(roundNetCents(restored)).toBe(-500);
    expect(opened.session).toEqual({ startedAt: 42, startBalanceCents: 1_000_000 });
  });
});
