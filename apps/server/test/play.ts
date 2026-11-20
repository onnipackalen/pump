import type {
  ActionResult,
  ApiErrorResponse,
  FairnessView,
  PumpResult,
  RotateResult,
  RoundView,
  SessionView,
} from '@pump/contract';
import { surviveChance, type GameConfig } from '@pump/engine';
import { drawRoll } from '@pump/engine/fair';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/database';
import { text } from '../src/db/rows';
import { firstVisit } from './helpers';

/** A parsed answer: the status, and the body as whichever shape the caller expects. */
export interface Reply<T> {
  readonly status: number;
  readonly body: T;
  readonly error: ApiErrorResponse['error'] | null;
  readonly raw: string;
}

let keyCounter = 0;
/** A fresh idempotency key, as the browser makes for each new action. */
export const newKey = (): string => `play-${String(keyCounter++)}`;

/**
 * One player at the table: remembers their cookie and plays through the real
 * HTTP routes.
 */
export class Seat {
  private constructor(
    private readonly app: FastifyInstance,
    readonly cookies: Record<string, string>,
  ) {}

  /**
   * A new player. By default they have already set a client seed, so rounds
   * can start; pass null to leave it unset.
   */
  static async join(app: FastifyInstance, clientSeed: string | null = 'test-seed'): Promise<Seat> {
    const visitor = await firstVisit(app);
    const seat = new Seat(app, visitor.cookies);
    if (clientSeed !== null) await seat.setClientSeed(clientSeed);
    return seat;
  }

  /** The same player, talking to another instance of the server (as after a restart). */
  on(app: FastifyInstance): Seat {
    return new Seat(app, this.cookies);
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload: object | undefined,
    key: string | null,
  ): Promise<Reply<T>> {
    const response = await this.app.inject({
      method,
      url,
      cookies: this.cookies,
      headers: key === null ? {} : { 'idempotency-key': key },
      ...(payload === undefined ? {} : { payload }),
    });
    const parsed: unknown = response.body === '' ? null : JSON.parse(response.body);
    const error =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? (parsed as ApiErrorResponse).error
        : null;
    return { status: response.statusCode, body: parsed as T, error, raw: response.body };
  }

  session(): Promise<Reply<SessionView>> {
    return this.send('GET', '/api/session', undefined, null);
  }

  setClientSeed(clientSeed: string, key = newKey()): Promise<Reply<FairnessView>> {
    return this.send('PUT', '/api/fairness/client-seed', { clientSeed }, key);
  }

  rotate(key = newKey()): Promise<Reply<RotateResult>> {
    return this.send('POST', '/api/fairness/rotate', undefined, key);
  }

  start(difficultyId: string, betsCents: readonly number[], key = newKey()) {
    return this.send<ActionResult>('POST', '/api/rounds', { difficultyId, betsCents }, key);
  }

  pump(
    round: RoundView,
    balloonIndex: number,
    options: { patch?: boolean; expectedDrawIndex?: number; key?: string } = {},
  ): Promise<Reply<PumpResult>> {
    const expectedDrawIndex =
      options.expectedDrawIndex ?? round.balloons[balloonIndex]?.drawIndex ?? 0;
    return this.send(
      'POST',
      `/api/rounds/${round.id}/pump`,
      { balloonIndex, expectedDrawIndex, patch: options.patch ?? false },
      options.key ?? newKey(),
    );
  }

  cashOut(
    round: RoundView,
    balloonIndex: number,
    options: { expectedDrawIndex?: number; key?: string } = {},
  ): Promise<Reply<ActionResult>> {
    const expectedDrawIndex =
      options.expectedDrawIndex ?? round.balloons[balloonIndex]?.drawIndex ?? 0;
    return this.send(
      'POST',
      `/api/rounds/${round.id}/cash-out`,
      { balloonIndex, expectedDrawIndex },
      options.key ?? newKey(),
    );
  }

  get<T>(url: string): Promise<Reply<T>> {
    return this.send('GET', url, undefined, null);
  }
}

/** The player's active server seed, read straight from the database. Tests only. */
export function secretSeed(db: Db): string {
  const row = db.prepare('SELECT seed FROM server_seeds WHERE revealed_at IS NULL').get();
  if (!row) throw new Error('no active seed');
  return text(row, 'seed');
}

export interface Foretold {
  readonly serverSeed: string;
  readonly clientSeed: string;
  readonly nonce: number;
  readonly rtpBp: number;
  readonly ladder: readonly number[];
}

/**
 * Whether the pump that takes a balloon to rung `pumpNumber` will survive, if
 * it is that balloon's draw number `drawIndex`. The tests know the secret
 * seed, so they can work out in advance what the server must answer.
 */
export function willSurvive(
  round: Foretold,
  balloonIndex: number,
  drawIndex: number,
  pumpNumber: number,
): boolean {
  const chance = surviveChance(round.rtpBp, round.ladder, pumpNumber);
  const { roll } = drawRoll(
    {
      serverSeed: round.serverSeed,
      clientSeed: round.clientSeed,
      nonce: round.nonce,
      balloonIndex,
      drawIndex,
    },
    chance.den,
  );
  return roll < chance.num;
}

/**
 * Finds a client seed under which `wanted` is true. Tests use it to get the
 * round they need (say, one where the first three pumps survive) from the
 * real draw code, with nothing faked.
 */
export function clientSeedWhere(wanted: (clientSeed: string) => boolean): string {
  for (let attempt = 0; attempt < 100_000; attempt += 1) {
    const clientSeed = `seed-${String(attempt)}`;
    if (wanted(clientSeed)) return clientSeed;
  }
  throw new Error('No client seed gives the wanted round');
}

/** The ladder of one difficulty in a config. */
export function ladderOf(config: GameConfig, difficultyId: string): readonly number[] {
  const difficulty = config.difficulties.find((d) => d.id === difficultyId);
  if (!difficulty) throw new Error(`No difficulty ${difficultyId}`);
  return difficulty.ladder;
}
