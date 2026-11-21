/**
 * The API contract between the web app and the server.
 *
 * Both sides import these types from this package, so the two can never
 * drift. It started as the web app's list of what the screen needs.
 *
 * Rules every response follows:
 * - Money is integer cents. Multipliers are integer hundredths (123 = 1.23x).
 * - Chances are exact fractions { num, den }. The screen turns them into a
 *   percentage for display only.
 * - While a round is in progress, no response contains the outcome of a pump
 *   that was not made. Once a round is over, each balloon cashed out below
 *   its top rung shows where it would have popped (BalloonView.afterRound).
 * - No response ever contains an unrevealed server seed.
 *
 * Endpoints. All JSON. Every mutating request carries an Idempotency-Key
 * header (1 to 128 characters from A-Z, a-z, 0-9, _ and -); a repeat with the
 * same key gets the stored original response, whether that was a success or
 * a refusal. Using one key for two different requests is refused with 422
 * "key_reused".
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
 *   GET  /api/rounds/:roundId/verify                        -> VerifiableRound
 *        A finished round with everything needed to recompute it, once its
 *        server seed is revealed. 409 "seed_not_revealed" before that.
 *
 * Errors come back as { error: ApiErrorBody }. A 409 "conflict" means the
 * balloon was not in the state the request expected; the body carries the
 * current state so the screen can catch up.
 *
 * Status codes: invalid_request 400, no_session 401, insufficient_funds 402,
 * not_found 404, conflict, round_active and seed_not_revealed 409,
 * key_reused 422, internal_error 500.
 *
 * Three things a client must do:
 * - Load GET /api/session first, alone. It is the only request that creates
 *   a player and sets the cookie; every other request answers 401
 *   "no_session" without one.
 * - Make a new idempotency key for every new player action, and reuse it
 *   only to retry that same action. A refusal is stored under its key too.
 * - Send no body (or {}) to POST /api/fairness/rotate.
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

/**
 * How a balloon's reveal ends:
 * - popped: a later plain pump would have popped it
 * - top:    it would have reached its top rung
 */
export type RevealOutcome = 'popped' | 'top';

/**
 * Where a balloon cashed out below its top rung would have popped, if the
 * player had kept pumping with no Patch. Shown only once the whole round is
 * over. Display only: no rolls, no money.
 */
export interface AfterRoundView {
  readonly outcome: RevealOutcome;
  /**
   * The highest rung it would have reached. popped: the rung it was on when
   * a pump popped it (the cash-out rung itself if the very next pump pops).
   * top: its top rung.
   */
  readonly reachedRung: number;
  /** The multiplier of reachedRung, in hundredths (the engine's multiplierAt). */
  readonly reachedMultiplierHundredths: number;
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
  /**
   * Where it would have popped. Set only when the round is finished and this
   * balloon was cashed out below its top rung; null otherwise, and always
   * null while the round is in progress. Responses stored before this field
   * existed lack it: read it as `afterRound ?? null`.
   */
  readonly afterRound: AfterRoundView | null;
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
  /** The bets that were actually played. A refunded bet is not counted. */
  readonly betCents: number;
  readonly patchesCents: number;
  readonly payoutCents: number;
  /**
   * Bets handed back because the round was abandoned before those balloons
   * were ever pumped. They are void bets: not part of betCents, and not a win.
   */
  readonly refundedCents: number;
  readonly serverSeedHash: string;
  readonly nonce: number;
  /** ISO 8601. */
  readonly finishedAt: string;
  /** The round's server seed has been revealed, so it can be verified now. */
  readonly seedRevealed: boolean;
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
  | 'seed_not_revealed'
  | 'not_found'
  /** No valid player cookie. Load GET /api/session first: it creates the player. */
  | 'no_session'
  /** This idempotency key was already used for a different request. */
  | 'key_reused'
  | 'internal_error';

/** One thing done to a balloon, in the order it was done. */
export type BalloonAction =
  | { readonly kind: 'pump'; readonly patch: boolean }
  | { readonly kind: 'cashOut' };

/** The draw that decided one pump, as the server recorded it. */
export interface DrawRecordView {
  /** The balloon's draw index this pump used. */
  readonly drawIndex: number;
  /** The roll was drawn from 0 to den - 1. */
  readonly den: number;
  /** The pump survived if roll < num. */
  readonly num: number;
  readonly roll: number;
}

/**
 * A balloon's reveal as stored, with its draws, so the verify page can work
 * it out again from the revealed seeds and compare.
 */
export interface VerifiableAfterRound {
  readonly outcome: RevealOutcome;
  /** As in AfterRoundView. */
  readonly reachedRung: number;
  /**
   * Its draws, in order: plain pumps (no Patch) from rung + 1 up. The first
   * uses the balloon's drawIndex at cash-out (not its rung), each next one
   * the index after. Each survives except a final pop.
   */
  readonly draws: readonly DrawRecordView[];
}

/** One balloon of a finished round: what was done to it, and how it ended. */
export interface VerifiableBalloon {
  readonly betCents: number;
  /** Its top rung as fixed when the round started (after the payout cap). */
  readonly topRung: number;
  /**
   * Every action, in order. A balloon settled because its round was
   * abandoned ends with a 'cashOut' if it had been pumped; a refunded one
   * has no actions.
   */
  readonly actions: readonly BalloonAction[];
  /** The draw of every pump on this balloon, in order, as recorded. */
  readonly draws: readonly DrawRecordView[];
  /** How it ended, as recorded and paid. The verify page checks these. */
  readonly status: BalloonStatus;
  readonly rung: number;
  readonly drawIndex: number;
  readonly patchesCents: number;
  readonly payoutCents: number;
  /** Its reveal: set for a balloon cashed out below its top rung, null otherwise. */
  readonly afterRound: VerifiableAfterRound | null;
}

/**
 * Everything needed to recompute a finished round in the browser: its
 * revealed server seed, its client seed and nonce, the RTP, ladder and
 * payout cap it was played with, and each balloon's actions, draws, recorded
 * end state and reveal. It is the engine's RoundRecord (from
 * @pump/engine/fair) plus id and finishedAt, so it can go straight into
 * verifyRound.
 */
export interface VerifiableRound {
  readonly id: string;
  readonly difficultyId: string;
  readonly rtpBp: number;
  readonly ladder: readonly number[];
  /** The payout cap per balloon the round was played under, in cents. */
  readonly maxPayoutCents: number;
  readonly serverSeed: string;
  readonly serverSeedHash: string;
  readonly clientSeed: string;
  readonly nonce: number;
  /** ISO 8601. */
  readonly finishedAt: string;
  readonly balloons: readonly VerifiableBalloon[];
}

/** The shape of every error response. */
export interface ApiErrorResponse {
  readonly error: ApiErrorBody;
}

/** The response of GET /api/history. */
export interface HistoryResponse {
  readonly rounds: readonly RoundSummary[];
}

/** The body of PUT /api/fairness/client-seed. */
export interface SetClientSeedBody {
  readonly clientSeed: string;
}

export interface ApiErrorBody {
  readonly code: ApiErrorCode;
  readonly message: string;
  /** Sent with "conflict": the state as it is now. */
  readonly round?: RoundView | null;
  readonly wallet?: WalletView;
}
