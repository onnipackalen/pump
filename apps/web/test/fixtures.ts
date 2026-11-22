import { GAME_CONFIG, topRungForBet, type Difficulty, type GameConfig } from '@pump/engine';
import type { BalloonView, RoundView } from '../src/api/contract';

/*
 * Ladders for tests that need a ladder of some shape.
 *
 * The config can change: a difficulty added, the list reordered, a ladder
 * made longer or shorter. So a test does not take "the first difficulty"
 * and hope it is long enough. It asks for the shape it needs and gets the
 * first configured difficulty that has it, so it still runs on the real
 * ladders. Only when no configured ladder has that shape does it get one of
 * the ladders made below, so the check never quietly goes away.
 * madeLadders.test.ts checks that these pass the game's own start-up checks.
 */

/** 24 rungs, 1.01x to 25x. Even the largest bet climbs it all under the cap. */
export const MADE_LONG: Difficulty = {
  id: 'made-long',
  label: 'Made long',
  ladder: [
    101, 111, 123, 137, 153, 171, 192, 216, 244, 277, 316, 362, 416, 480, 555, 645, 752, 881,
    1040, 1230, 1460, 1740, 2080, 2500,
  ],
};

/** 5 rungs up to 15,000x. The cap stops the largest bet at rung 3; $1 climbs it all. */
export const MADE_CAPPED: Difficulty = {
  id: 'made-capped',
  label: 'Made capped',
  ladder: [150, 1000, 10_000, 120_000, 1_500_000],
};

/** Every ladder made here. */
export const MADE_DIFFICULTIES: readonly Difficulty[] = [MADE_LONG, MADE_CAPPED];

/** The first configured difficulty `wanted` is true for, or `made` if none is. */
export function difficultyWhere(
  wanted: (difficulty: Difficulty) => boolean,
  made: Difficulty = MADE_LONG,
): Difficulty {
  const found = GAME_CONFIG.difficulties.find(wanted);
  if (found) return found;
  if (!wanted(made)) throw new Error(`The made ladder ${made.id} does not have what the test needs`);
  return made;
}

/** True when a bet of `betCents` can climb the whole ladder under the payout cap. */
export function climbsAll(ladder: readonly number[], betCents: number): boolean {
  return topRungForBet(ladder, betCents, GAME_CONFIG.limits.maxPayoutCents) === ladder.length;
}

/** A difficulty with at least `rungs` rungs that a $1 bet can climb in full. */
export function difficultyWithRungs(rungs: number): Difficulty {
  return difficultyWhere((d) => d.ladder.length >= rungs && climbsAll(d.ladder, 100));
}

/** A difficulty whose top the payout cap keeps from the largest bet, but not from $1. */
export function cappedDifficulty(): Difficulty {
  return difficultyWhere(
    (d) => !climbsAll(d.ladder, GAME_CONFIG.limits.maxBetCents) && climbsAll(d.ladder, 100),
    MADE_CAPPED,
  );
}

/** The game config, with `difficulty` added at the end when it is not in it already. */
export function configWith(difficulty: Difficulty, config: GameConfig = GAME_CONFIG): GameConfig {
  if (config.difficulties.some((d) => d.id === difficulty.id)) return config;
  return { ...config, difficulties: [...config.difficulties, difficulty] };
}

/**
 * The difficulty the fixtures below play on: the first configured one with
 * 10 or more rungs that $1 can climb in full (Easy, as shipped), so a
 * balloon's default top of 10 is a real rung.
 */
export const BASE: Difficulty = difficultyWithRungs(10);

/** A balloon for tests. Defaults: active, $1 bet, rung 0, top rung 10 (a rung BASE has). */
export function balloon(overrides: Partial<BalloonView> = {}): BalloonView {
  return {
    index: 0,
    betCents: 100,
    status: 'active',
    rung: 0,
    drawIndex: 0,
    topRung: 10,
    multiplierHundredths: null,
    cashOutCents: null,
    next: null,
    patchesCents: 0,
    payoutCents: 0,
    afterRound: null,
    ...overrides,
  };
}

/** A round for tests holding the given balloons, on BASE unless told otherwise. */
export function round(balloons: readonly BalloonView[], overrides: Partial<RoundView> = {}): RoundView {
  return {
    id: 'round-1',
    difficultyId: BASE.id,
    // RTP and ladder come from config, so the tests follow an RTP change.
    rtpBp: GAME_CONFIG.rtpBp,
    ladder: BASE.ladder,
    status: balloons.some((b) => b.status === 'active') ? 'active' : 'finished',
    serverSeedHash: 'hash',
    clientSeed: 'seed',
    nonce: 0,
    balloons: balloons.map((b, index) => ({ ...b, index })),
    startedAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}
