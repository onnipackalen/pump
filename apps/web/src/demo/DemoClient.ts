/**
 * DEMO STAND-IN. Delete it once the server exists.
 *
 * Plays the game inside the browser so the screen can be used before the
 * API is connected. It runs the real rules and the real draws:
 * - every rule (bets, pumps, Patches, cash-outs, the top rung) is the
 *   engine's own startRound, pump and cashOut from @pump/engine;
 * - every pump is drawn from the seeds with @pump/engine/fair, exactly as
 *   the server will draw it, and each balloon's actions are recorded, so a
 *   round can be checked on the verify page once its seed is rotated.
 * What it is not: a server. The server seed lives in this browser, so the
 * player could peek at it, and nothing is saved: a refresh starts over.
 * The brief says a browser-only game does not count, so the screen shows a
 * "Demo" badge whenever this client is in use.
 *
 * It also keeps the server's promises the screen relies on: one active
 * round, idempotency keys, expected draw index checks (409 with the current
 * state), and seeds that stay fixed during a round.
 *
 * Once a round is over it works out each reveal ("where it would have
 * popped") for every balloon cashed out below its top rung, as the server
 * does: with the engine's revealAfterCashOut and the round's own seeds, only
 * after the engine accepted the action that ended the round. Nothing about a
 * reveal exists while the round is in progress.
 */

import {
  canReveal,
  cashOut as engineCashOut,
  EngineError,
  GAME_CONFIG,
  isRoundOver,
  multiplierAt,
  pump as enginePump,
  quoteBalloon,
  revealAfterCashOut,
  startRound as engineStartRound,
  type GameConfig,
  type Round,
} from '@pump/engine';
import { drawerFor, hashServerSeed, revealDrawerFor } from '@pump/engine/fair';
import { ApiFailure, type GameClient } from '../api/client';
import type {
  ActionResult,
  AfterRoundView,
  ApiErrorBody,
  BalloonAction,
  DrawRecordView,
  BalloonView,
  CashOutBody,
  FairnessView,
  PumpBody,
  PumpResult,
  RotateResult,
  RoundSummary,
  RoundView,
  SessionView,
  StartRoundRequest,
  VerifiableAfterRound,
  VerifiableRound,
} from '../api/contract';
import { CLIENT_SEED_PATTERN } from '../game/clientSeed';

const STARTING_BALANCE_CENTS = 1_000_000;

/** A round as the demo "server" keeps it: the engine's round plus its seeds and actions. */
interface DemoRound {
  readonly id: string;
  round: Round;
  readonly serverSeed: string;
  readonly serverSeedHash: string;
  readonly clientSeed: string;
  readonly nonce: number;
  readonly startedAt: string;
  finishedAt: string | null;
  /** The payout cap this round was played under, kept with the round like its RTP. */
  readonly maxPayoutCents: number;
  /** Per balloon, every action in order: what the verify page replays. */
  readonly actions: BalloonAction[][];
  /** Per balloon, the draw of every pump in order: what the verify page compares. */
  readonly draws: DrawRecordView[][];
  /**
   * Per balloon, its reveal with its draws. All null until the round is
   * over; then set for each balloon cashed out below its top rung.
   */
  readonly afterRounds: (VerifiableAfterRound | null)[];
}

