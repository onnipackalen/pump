/**
 * DEMO STAND-IN. Delete it once the server exists.
 *
 * Plays the game inside the browser so the screen can be built and clicked
 * before the API is written. It is not the real game:
 * - its draws come from crypto.getRandomValues, not from the seeds, so it
 *   is not provably fair (the chances, payouts and Patch prices do come from
 *   the engine's math in @pump/engine);
 * - nothing is saved: a page refresh starts over.
 * The brief says a browser-only game does not count, so the screen shows a
 * "Demo" badge whenever this client is in use.
 *
 * It does copy the server's promises the screen relies on: one active
 * round, idempotency keys, expected draw index checks, and seeds that stay
 * fixed during a round.
 */

import {
  cashOutCents,
  GAME_CONFIG,
  multiplierAt,
  patchPriceCents,
  popChance,
  pumpSurvives,
  surviveChance,
  topRungForBet,
  type Difficulty,
  type GameConfig,
} from '@pump/engine';
import { ApiFailure, type GameClient } from '../api/client';
import { CLIENT_SEED_PATTERN } from '../game/clientSeed';
import type {
  ActionResult,
  ApiErrorBody,
  BalloonStatus,
  BalloonView,
  CashOutBody,
  FairnessView,
  PumpBody,
  PumpOutcome,
  PumpResult,
  RotateResult,
  RoundSummary,
  RoundView,
  SessionView,
  StartRoundRequest,
} from '../api/contract';

const STARTING_BALANCE_CENTS = 1_000_000;

interface DemoBalloon {
  readonly betCents: number;
  readonly topRung: number;
  status: BalloonStatus;
  rung: number;
  drawIndex: number;
  patchesCents: number;
  payoutCents: number;
}

