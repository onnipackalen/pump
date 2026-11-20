import type {
  ApiErrorBody,
  ApiErrorCode,
  ApiErrorResponse,
  RoundView,
  WalletView,
} from '@pump/contract';

const STATUS: Readonly<Record<ApiErrorCode, number>> = {
  invalid_request: 400,
  no_session: 401,
  insufficient_funds: 402,
  not_found: 404,
  conflict: 409,
  round_active: 409,
  seed_not_revealed: 409,
  key_reused: 422,
  internal_error: 500,
};

interface ApiErrorOptions {
  /** Overrides the usual status for the code. */
  readonly status?: number;
  /**
   * The round and wallet to send with the refusal, so the screen can catch
   * up. These are functions on purpose: they are called when the answer is
   * built, which is AFTER the refused request has been rolled back. An
   * answer therefore never reports a balance or a round state that the
   * rollback then undid.
   */
  readonly round?: () => RoundView | null;
  readonly wallet?: () => WalletView;
}

/**
 * A request the server refuses, with the reason the player sees.
 *
 * Throwing one inside a transaction undoes whatever that request had started
 * to do, so a refused request never changes anything.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  private readonly options: ApiErrorOptions;

  constructor(code: ApiErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = options.status ?? STATUS[code];
    this.options = options;
  }

  /** Builds the answer. Call it only once the request's own changes have been undone. */
  toResponse(): ApiErrorResponse {
    const body: ApiErrorBody = {
      code: this.code,
      message: this.message,
      ...(this.options.round ? { round: this.options.round() } : {}),
      ...(this.options.wallet ? { wallet: this.options.wallet() } : {}),
    };
    return { error: body };
  }
}