/** A new server seed: 32 random bytes as 64 lowercase hex characters. */
function newServerSeed(): string {
  const buffer = new Uint8Array(32);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
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
  private serverSeed = newServerSeed();
  private serverSeedHash = hashServerSeed(this.serverSeed);
  /** Null until the browser sends the first one. */
  private clientSeed: string | null = null;
  private nonce = 0;
  private active: DemoRound | null = null;
  /** Finished rounds, newest first. */
  private finished: DemoRound[] = [];
  private readonly answered = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: GameConfig = GAME_CONFIG,
    private readonly latencyMs = 120,
  ) {}

  async getSession(): Promise<SessionView> {
    await sleep(this.latencyMs);
    return {
      wallet: this.wallet(),
      fairness: this.fairness(),
      activeRound: this.active ? this.roundView(this.active) : null,
    };
  }

  async getHistory(limit: number): Promise<readonly RoundSummary[]> {
    await sleep(this.latencyMs);
    return this.finished.slice(0, limit).map((r) => this.summary(r));
  }

  // Each action below awaits only its pretend network delay, then does all
  // of its checks and changes with no await in between, like the server's
  // single transaction.

  startRound(request: StartRoundRequest, key: string): Promise<ActionResult> {
    return this.once(key, async () => {
      await sleep(this.latencyMs);
      if (this.active) fail({ code: 'round_active', message: 'Finish the current round first.' });
      const clientSeed = this.clientSeed;
      if (clientSeed === null) {
        fail({ code: 'invalid_request', message: 'Set a client seed first.' });
      }
      const started = this.engine(() =>
        engineStartRound(this.config, request.difficultyId, request.betsCents, this.balanceCents),
      );
      this.balanceCents -= started.costCents;
      this.active = {
        id: crypto.randomUUID(),
        round: started.round,
        serverSeed: this.serverSeed,
        serverSeedHash: this.serverSeedHash,
        clientSeed,
        nonce: this.nonce,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        maxPayoutCents: this.config.limits.maxPayoutCents,
        actions: started.round.balloons.map(() => []),
        draws: started.round.balloons.map(() => []),
        afterRounds: started.round.balloons.map(() => null),
      };
      this.nonce += 1;
      return { round: this.roundView(this.active), wallet: this.wallet() };
    });
  }

  pump(roundId: string, body: PumpBody, key: string): Promise<PumpResult> {
    return this.once(key, async () => {
      await sleep(this.latencyMs);
      const demo = this.activeRound(roundId);
      const { balloonIndex, expectedDrawIndex, patch } = body;
      // The draw for this pump, from the seeds. The engine calls it once,
      // and only after every check has passed, so a refused request never
      // touches the seeds.
      const draw = (den: number): number =>
        drawerFor({
          serverSeed: demo.serverSeed,
          clientSeed: demo.clientSeed,
          nonce: demo.nonce,
          balloonIndex,
          drawIndex: expectedDrawIndex,
        })(den);
      const result = this.engine(
        () =>
          enginePump(
            demo.round,
            { balloonIndex, expectedDrawIndex, patch, balanceCents: this.balanceCents },
            draw,
          ),
        demo,
      );
      demo.round = result.round;
      this.balanceCents -= result.patchChargedCents ?? 0;
      this.balanceCents += result.payoutCents;
      demo.actions[balloonIndex]?.push({ kind: 'pump', patch });
      demo.draws[balloonIndex]?.push(drawView(result.draw));
      // Only now that the engine has accepted the pump: if it ended the
      // round, the reveals are worked out before the answer is built.
      this.finishIfOver(demo);
      return { outcome: result.outcome, round: this.roundView(demo), wallet: this.wallet() };
    });
  }

  cashOut(roundId: string, body: CashOutBody, key: string): Promise<ActionResult> {
    return this.once(key, async () => {
      await sleep(this.latencyMs);
      const demo = this.activeRound(roundId);
      const result = this.engine(() => engineCashOut(demo.round, body), demo);
      demo.round = result.round;
      this.balanceCents += result.payoutCents;
      demo.actions[body.balloonIndex]?.push({ kind: 'cashOut' });
      // As with a pump: reveals only after the engine has accepted it.
      this.finishIfOver(demo);
      return { round: this.roundView(demo), wallet: this.wallet() };
    });
  }

  setClientSeed(clientSeed: string, key: string): Promise<FairnessView> {
    return this.once(key, async () => {
      await sleep(this.latencyMs);
      if (!CLIENT_SEED_PATTERN.test(clientSeed)) {
        fail({ code: 'invalid_request', message: 'Use 1 to 64 of A-Z, a-z, 0-9, _ and -.' });
      }
      if (this.active) fail({ code: 'round_active', message: 'Seeds are locked during a round.' });
      // The nonce belongs to the server seed: changing the client seed keeps it.
      this.clientSeed = clientSeed;
      return this.fairness();
    });
  }

  rotateSeed(key: string): Promise<RotateResult> {
    return this.once(key, async () => {
      await sleep(this.latencyMs);
      if (this.active) fail({ code: 'round_active', message: 'Seeds are locked during a round.' });
      const revealed = {
        serverSeed: this.serverSeed,
        serverSeedHash: this.serverSeedHash,
        roundsPlayed: this.nonce,
      };
      this.serverSeed = newServerSeed();
      this.serverSeedHash = hashServerSeed(this.serverSeed);
      this.nonce = 0;
      return { revealed, fairness: this.fairness() };
    });
  }

  async getVerifiableRound(roundId: string): Promise<VerifiableRound> {
    await sleep(this.latencyMs);
    const demo = this.finished.find((r) => r.id === roundId);
    if (!demo || demo.finishedAt === null) {
      return fail({ code: 'not_found', message: 'There is no finished round with that id.' });
    }
    if (!this.isRevealed(demo)) {
      return fail({
        code: 'seed_not_revealed',
        message: 'This round’s server seed is still in use. Rotate it to check the round.',
      });
    }
    const { round } = demo;
    return {
      id: demo.id,
      difficultyId: round.difficultyId,
      rtpBp: round.rtpBp,
      ladder: round.ladder,
      maxPayoutCents: demo.maxPayoutCents,
      serverSeed: demo.serverSeed,
      serverSeedHash: demo.serverSeedHash,
      clientSeed: demo.clientSeed,
      nonce: demo.nonce,
      finishedAt: demo.finishedAt,
      balloons: round.balloons.map((b, index) => ({
        betCents: b.betCents,
        topRung: b.topRung,
        actions: demo.actions[index] ?? [],
        status: b.status,
        rung: b.rung,
        drawIndex: b.drawIndex,
        patchesCents: b.patchesCents,
        payoutCents: b.payoutCents,
        draws: demo.draws[index] ?? [],
        afterRound: demo.afterRounds[index] ?? null,
      })),
    };
  }

  /** A round's seed is revealed once it is no longer the active seed. */
  private isRevealed(demo: DemoRound): boolean {
    return demo.serverSeed !== this.serverSeed;
  }

  /**
   * Runs an engine call and turns a rule it refuses into the API's error.
   * A refused request changes nothing and makes no draw. A conflict carries
   * the current state, as the server's 409 does.
   */
  private engine<T>(call: () => T, demo?: DemoRound): T {
    try {
      return call();
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      return fail({
        code: error.code,
        message: error.message,
        ...(error.code === 'conflict' && demo
          ? { round: this.roundView(demo), wallet: this.wallet() }
          : {}),
      });
    }
  }

  /** The active round with this id, or a 409 carrying what is there instead. */
  private activeRound(roundId: string): DemoRound {
    const demo = this.active;
    if (!demo || demo.id !== roundId) {
      return fail({
        code: 'conflict',
        message: 'That round is over.',
        round: demo ? this.roundView(demo) : null,
        wallet: this.wallet(),
      });
    }
    return demo;
  }

  /** Runs an action once per key; a repeat gets the first answer back. */
  private once<T>(key: string, action: () => Promise<T>): Promise<T> {
    const earlier = this.answered.get(key);
    if (earlier) return earlier as Promise<T>;
    const answer = action();
    this.answered.set(key, answer);
    return answer;
  }

  /**
   * Files the round as finished once every balloon is over, and first works
   * out each reveal: every balloon cashed out below its top rung is played on
   * with plain pumps, from its draw count at cash-out, by the engine's
   * revealAfterCashOut. Called only after the engine has accepted an action,
   * so a refused request never makes a reveal draw.
   */
  private finishIfOver(demo: DemoRound): void {
    const { round } = demo;
    if (!isRoundOver(round)) return;
    round.balloons.forEach((balloon, balloonIndex) => {
      if (!canReveal(balloon)) return;
      // Draws for this balloon only, strictly in order from its draw count.
      const drawAt = revealDrawerFor({
        serverSeed: demo.serverSeed,
        clientSeed: demo.clientSeed,
        nonce: demo.nonce,
        balloonIndex,
        drawIndex: balloon.drawIndex,
      });
      const reveal = revealAfterCashOut(round, balloonIndex, drawAt);
      demo.afterRounds[balloonIndex] = {
        outcome: reveal.outcome,
        reachedRung: reveal.reachedRung,
        draws: reveal.draws.map(drawView),
      };
    });
    demo.finishedAt = new Date().toISOString();
    this.finished.unshift(demo);
    this.active = null;
  }

  private summary(demo: DemoRound): RoundSummary {
    const balloons = demo.round.balloons;
    const sum = (pick: (b: (typeof balloons)[number]) => number): number =>
      balloons.reduce((total, b) => total + pick(b), 0);
    return {
      id: demo.id,
      difficultyId: demo.round.difficultyId,
      balloonCount: balloons.length,
      // As on the server: a refunded bet was never played, so it is not a stake.
      betCents: sum((b) => (b.status === 'refunded' ? 0 : b.betCents)),
      patchesCents: sum((b) => b.patchesCents),
      payoutCents: sum((b) => b.payoutCents),
      refundedCents: sum((b) => (b.status === 'refunded' ? b.betCents : 0)),
      serverSeedHash: demo.serverSeedHash,
      nonce: demo.nonce,
      finishedAt: demo.finishedAt ?? demo.startedAt,
      seedRevealed: this.isRevealed(demo),
    };
  }

  private wallet(): { balanceCents: number } {
    return { balanceCents: this.balanceCents };
  }

  private fairness(): FairnessView {
    return {
      serverSeedHash: this.serverSeedHash,
      clientSeed: this.clientSeed,
      nextNonce: this.nonce,
    };
  }

  private roundView(demo: DemoRound): RoundView {
    const { round } = demo;
    return {
      id: demo.id,
      difficultyId: round.difficultyId,
      rtpBp: round.rtpBp,
      ladder: round.ladder,
      status: isRoundOver(round) ? 'finished' : 'active',
      serverSeedHash: demo.serverSeedHash,
      clientSeed: demo.clientSeed,
      nonce: demo.nonce,
      startedAt: demo.startedAt,
      balloons: round.balloons.map((b, index): BalloonView => {
        const quote = quoteBalloon(round, index);
        return {
          index,
          betCents: b.betCents,
          status: b.status,
          rung: b.rung,
          drawIndex: b.drawIndex,
          topRung: b.topRung,
          multiplierHundredths: quote.multiplierHundredths,
          cashOutCents: quote.cashOutCents,
          next: quote.next,
          patchesCents: b.patchesCents,
          payoutCents: b.payoutCents,
          afterRound: this.afterRoundView(demo, index),
        };
      }),
    };
  }

  /**
   * A balloon's reveal as the live screen gets it: no draws, no money. Null
   * while the round is in progress, whatever is stored, so no answer (a 409
   * included) can ever carry one early.
   */
  private afterRoundView(demo: DemoRound, index: number): AfterRoundView | null {
    if (!isRoundOver(demo.round)) return null;
    const reveal = demo.afterRounds[index] ?? null;
    if (reveal === null) return null;
    return {
      outcome: reveal.outcome,
      reachedRung: reveal.reachedRung,
      reachedMultiplierHundredths: multiplierAt(demo.round.ladder, reveal.reachedRung),
    };
  }
}

/** Just the four numbers of a draw that the API carries. */
function drawView({ drawIndex, den, num, roll }: DrawRecordView): DrawRecordView {
  return { drawIndex, den, num, roll };
}
