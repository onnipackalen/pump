import type {
  ActionResult,
  ApiErrorBody,
  ApiErrorCode,
  CashOutBody,
  FairnessView,
  PumpBody,
  PumpResult,
  RotateResult,
  RoundSummary,
  SessionView,
  StartRoundRequest,
  VerifiableRound,
} from './contract';

/**
 * Everything the screen can ask of the game. The screen only talks to this
 * interface, so swapping the demo stand-in for the real server is one line
 * in api/index.ts.
 *
 * Every method that changes something takes an idempotency key. The caller
 * makes one key per player action and reuses it on a retry, so a double
 * click or a retry after a timeout is applied once.
 */
export interface GameClient {
  /** True while the game runs in the browser without a server. */
  readonly isDemo: boolean;

  getSession(): Promise<SessionView>;
  getHistory(limit: number): Promise<readonly RoundSummary[]>;
  startRound(request: StartRoundRequest, key: string): Promise<ActionResult>;
  pump(roundId: string, body: PumpBody, key: string): Promise<PumpResult>;
  cashOut(roundId: string, body: CashOutBody, key: string): Promise<ActionResult>;
  setClientSeed(clientSeed: string, key: string): Promise<FairnessView>;
  rotateSeed(key: string): Promise<RotateResult>;
  /** A finished round to recompute. Fails with seed_not_revealed until its seed is rotated. */
  getVerifiableRound(roundId: string): Promise<VerifiableRound>;
}

/** The server said no. Carries the error body, including any current state. */
export class ApiFailure extends Error {
  readonly code: ApiErrorCode;
  readonly body: ApiErrorBody;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiFailure';
    this.code = body.code;
    this.body = body;
  }
}

/** The request may not have arrived. Safe to retry with the same key. */
export class NetworkFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkFailure';
  }
}
