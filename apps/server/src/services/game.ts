import type {
  ActionResult,
  BalloonView,
  CashOutBody,
  PumpBody,
  PumpResult,
  RoundView,
  StartRoundRequest,
  VerifiableRound,
  WalletView,
} from '@pump/contract';
import {
  cashOut,
  EngineError,
  isRoundOver,
  pump,
  quoteBalloon,
  settleAbandoned,
  startRound,
  type PumpDraw,
} from '@pump/engine';
import { drawerFor } from '@pump/engine/fair';
import { assertInTransaction, immediate } from '../db/transaction';
import { ApiError } from '../errors';
import type { PlayersRepository } from '../repositories/players';
import type { RoundsRepository, StoredRound } from '../repositories/rounds';
import type { SeedsRepository } from '../repositories/seeds';
import type { Runtime } from '../runtime';
import { ABANDONED_AFTER_MS } from '../settings';
import type { WalletService } from './wallet';

/**
 * A stored round as the screen sees it. Every game number here (multiplier,
 * cash-out value, pop chance, Patch price) is asked of the engine; the server
 * works none of them out itself.
 */
export function toRoundView(stored: StoredRound): RoundView {
  return {
    id: stored.id,
    difficultyId: stored.round.difficultyId,
    rtpBp: stored.round.rtpBp,
    ladder: stored.round.ladder,
    status: stored.status,
    serverSeedHash: stored.serverSeedHash,
    clientSeed: stored.clientSeed,
    nonce: stored.nonce,
    balloons: stored.round.balloons.map((balloon, index): BalloonView => {
      const quote = quoteBalloon(stored.round, index);
      return {
        index,
        betCents: balloon.betCents,
        status: balloon.status,
        rung: balloon.rung,
        drawIndex: balloon.drawIndex,
        topRung: balloon.topRung,
        multiplierHundredths: quote.multiplierHundredths,
        cashOutCents: quote.cashOutCents,
        next: quote.next,
        patchesCents: balloon.patchesCents,
        payoutCents: balloon.payoutCents,
      };
    }),
    startedAt: stored.startedAt,
  };
}

export type GameService = ReturnType<typeof gameService>;

/**
 * Playing a round. The rules are the engine's: this service loads the round,
 * asks the engine what a request does, and then stores exactly what the engine
 * answered, with a ledger row for every cent that moved.
 *
 * Every method that changes something must be called inside one transaction
 * (the idempotency service opens it), so a request is applied whole or not at
 * all.
 */
