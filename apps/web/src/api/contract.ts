/**
 * The API contract between the web app and the server: a proposal.
 *
 * The server is not built yet. These types say what the screen needs from
 * it, so the server can be written to match. When the server lands, move this
 * file into a package that both sides import, so the two can never drift.
 *
 * Rules every response follows:
 * - Money is integer cents. Multipliers are integer hundredths (123 = 1.23x).
 * - Chances are exact fractions { num, den }. The screen turns them into a
 *   percentage for display only.
 * - No response ever contains a future draw or an unrevealed server seed.
 *
 * Endpoints. All JSON. Every mutating request carries an Idempotency-Key
 * header; a repeat with the same key gets the stored original response.
 *
 *   GET  /api/session                     -> SessionView
 *        Wallet, seeds, and the in-progress round if there is one, so a page
 *        refresh can restore it.
 *   GET  /api/history?limit=10            -> { rounds: RoundSummary[] }
 *   POST /api/rounds                      StartRoundRequest -> ActionResult
 *   POST /api/rounds/:roundId/pump        PumpBody          -> PumpResult
 *        With patch: true this buys a Patch and pumps in one atomic step.
 *   POST /api/rounds/:roundId/cash-out    CashOutBody       -> ActionResult
 *   PUT  /api/fairness/client-seed        { clientSeed }    -> FairnessView
 *   POST /api/fairness/rotate                               -> RotateResult
 *
 * Errors come back as { error: ApiErrorBody }. A 409 "conflict" means the
 * balloon was not in the state the request expected; the body carries the
 * current state so the screen can catch up.
 */

/** An exact chance: num out of den. */
export interface Fraction {
  readonly num: number;
  readonly den: number;
}

export interface WalletView {
  readonly balanceCents: number;
}

export type BalloonStatus = 'active' | 'popped' | 'cashed' | 'refunded';

/** What the next pump on an active balloon would do. */
export interface NextPumpView {
  /** Chance that the next pump pops this balloon. */
  readonly popChance: Fraction;
  /** The multiplier after the next pump, if it survives. */
  readonly multiplierHundredths: number;
  /** Price of a Patch for the next pump. Null before the first pump. */
  readonly patchPriceCents: number | null;
}

export interface BalloonView {
  /** 0, 1 or 2. The screen shows it as balloon 1, 2 or 3. */
  readonly index: number;
  readonly betCents: number;
  readonly status: BalloonStatus;
  /** Successful pumps so far. 0 means not pumped yet, so no cash-out. */
  readonly rung: number;
  /**
   * Draws made on this balloon so far. Pump and cash-out requests send it
   * back as expectedDrawIndex. A pump saved by a Patch uses a draw without
   * moving the rung, so the rung alone is not enough for this check.
   */
  readonly drawIndex: number;
  /**
   * The highest rung this balloon can reach with its bet, after the
   * max-payout cap. Reaching it cashes out automatically.
   */
  readonly topRung: number;
  /** Current multiplier. Null at rung 0. */
  readonly multiplierHundredths: number | null;
  /** What cashing out right now would pay. Null at rung 0 or once over. */
  readonly cashOutCents: number | null;
  /** The next pump. Null once the balloon has popped or cashed out. */
  readonly next: NextPumpView | null;
  /** Spent on Patches for this balloon so far. */
  readonly patchesCents: number;
  /** Paid out for this balloon. 0 until it cashes out. */
  readonly payoutCents: number;
}

export type RoundStatus = 'active' | 'finished';

export interface RoundView {
  readonly id: string;
  readonly difficultyId: string;
  /**
   * The RTP and ladder this round was played with. Each round keeps its own
   * copy, so it still shows and verifies correctly after the config changes.
   */
  readonly rtpBp: number;
  readonly ladder: readonly number[];
  readonly status: RoundStatus;
  /** The seeds this round uses. The server seed itself stays hidden. */
  readonly serverSeedHash: string;
  readonly clientSeed: string;
  readonly nonce: number;
  readonly balloons: readonly BalloonView[];
  /** ISO 8601. */
  readonly startedAt: string;
}

/** One line in the history list. */
export interface RoundSummary {
  readonly id: string;
  readonly difficultyId: string;
  readonly balloonCount: number;
  readonly betCents: number;
  readonly patchesCents: number;
  readonly payoutCents: number;
  readonly serverSeedHash: string;
  readonly nonce: number;
  /** ISO 8601. */
  readonly finishedAt: string;
}

export interface FairnessView {
  /** SHA-256 of the active server seed. The seed is revealed on rotate. */
  readonly serverSeedHash: string;
  /**
   * Null for a new player. The browser makes the first client seed and
   * sends it, so even a player who never edits it isn't using one the
   * server picked. A round can't start until it is set.
   */
  readonly clientSeed: string | null;
  /** The nonce the next round will use. */
  readonly nextNonce: number;
}

export interface SessionView {
  readonly wallet: WalletView;
  readonly fairness: FairnessView;
  /** The round in progress, or null. Lets a refresh pick up where it was. */
  readonly activeRound: RoundView | null;
}

export interface StartRoundRequest {
  readonly difficultyId: string;
  /** One bet per balloon, 1 to 3 of them. */
  readonly betsCents: readonly number[];
}

export interface PumpBody {
  readonly balloonIndex: number;
  readonly expectedDrawIndex: number;
  /** Buy a Patch for this pump in the same atomic step. */
  readonly patch: boolean;
}

export interface CashOutBody {
  readonly balloonIndex: number;
  readonly expectedDrawIndex: number;
}

export interface ActionResult {
  readonly round: RoundView;
  readonly wallet: WalletView;
}

/**
 * What a pump did:
 * - survived: moved up one rung
 * - saved:    would have popped, but the Patch saved it; same rung
 * - popped:   the bet on this balloon is lost
 * - top:      reached its top rung and cashed out automatically
 */
export type PumpOutcome = 'survived' | 'saved' | 'popped' | 'top';

export interface PumpResult extends ActionResult {
  readonly outcome: PumpOutcome;
}

/** A server seed that has been retired, so rounds on it can be verified. */
export interface RevealedSeed {
  readonly serverSeed: string;
  readonly serverSeedHash: string;
  /** Rounds played on it used nonces 0 to roundsPlayed - 1. */
  readonly roundsPlayed: number;
}

export interface RotateResult {
  readonly revealed: RevealedSeed;
  readonly fairness: FairnessView;
}

export type ApiErrorCode =
  | 'conflict'
  | 'insufficient_funds'
  | 'invalid_request'
  | 'round_active'
  | 'not_found';

export interface ApiErrorBody {
  readonly code: ApiErrorCode;
  readonly message: string;
  /** Sent with "conflict": the state as it is now. */
  readonly round?: RoundView | null;
  readonly wallet?: WalletView;
}
