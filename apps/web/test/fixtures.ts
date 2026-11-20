import { GAME_CONFIG } from '@pump/engine';
import type { BalloonView, RoundView } from '../src/api/contract';

/** A balloon for tests. Defaults: active, $1 bet, rung 0, top rung 10. */
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
    ...overrides,
  };
}

/** A round for tests holding the given balloons. */
export function round(balloons: readonly BalloonView[], overrides: Partial<RoundView> = {}): RoundView {
  return {
    id: 'round-1',
    difficultyId: GAME_CONFIG.difficulties[0]?.id ?? 'easy',
    // RTP and ladder come from config, so the tests follow an RTP change.
    rtpBp: GAME_CONFIG.rtpBp,
    ladder: GAME_CONFIG.difficulties[0]?.ladder ?? [],
    status: balloons.some((b) => b.status === 'active') ? 'active' : 'finished',
    serverSeedHash: 'hash',
    clientSeed: 'seed',
    nonce: 0,
    balloons: balloons.map((b, index) => ({ ...b, index })),
    startedAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}
