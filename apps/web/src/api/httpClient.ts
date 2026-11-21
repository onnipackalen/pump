import { ApiFailure, NetworkFailure, type GameClient } from './client';
import type {
  ActionResult,
  ApiErrorBody,
  CashOutBody,
  FairnessView,
  HistoryResponse,
  PumpBody,
  PumpResult,
  RotateResult,
  RoundSummary,
  SessionView,
  StartRoundRequest,
  VerifiableRound,
} from './contract';

type Method = 'GET' | 'POST' | 'PUT';

/**
 * How long one request may take. The server answers in a few milliseconds, so
 * a request still open after this long is stuck. Giving up is safe: the screen
 * sends it again with the same key, and the server applies it once.
 */
const REQUEST_LIMIT_MS = 10_000;

interface CallOptions {
  /** Sent as JSON. Left out, the request has no body at all. */
  readonly body?: object;
  /** The idempotency key of a request that changes something. */
  readonly key?: string;
}

/** The error part of a refusal, or null if the answer is not one the server wrote. */
function refusalIn(json: unknown): ApiErrorBody | null {
  if (typeof json !== 'object' || json === null || !('error' in json)) return null;
  const { error } = json;
  if (typeof error !== 'object' || error === null) return null;
  if (!('code' in error) || typeof error.code !== 'string') return null;
  if (!('message' in error) || typeof error.message !== 'string') return null;
  // The shape was just checked; the server and this app share the contract types.
  return error as ApiErrorBody;
}

/**
 * The real game: every call is a request to the server.
 *
 * The server keeps the player in an httpOnly cookie, which the browser sends
 * by itself and scripts cannot read. It decides every outcome; nothing here
 * knows a result before the server answers.
 *
 * Three things the server expects, all handled here so the screen need not
 * think about them:
 *
 * 1. The session is loaded first, alone. That request is the only one that
 *    creates a player. Every other call waits for it.
 * 2. A request that changes something carries the idempotency key the screen
 *    made for that action. A retry reuses the key, so it is applied once.
 * 3. A request never quietly becomes another player's. If the cookie has gone
 *    (cleared, or the server's data was reset) the server refuses with
 *    `no_session`, and that refusal is passed on as it is. Only loading the
 *    session, which a page reload does, starts a new player.
 */
export class HttpClient implements GameClient {
  readonly isDemo = false;

  private readonly send: typeof fetch;
  /** The session load that everything else waits for. */
  private opening: Promise<unknown> | null = null;
  /** A session load that has been sent and not answered yet. */
  private loading: Promise<SessionView> | null = null;

  /** `send` is the browser's fetch unless a test hands in its own. */
  constructor(send: typeof fetch = (input, init) => fetch(input, init)) {
    this.send = send;
  }

  /** One request. Throws ApiFailure for a refusal, NetworkFailure if no proper answer came. */
  private async call<T>(method: Method, path: string, options: CallOptions = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.send(path, {
        method,
        // The cookie only ever goes to the game's own address.
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.key === undefined ? {} : { 'idempotency-key': options.key }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
    } catch {
      throw new NetworkFailure('Could not reach the game server. Check your connection.');
    }

    let json: unknown;
    let isJson = true;
    try {
      json = await response.json();
    } catch {
      // Not JSON, or the answer stopped half way.
      isJson = false;
    }
    // The server's answers follow the shared contract; that is what T names.
    if (response.ok && isJson) return json as T;

    const refusal = isJson ? refusalIn(json) : null;
    if (refusal) throw new ApiFailure(refusal);
    // Something between us and the game answered (a proxy, a crash page, a
    // plain web page where the API should be). The request may or may not
    // have arrived, so it is safe to retry with the same key.
    throw new NetworkFailure(`The game server did not answer properly (${String(response.status)}).`);
  }

  private openSession(): Promise<SessionView> {
    // A first visit has no cookie yet, so two loads sent at the same moment
    // would make two players. While one is on its way, everyone shares it.
    if (this.loading) return this.loading;

    const loading = this.call<SessionView>('GET', '/api/session');
    this.loading = loading;
    this.opening = loading;
    loading.then(
      () => {
        if (this.loading === loading) this.loading = null;
      },
      () => {
        if (this.loading === loading) this.loading = null;
        // A failed load must not be waited on for ever: the next call tries again.
        if (this.opening === loading) this.opening = null;
      },
    );
    return loading;
  }

  /** Waits until this browser has a player on the server. */
  private async opened(): Promise<void> {
    await (this.opening ?? this.openSession());
  }

  /** A request made as the player: sent only once the session is open. */
  private async asPlayer<T>(method: Method, path: string, options: CallOptions = {}): Promise<T> {
    await this.opened();
    return this.call<T>(method, path, options);
  }

  getSession(): Promise<SessionView> {
    return this.openSession();
  }

  async getHistory(limit: number): Promise<readonly RoundSummary[]> {
    const answer = await this.asPlayer<HistoryResponse>(
      'GET',
      `/api/history?limit=${String(limit)}`,
    );
    return answer.rounds;
  }

  startRound(request: StartRoundRequest, key: string): Promise<ActionResult> {
    return this.asPlayer('POST', '/api/rounds', { body: request, key });
  }

  pump(roundId: string, body: PumpBody, key: string): Promise<PumpResult> {
    return this.asPlayer('POST', `/api/rounds/${encodeURIComponent(roundId)}/pump`, { body, key });
  }

  cashOut(roundId: string, body: CashOutBody, key: string): Promise<ActionResult> {
    return this.asPlayer('POST', `/api/rounds/${encodeURIComponent(roundId)}/cash-out`, {
      body,
      key,
    });
  }

  setClientSeed(clientSeed: string, key: string): Promise<FairnessView> {
    return this.asPlayer('PUT', '/api/fairness/client-seed', { body: { clientSeed }, key });
  }

  /** No body: the server takes none for a rotation. */
  rotateSeed(key: string): Promise<RotateResult> {
    return this.asPlayer('POST', '/api/fairness/rotate', { key });
  }

  getVerifiableRound(roundId: string): Promise<VerifiableRound> {
    return this.asPlayer('GET', `/api/rounds/${encodeURIComponent(roundId)}/verify`);
  }
}
