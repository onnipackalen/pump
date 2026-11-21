/**
 * The verify payload goes straight into verifyRound.
 *
 * The server sends GET /api/rounds/:roundId/verify as a VerifiableRound
 * (@pump/contract), and the verify page hands it to verifyRound as it is.
 * So a VerifiableRound must be a RoundRecord. The assignments below stop
 * compiling (npm run typecheck) if the two drift apart, for example if the
 * payload loses the draws, the payout cap or a balloon's reveal.
 *
 * The test reaches @pump/contract through the workspace; it is a type check
 * only, so the engine itself still depends on nothing but @noble/hashes.
 */
import { describe, expect, it } from 'vitest';
import type {
  AfterRoundView,
  RevealOutcome as ContractRevealOutcome,
  VerifiableRound,
} from '@pump/contract';
import {
  cashOut,
  pump,
  revealAfterCashOut,
  startRound,
  type DrawRecord,
  type RevealOutcome,
} from '@pump/engine';
import { drawerFor, hashServerSeed, revealDrawerFor, verifyRound } from '@pump/engine/fair';
import { fixedConfig } from '../fixtures';

/** True only when A and B are the same type. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// The two ends of a reveal have one name for each outcome.
const outcomesMatch: Same<ContractRevealOutcome, RevealOutcome> = true;
const liveOutcomeMatches: Same<AfterRoundView['outcome'], RevealOutcome> = true;

const SERVER_SEED = '3f1c9a7e5b2d4c6a8e0f1b3d5c7a9e2f4b6d8c0a1e3f5b7d9c2a4e6f8b0d1c3a';
const CLIENT_SEED = 'payload_Test';

describe('the verify payload', () => {
  it('names the reveal outcomes the same way as the engine', () => {
    expect([outcomesMatch, liveOutcomeMatches]).toEqual([true, true]);
  });

  it('is a RoundRecord, and verifies as sent', () => {
    // One Easy balloon on the fixed ladder: two pumps, then cash out. The
    // nonce is the first from 0 whose two pumps both survive.
    const config = fixedConfig(9700);
    for (let nonce = 0; ; nonce += 1) {
      const seeds = { serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce };
      let round = startRound(config, 'easy', [100], 1_000_000).round;
      const draws: DrawRecord[] = [];
      for (const drawIndex of [0, 1]) {
        const result = pump(
          round,
          { balloonIndex: 0, expectedDrawIndex: drawIndex, patch: false, balanceCents: 0 },
          drawerFor({ ...seeds, balloonIndex: 0, drawIndex }),
        );
        round = result.round;
        draws.push(result.draw);
      }
      if (round.balloons[0]?.status !== 'active') continue;
      round = cashOut(round, { balloonIndex: 0, expectedDrawIndex: 2 }).round;
      const balloon = round.balloons[0];
      if (balloon === undefined) throw new Error('no balloon');
      const afterRound = revealAfterCashOut(
        round,
        0,
        revealDrawerFor({ ...seeds, balloonIndex: 0, drawIndex: balloon.drawIndex }),
      );

      // The payload a server would send, typed as the contract says.
      const payload: VerifiableRound = {
        id: 'round-1',
        difficultyId: round.difficultyId,
        rtpBp: round.rtpBp,
        ladder: round.ladder,
        maxPayoutCents: config.limits.maxPayoutCents,
        serverSeed: SERVER_SEED,
        serverSeedHash: hashServerSeed(SERVER_SEED),
        clientSeed: CLIENT_SEED,
        nonce,
        finishedAt: '2026-11-20T12:00:00.000Z',
        balloons: [
          {
            betCents: balloon.betCents,
            topRung: balloon.topRung,
            actions: [
              { kind: 'pump', patch: false },
              { kind: 'pump', patch: false },
              { kind: 'cashOut' },
            ],
            status: balloon.status,
            rung: balloon.rung,
            drawIndex: balloon.drawIndex,
            patchesCents: balloon.patchesCents,
            payoutCents: balloon.payoutCents,
            draws,
            afterRound,
          },
        ],
      };
      // Straight in, with no conversion.
      const check = verifyRound(payload);
      expect(check.problems).toEqual([]);
      expect(check.balloons[0]?.afterRound).toMatchObject({
        outcome: afterRound.outcome,
        reachedRung: afterRound.reachedRung,
      });
      return;
    }
  });
});
