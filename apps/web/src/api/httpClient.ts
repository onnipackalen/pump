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
 * 3. If the cookie has gone (cleared, or the server's data was reset), the
 *    session is opened again and the request is tried once more.
 */
export class HttpClient implements GameClient {
  readonly isDemo = false;

  private readonly send: typeof fetch;
  /** The session load that everything else waits for. */
  private opening: Promise<unknown> | null = null;

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
      });
    } catch {
      throw new NetworkFailure('Could not reach the game server. Check your connection.');
    }

    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // Not JSON: handled below as "no proper answer".
    }
    // The server's answers follow the shared contract; that is what T names.
    if (response.ok) return json as T;

    const refusal = refusalIn(json);
    if (refusal) throw new ApiFailure(refusal);
    // Something between us and the game answered (a proxy, a crash page).
    // The request may or may not have arrived, so it is safe to retry with
    // the same key.
    throw new NetworkFailure(`The game server did not answer properly (${String(response.status)}).`);
  }

  private openSession(): Promise<SessionView> {
    const loading = this.call<SessionView>('GET', '/api/session');
    this.opening = loading;
    // A failed load must not be waited on for ever: the next call tries again.
    loading.catch(() => {
      if (this.opening === loading) this.opening = null;
    });
    return loading;
  }

  /** Waits until this browser has a player on the server. */
  private async opened(): Promise<void> {
    await (this.opening ?? this.openSession());
  }

  /** A request made as the player: after the session is open, and once more if the cookie was lost. */
  private async asPlayer<T>(method: Method, path: string, options: CallOptions = {}): Promise<T> {
    await this.opened();
    try {
      return await this.call<T>(method, path, options);
    } catch (error) {
      if (!(error instanceof ApiFailure) || error.code !== 'no_session') throw error;
      await this.openSession();
      return this.call<T>(method, path, options);
    }
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