export function gameService(
  runtime: Runtime,
  players: PlayersRepository,
  seeds: SeedsRepository,
  rounds: RoundsRepository,
  wallet: WalletService,
) {
  const walletOf = (playerId: string): WalletView => ({
    balanceCents: wallet.balanceOf(playerId),
  });

  /**
   * The round and wallet to send with a refusal. They are read when the
   * answer is built, after the refused request has been rolled back, so they
   * always show the state as it really is.
   */
  const stateNow = (playerId: string, roundId: string | null) => ({
    round: (): RoundView | null => {
      const stored = roundId === null ? null : rounds.find(roundId);
      return stored ? toRoundView(stored) : null;
    },
    wallet: (): WalletView => walletOf(playerId),
  });

  /** The player's own round, or "not found". Another player's round does not exist for them. */
  function load(playerId: string, roundId: string): StoredRound {
    const stored = rounds.find(roundId);
    if (stored?.playerId !== playerId) {
      throw new ApiError('not_found', 'There is no such round.');
    }
    return stored;
  }

  function reload(roundId: string): StoredRound {
    const stored = rounds.find(roundId);
    if (!stored) throw new Error('The round vanished during the request');
    return stored;
  }

  /**
   * Turns a refusal from the engine into the answer the player gets. A
   * conflict carries the round as it is now, so the screen can catch up.
   */
  function refusal(error: unknown, playerId: string, roundId: string | null): unknown {
    if (!(error instanceof EngineError)) return error;
    const now = stateNow(playerId, roundId);
    switch (error.code) {
      case 'conflict':
        return new ApiError('conflict', error.message, now);
      case 'insufficient_funds':
        return new ApiError('insufficient_funds', error.message, { wallet: now.wallet });
      case 'invalid_request':
        return new ApiError('invalid_request', error.message);
    }
  }

  /** A round that is over accepts nothing more. The answer shows how it ended. */
  function assertActive(stored: StoredRound, playerId: string): void {
    if (stored.status !== 'active') {
      throw new ApiError('conflict', 'This round is over.', stateNow(playerId, stored.id));
    }
  }

  /** Marks the round finished if every balloon is done; otherwise restarts its 24-hour clock. */
  function finishOrTouch(stored: StoredRound, over: boolean, at: string): void {
    if (over) rounds.finish(stored.id, at);
    else rounds.touch(stored.id, at);
  }

  /** Settles one idle round: cash out what was pumped, refund what was not. */
  function settle(roundId: string): void {
    assertInTransaction(runtime.db);
    const stored = rounds.find(roundId);
    if (stored?.status !== 'active') return;
    const at = runtime.now().toISOString();
    const result = settleAbandoned(stored.round);
    for (const settled of result.settled) {
      const before = stored.round.balloons[settled.balloonIndex];
      const after = result.round.balloons[settled.balloonIndex];
      if (!before || !after) throw new Error('The engine settled a balloon that does not exist');
      const ref = { roundId, balloonIndex: settled.balloonIndex };
      rounds.saveBalloon(roundId, settled.balloonIndex, before.drawIndex, after);
      if (settled.kind === 'cashed') {
        rounds.recordAction(
          roundId,
          {
            balloonIndex: settled.balloonIndex,
            action: { kind: 'cashOut' },
            outcome: 'abandoned',
            draw: null,
          },
          at,
        );
        wallet.credit(stored.playerId, 'payout', settled.cents, ref, at);
      } else {
        // A bet that never had a draw is void: handed back, not a result.
        wallet.credit(stored.playerId, 'refund', settled.cents, ref, at);
      }
    }
    rounds.finish(roundId, at);
  }

  function idleCutoff(): string {
    return new Date(runtime.now().getTime() - ABANDONED_AFTER_MS).toISOString();
  }

  return {
    /** The round in progress as the screen sees it, so a page refresh can restore it. */
    activeView(playerId: string): RoundView | null {
      const stored = rounds.activeOf(playerId);
      return stored ? toRoundView(stored) : null;
    },

    /**
     * Starts a round: takes the next nonce of the player's server seed, stores
     * the round with its own copy of the RTP and ladder, and charges each bet.
     */
    start(playerId: string, request: StartRoundRequest): ActionResult {
      assertInTransaction(runtime.db);
      const active = rounds.activeOf(playerId);
      if (active) {
        throw new ApiError(
          'round_active',
          'Finish the round in progress before starting another.',
          stateNow(playerId, active.id),
        );
      }
      const player = players.get(playerId);
      if (player.clientSeed === null) {
        throw new ApiError('invalid_request', 'Set a client seed before starting a round.');
      }

      let started;
      try {
        started = startRound(
          runtime.config,
          request.difficultyId,
          request.betsCents,
          player.balanceCents,
        );
      } catch (error) {
        throw refusal(error, playerId, null);
      }

      const id = runtime.newId();
      const at = runtime.now().toISOString();
      const seed = seeds.active(playerId);
      rounds.insert({
        id,
        playerId,
        serverSeedId: seed.id,
        clientSeed: player.clientSeed,
        nonce: seeds.takeNonce(seed.id),
        round: started.round,
        at,
      });
      started.round.balloons.forEach((balloon, balloonIndex) => {
        wallet.charge(playerId, 'bet', balloon.betCents, { roundId: id, balloonIndex }, at);
      });
      return { round: toRoundView(reload(id)), wallet: walletOf(playerId) };
    },

    /**
     * One pump, with or without a Patch, as one step.
     *
     * The engine checks the request first (the balloon is in the state the
     * player saw, a Patch is allowed and affordable) and only then asks for
     * the draw. So the draw is computed for a pump that will happen, and for
     * nothing else: a refused request never reads the server seed.
     */
    pump(playerId: string, roundId: string, body: PumpBody): PumpResult {
      assertInTransaction(runtime.db);
      const stored = load(playerId, roundId);
      assertActive(stored, playerId);

      const draw: PumpDraw = (den) => {
        const balloon = stored.round.balloons[body.balloonIndex];
        if (!balloon) throw new Error('The engine asked for a draw on a balloon that does not exist');
        return drawerFor({
          serverSeed: seeds.secretForDrawing(stored.serverSeedId),
          clientSeed: stored.clientSeed,
          nonce: stored.nonce,
          balloonIndex: body.balloonIndex,
          drawIndex: balloon.drawIndex,
        })(den);
      };

      let result;
      try {
        result = pump(
          stored.round,
          {
            balloonIndex: body.balloonIndex,
            expectedDrawIndex: body.expectedDrawIndex,
            patch: body.patch,
            balanceCents: wallet.balanceOf(playerId),
          },
          draw,
        );
      } catch (error) {
        throw refusal(error, playerId, roundId);
      }

      const at = runtime.now().toISOString();
      const ref = { roundId, balloonIndex: body.balloonIndex };
      const after = result.round.balloons[body.balloonIndex];
      if (!after) throw new Error('The engine returned a round without the pumped balloon');

      if (result.patchChargedCents !== null) {
        wallet.charge(playerId, 'patch', result.patchChargedCents, ref, at);
      }
      rounds.saveBalloon(roundId, body.balloonIndex, body.expectedDrawIndex, after);
      rounds.recordAction(
        roundId,
        {
          balloonIndex: body.balloonIndex,
          action: { kind: 'pump', patch: body.patch },
          outcome: result.outcome,
          draw: result.draw,
        },
        at,
      );
      if (result.payoutCents > 0) {
        wallet.credit(playerId, 'payout', result.payoutCents, ref, at);
      }
      finishOrTouch(stored, isRoundOver(result.round), at);

      return {
        round: toRoundView(reload(roundId)),
        wallet: walletOf(playerId),
        outcome: result.outcome,
      };
    },

    /** Cashes out one balloon. Conditional on the state the player saw, and paid once. */
    cashOut(playerId: string, roundId: string, body: CashOutBody): ActionResult {
      assertInTransaction(runtime.db);
      const stored = load(playerId, roundId);
      assertActive(stored, playerId);

      let result;
      try {
        result = cashOut(stored.round, body);
      } catch (error) {
        throw refusal(error, playerId, roundId);
      }

      const at = runtime.now().toISOString();
      const ref = { roundId, balloonIndex: body.balloonIndex };
      const after = result.round.balloons[body.balloonIndex];
      if (!after) throw new Error('The engine returned a round without the cashed balloon');

      rounds.saveBalloon(roundId, body.balloonIndex, body.expectedDrawIndex, after);
      rounds.recordAction(
        roundId,
        {
          balloonIndex: body.balloonIndex,
          action: { kind: 'cashOut' },
          outcome: 'cashed',
          draw: null,
        },
        at,
      );
      wallet.credit(playerId, 'payout', result.payoutCents, ref, at);
      finishOrTouch(stored, isRoundOver(result.round), at);

      return { round: toRoundView(reload(roundId)), wallet: walletOf(playerId) };
    },

    /**
     * Everything needed to play a finished round again in the browser. Only
     * once the round is over AND its server seed has been rotated out: before
     * that the seed is still deciding rounds and stays secret.
     */
    verifiable(playerId: string, roundId: string): VerifiableRound {
      const stored = load(playerId, roundId);
      const serverSeed =
        stored.status === 'finished' ? seeds.revealedSeed(stored.serverSeedId) : null;
      if (serverSeed === null || stored.finishedAt === null) {
        throw new ApiError(
          'seed_not_revealed',
          'A round can be checked once it is over and you have rotated your server seed.',
        );
      }
      const actions = rounds.actionsOf(roundId);
      return {
        id: stored.id,
        difficultyId: stored.round.difficultyId,
        rtpBp: stored.round.rtpBp,
        ladder: stored.round.ladder,
        serverSeed,
        serverSeedHash: stored.serverSeedHash,
        clientSeed: stored.clientSeed,
        nonce: stored.nonce,
        finishedAt: stored.finishedAt,
        balloons: stored.round.balloons.map((balloon, balloonIndex) => ({
          betCents: balloon.betCents,
          topRung: balloon.topRung,
          actions: actions
            .filter((entry) => entry.balloonIndex === balloonIndex)
            .map((entry) => entry.action),
          status: balloon.status,
          rung: balloon.rung,
          drawIndex: balloon.drawIndex,
          patchesCents: balloon.patchesCents,
          payoutCents: balloon.payoutCents,
        })),
      };
    },

    /**
     * The 24-hour rule, for one player. If their round has not been touched
     * for 24 hours it is settled now: pumped balloons cash out at their
     * multiplier, unpumped bets are refunded.
     *
     * This is a change of its own, in its own transaction, made BEFORE the
     * request that triggered it is looked at. It is never rolled back with
     * that request.
     */
    settleIfAbandoned(playerId: string): boolean {
      const stored = rounds.activeOf(playerId);
      if (!stored || stored.lastActionAt > idleCutoff()) return false;
      immediate(runtime.db, () => {
        settle(stored.id);
      });
      return true;
    },

    /** The same rule for everyone, run now and then, for players who never come back. */
    sweepAbandoned(): number {
      const idle = rounds.idleSince(idleCutoff());
      for (const roundId of idle) {
        immediate(runtime.db, () => {
          settle(roundId);
        });
      }
      return idle.length;
    },
  };
}