interface DemoRound {
  readonly id: string;
  readonly difficulty: Difficulty;
  /** This round's own copy of the RTP, as the real server keeps one. */
  readonly rtpBp: number;
  readonly serverSeedHash: string;
  readonly clientSeed: string;
  readonly nonce: number;
  readonly startedAt: string;
  readonly balloons: DemoBalloon[];
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/** A uniform whole number in [0, den), by rejection sampling. */
function uniformInt(den: number): number {
  const limit = 2 ** 32 - (2 ** 32 % den);
  const word = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(word);
    const value = word[0] ?? 0;
    if (value < limit) return value % den;
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(body: ApiErrorBody): never {
  throw new ApiFailure(body);
}

export class DemoClient implements GameClient {
  readonly isDemo = true;

  private balanceCents = STARTING_BALANCE_CENTS;
  private serverSeed = randomHex(32);
  private serverSeedHash: Promise<string>;
  /** Null until the browser sends the first one. */
  private clientSeed: string | null = null;
  private nonce = 0;
  private round: DemoRound | null = null;
  private history: RoundSummary[] = [];
  private readonly answered = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: GameConfig = GAME_CONFIG,
    private readonly latencyMs = 120,
  ) {
    this.serverSeedHash = sha256Hex(this.serverSeed);
  }

  async getSession(): Promise<SessionView> {
    await sleep(this.latencyMs);
    return {
      wallet: this.wallet(),
      fairness: await this.fairness(),
      activeRound: this.round ? this.roundView(this.round) : null,
    };
  }

  async getHistory(limit: number): Promise<readonly RoundSummary[]> {
    await sleep(this.latencyMs);
    return this.history.slice(0, limit);
  }

  startRound(request: StartRoundRequest, key: string): Promise<ActionResult> {
    return this.once(key, async () => {
      await sleep(this.latencyMs);
      // Every await comes before the checks, so checking, charging and
      // creating the round happen in one go, like the server's transaction.
      const seedBefore = this.serverSeed;
      const serverSeedHash = await this.serverSeedHash;
      this.assertSeedUnchanged(seedBefore);
      if (this.round) fail({ code: 'round_active', message: 'Finish the current round first.' });
      const clientSeed = this.clientSeed;
      if (clientSeed === null) {
        fail({ code: 'invalid_request', message: 'Set a client seed first.' });
      }

      const difficulty = this.config.difficulties.find((d) => d.id === request.difficultyId);
      if (!difficulty) fail({ code: 'invalid_request', message: 'Unknown difficulty.' });

      const { limits } = this.config;
      const bets = request.betsCents;
      if (bets.length < 1 || bets.length > limits.maxBalloons) {
        fail({ code: 'invalid_request', message: `Bet on 1 to ${limits.maxBalloons} balloons.` });
      }
      for (const bet of bets) {
        if (!Number.isSafeInteger(bet) || bet < limits.minBetCents || bet > limits.maxBetCents) {
          fail({ code: 'invalid_request', message: 'A bet is outside the limits.' });
        }
      }
      const total = bets.reduce((sum, bet) => sum + bet, 0);
      if (total > this.balanceCents) {
        fail({ code: 'insufficient_funds', message: 'Not enough balance for these bets.' });
      }

      this.balanceCents -= total;
      this.round = {
        id: crypto.randomUUID(),
        difficulty,
        rtpBp: this.config.rtpBp,
        serverSeedHash,
        clientSeed,
        nonce: this.nonce,
        startedAt: new Date().toISOString(),
        balloons: bets.map((betCents) => ({
          betCents,
          topRung: topRungForBet(difficulty.ladder, betCents, limits.maxPayoutCents),
          status: 'active',
          rung: 0,
          drawIndex: 0,
          patchesCents: 0,
          payoutCents: 0,
        })),
      };
      this.nonce += 1;
      return { round: this.roundView(this.round), wallet: this.wallet() };
    });
  }

  pump(roundId: string, body: PumpBody, key: string): Promise<PumpResult> {
    return this.once(key, async () => {
      await sleep(this.latencyMs);
      const { round, balloon } = this.expect(roundId, body.balloonIndex, body.expectedDrawIndex);
      const ladder = round.difficulty.ladder;
      const pump = balloon.rung + 1;

      if (body.patch) {
        if (balloon.rung === 0) {
          fail({ code: 'invalid_request', message: 'No Patch before the first pump.' });
        }
        const price = patchPriceCents(round.rtpBp, ladder, balloon.betCents, pump);
        if (price > this.balanceCents) {
          fail({ code: 'insufficient_funds', message: 'Not enough balance for the Patch.' });
        }
        this.balanceCents -= price;
        balloon.patchesCents += price;
      }

      const survive = surviveChance(round.rtpBp, ladder, pump);
      const survived = pumpSurvives(survive, uniformInt(survive.den));
      balloon.drawIndex += 1;

      let outcome: PumpOutcome;
      if (survived) {
        balloon.rung = pump;
        if (pump === balloon.topRung) {
          this.payOut(round, balloon);
          outcome = 'top';
        } else {
          outcome = 'survived';
        }
      } else if (body.patch) {
        outcome = 'saved';
      } else {
        balloon.status = 'popped';
        outcome = 'popped';
      }

      const view = this.roundView(round);
      this.finishIfOver(round);
      return { outcome, round: view, wallet: this.wallet() };
    });
  }

  cashOut(roundId: string, body: CashOutBody, key: string): Promise<ActionResult> {
    return this.once(key, async () => {
      await sleep(this.latencyMs);
      const { round, balloon } = this.expect(roundId, body.balloonIndex, body.expectedDrawIndex);
      if (balloon.rung === 0) {
        fail({ code: 'invalid_request', message: 'Pump at least once before cashing out.' });
      }
      this.payOut(round, balloon);
      const view = this.roundView(round);
      this.finishIfOver(round);
      return { round: view, wallet: this.wallet() };
    });
  }

  setClientSeed(clientSeed: string, key: string): Promise<FairnessView> {
    return this.once(key, async () => {
      await sleep(this.latencyMs);
      if (!CLIENT_SEED_PATTERN.test(clientSeed)) {
        fail({ code: 'invalid_request', message: 'Use 1 to 64 of A-Z, a-z, 0-9, _ and -.' });
      }
      if (this.round) fail({ code: 'round_active', message: 'Seeds are locked during a round.' });
      // The nonce belongs to the server seed: changing the client seed keeps it.
      this.clientSeed = clientSeed;
      return this.fairness();
    });
  }

  rotateSeed(key: string): Promise<RotateResult> {
    return this.once(key, async () => {
      await sleep(this.latencyMs);
      const seedBefore = this.serverSeed;
      const serverSeedHash = await this.serverSeedHash;
      this.assertSeedUnchanged(seedBefore);
      if (this.round) fail({ code: 'round_active', message: 'Seeds are locked during a round.' });
      const revealed = {
        serverSeed: this.serverSeed,
        serverSeedHash,
        roundsPlayed: this.nonce,
      };
      this.serverSeed = randomHex(32);
      this.serverSeedHash = sha256Hex(this.serverSeed);
      this.nonce = 0;
      return { revealed, fairness: await this.fairness() };
    });
  }

  /**
   * Fails if the server seed was rotated while an action waited for its
   * hash. Call it right before the action changes anything, with no await
   * in between, so a seed and its hash always match.
   */
  private assertSeedUnchanged(seedBefore: string): void {
    if (this.serverSeed !== seedBefore) {
      fail({ code: 'conflict', message: 'The server seed just changed. Please try again.' });
    }
  }

  /** Runs an action once per key; a repeat gets the first answer back. */
  private once<T>(key: string, action: () => Promise<T>): Promise<T> {
    const earlier = this.answered.get(key);
    if (earlier) return earlier as Promise<T>;
    const answer = action();
    this.answered.set(key, answer);
    return answer;
  }

  /** The balloon, if it is still active and in the state the client saw. */
  private expect(
    roundId: string,
    balloonIndex: number,
    expectedDrawIndex: number,
  ): { round: DemoRound; balloon: DemoBalloon } {
    const round = this.round;
    if (!round || round.id !== roundId) {
      return fail({
        code: 'conflict',
        message: 'That round is over.',
        round: round ? this.roundView(round) : null,
        wallet: this.wallet(),
      });
    }
    const balloon = round.balloons[balloonIndex];
    if (!balloon) return fail({ code: 'invalid_request', message: 'No such balloon.' });
    if (balloon.status !== 'active' || balloon.drawIndex !== expectedDrawIndex) {
      return fail({
        code: 'conflict',
        message: 'That balloon has changed.',
        round: this.roundView(round),
        wallet: this.wallet(),
      });
    }
    return { round, balloon };
  }

  private payOut(round: DemoRound, balloon: DemoBalloon): void {
    balloon.payoutCents = cashOutCents(balloon.betCents, round.difficulty.ladder, balloon.rung);
    balloon.status = 'cashed';
    this.balanceCents += balloon.payoutCents;
  }

  private finishIfOver(round: DemoRound): void {
    if (round.balloons.some((b) => b.status === 'active')) return;
    const sum = (pick: (b: DemoBalloon) => number): number =>
      round.balloons.reduce((total, b) => total + pick(b), 0);
    this.history.unshift({
      id: round.id,
      difficultyId: round.difficulty.id,
      balloonCount: round.balloons.length,
      betCents: sum((b) => b.betCents),
      patchesCents: sum((b) => b.patchesCents),
      payoutCents: sum((b) => b.payoutCents),
      serverSeedHash: round.serverSeedHash,
      nonce: round.nonce,
      finishedAt: new Date().toISOString(),
    });
    this.round = null;
  }

  private wallet(): { balanceCents: number } {
    return { balanceCents: this.balanceCents };
  }

  private async fairness(): Promise<FairnessView> {
    return {
      serverSeedHash: await this.serverSeedHash,
      clientSeed: this.clientSeed,
      nextNonce: this.nonce,
    };
  }

  private roundView(round: DemoRound): RoundView {
    const active = round.balloons.some((b) => b.status === 'active');
    return {
      id: round.id,
      difficultyId: round.difficulty.id,
      rtpBp: round.rtpBp,
      ladder: round.difficulty.ladder,
      status: active ? 'active' : 'finished',
      serverSeedHash: round.serverSeedHash,
      clientSeed: round.clientSeed,
      nonce: round.nonce,
      startedAt: round.startedAt,
      balloons: round.balloons.map((b, index) => this.balloonView(round, b, index)),
    };
  }

  private balloonView(round: DemoRound, balloon: DemoBalloon, index: number): BalloonView {
    const ladder = round.difficulty.ladder;
    const { rtpBp } = round;
    const isActive = balloon.status === 'active';
    const pump = balloon.rung + 1;
    return {
      index,
      betCents: balloon.betCents,
      status: balloon.status,
      rung: balloon.rung,
      drawIndex: balloon.drawIndex,
      topRung: balloon.topRung,
      multiplierHundredths: balloon.rung > 0 ? multiplierAt(ladder, balloon.rung) : null,
      cashOutCents:
        isActive && balloon.rung > 0 ? cashOutCents(balloon.betCents, ladder, balloon.rung) : null,
      next: isActive
        ? {
            popChance: popChance(rtpBp, ladder, pump),
            multiplierHundredths: multiplierAt(ladder, pump),
            patchPriceCents:
              balloon.rung > 0 ? patchPriceCents(rtpBp, ladder, balloon.betCents, pump) : null,
          }
        : null,
      patchesCents: balloon.patchesCents,
      payoutCents: balloon.payoutCents,
    };
  }
}
