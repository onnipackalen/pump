/**
 * npm run hammer: fires overlapping requests at a running server, then checks
 * that the ledger still adds up.
 *
 *   npm run hammer
 *       Starts its own server (a separate process, on a free port, with a
 *       fresh database file), hammers it over real HTTP, and stops it.
 *
 *   npm run hammer -- --url=http://localhost:3000 --db=data/pump.db
 *       Hammers a server you already have running. --db must come with
 *       --url: it is that server's SQLite file (its DATABASE_PATH), opened
 *       read-only for the final check. Through npm, a relative path starts
 *       in apps/server, where data/pump.db is the server's own default.
 *
 *   --players=20 --rounds=8     how hard to hit it (these are the defaults)
 *
 * What it does. Many players play at once. Every step of every round is a
 * burst of requests sent at the same moment for the same balloon:
 *
 *   - the same request twice with one idempotency key (a double click, or a
 *     retry after a timeout): both must get the very same answer, and the
 *     action must happen once;
 *   - two different requests made from the same screen, for example Pump and
 *     Cash Out, or two Pumps: exactly one may succeed, the other gets a 409;
 *   - several "start a round" requests at once: one round, one set of bets.
 *
 * First comes the storm: one moment with well over 1,000 requests in flight
 * at once. Every player starts a three-balloon round, and then every request
 * for every balloon of every player goes out together, in two waves (see
 * stormWave). Then the players play their rounds, step by step. Each one
 * bets only what its balance covers, and a player whose balance cannot
 * cover the smallest bet stops playing.
 *
 * Every round in every answer is also checked: no balloon shows a reveal
 * ("where it would have popped") while its round is still in progress.
 *
 * Then it reads the database. First it makes sure the file is the one the
 * server uses: each player of this run has a client seed no other run uses
 * (see RUN_TAG), and the file must hold exactly those players. Only then
 * does it run the full reconcile: every balance equals the sum of its
 * ledger rows, the ledger chain is unbroken, every balloon was charged and
 * paid exactly what its round says, and every finished round holds exactly
 * the reveals it should.
 *
 * It exits with an error if anything is wrong.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve as fullPath } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GAME_CONFIG } from '@pump/engine';
import { z } from 'zod';
import { int, text } from '../src/db/rows';
import { reconcile, type ReconcileReport } from '../src/services/reconcile';

// The parts of the server's answers this script reads. Every answer is
// checked against these, so a malformed answer fails the run.
const roundShape = z.object({
  id: z.string(),
  status: z.enum(['active', 'finished']),
  balloons: z.array(
    z.object({
      index: z.int(),
      status: z.enum(['active', 'popped', 'cashed', 'refunded']),
      rung: z.int(),
      drawIndex: z.int(),
      afterRound: z
        .object({
          outcome: z.enum(['popped', 'top']),
          reachedRung: z.int(),
          reachedMultiplierHundredths: z.int(),
        })
        .nullable(),
    }),
  ),
});
type RoundView = z.infer<typeof roundShape>;
const walletShape = z.object({ balanceCents: z.int() });
const successShape = z.object({ round: roundShape });
/** A successful start, pump or cash-out, and GET /api/session, carry the wallet. */
const walletAnswerShape = z.object({ wallet: walletShape });
const refusalShape = z.object({ error: z.object({ round: roundShape.nullish() }) });
/** A 402 refusal carries the wallet as it is once the request was refused. */
const refusalWalletShape = z.object({ error: z.object({ wallet: walletShape }) });
const sessionShape = z.object({
  wallet: walletShape,
  activeRound: roundShape.nullable(),
});

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function wholeOption(name: string, fallback: number): number {
  const given = option(name);
  if (given === undefined) return fallback;
  const value = Number(given);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`--${name} must be a whole number of at least 1`);
  }
  return value;
}

/** Every option this script takes. */
const OPTIONS = ['url', 'db', 'players', 'rounds'] as const;

/**
 * Stops the run when an option it was given did not arrive, instead of
 * quietly hammering a fresh server of its own and saying PASS. That happens
 * when the options are not after `--`: npm then keeps them for itself (it
 * warns "Unknown cli config" and puts them in npm_config_<name>). A
 * misspelt option, or --db without --url, would be ignored the same way.
 */
function checkOptions(): void {
  const unknown = process.argv
    .slice(2)
    .filter((arg) => !OPTIONS.some((name) => arg.startsWith(`--${name}=`)));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option ${unknown.join(' ')}. The options are --url=, --db=, --players= and --rounds=.`,
    );
  }
  const keptByNpm = OPTIONS.filter(
    (name) => process.env[`npm_config_${name}`] !== undefined && option(name) === undefined,
  );
  if (keptByNpm.length > 0) {
    throw new Error(
      `npm kept --${keptByNpm.join(', --')} for itself, so the hammer never got ${
        keptByNpm.length > 1 ? 'them' : 'it'
      }. Put the options after --, like this: npm run hammer -- --url=http://localhost:3000 --db=data/pump.db`,
    );
  }
  if (option('db') !== undefined && option('url') === undefined) {
    throw new Error(
      '--db is the database of the server given by --url. Without --url the hammer starts its own server on a fresh database.',
    );
  }
  // Without it the final check would read some other file and could pass
  // about a database this run never touched.
  if (option('url') !== undefined && option('db') === undefined) {
    throw new Error(
      '--url needs --db: the SQLite file that server was started with (its DATABASE_PATH), which the final check reads. ' +
        'Like this: npm run hammer -- --url=http://localhost:3000 --db=data/pump.db',
    );
  }
}

checkOptions();
const PLAYERS = wholeOption('players', 20);
const ROUNDS = wholeOption('rounds', 8);

/**
 * This run's mark, random so that no other run has it. Each player's client
 * seed is this mark and the player's number, so the final check can find
 * exactly this run's players in the database. (A client seed is 1 to 64
 * characters from A-Z, a-z, 0-9, _ and -. These are at most 40 long.)
 */
const RUN_TAG = `hammer-${String(process.pid)}-${randomBytes(4).toString('hex')}`;

/** Balloons in each player's storm round: the most a round may have. */
const STORM_BALLOONS = GAME_CONFIG.limits.maxBalloons;
/**
 * Different requests each balloon gets in a storm wave, each sent twice: as
 * many as it takes for the first wave to have at least 1,000 in flight at
 * once, whatever --players says.
 */
const STORM_PER_BALLOON = Math.max(3, Math.ceil(1000 / (PLAYERS * STORM_BALLOONS * 2)));
/** The storm is played on the ladder whose first pump pops least, so most balloons reach wave two. */
const STORM_DIFFICULTY = [...GAME_CONFIG.difficulties].sort(
  (a, b) => (a.ladder[0] ?? 0) - (b.ladder[0] ?? 0),
)[0];
/** Each storm bet, in cents: $1, or the smallest bet allowed if that is more. */
const STORM_BET_CENTS = Math.max(100, GAME_CONFIG.limits.minBetCents);

// --- counting -------------------------------------------------------------

let fired = 0;
let inFlight = 0;
/** The most requests a storm wave put in flight at the same moment. */
let stormPeak = 0;
const statusCounts = new Map<number, number>();
const failures: string[] = [];
const checks = {
  pairs: 0,
  repeats: 0,
  starts: 0,
  /** Groups of four starts all refused, rightly, because the balance did not cover the bets. */
  unaffordableStarts: 0,
  refusedSeedChanges: 0,
  rounds: 0,
};
/**
 * Each reveal seen on a finished round, once: round id and balloon index. The
 * same reveal comes back in the winning answer, its repeat and every late 409,
 * so counting answers would count it several times.
 */
const revealsSeen = new Set<string>();

function fail(message: string): void {
  if (failures.length < 25) failures.push(message);
}

// --- a tiny HTTP client ---------------------------------------------------

interface Answer {
  readonly status: number;
  /** The raw body text, to compare two answers byte for byte. */
  readonly raw: string;
  readonly json: unknown;
}

let baseUrl = '';

async function send(
  cookie: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: object,
  key?: string,
): Promise<Answer & { setCookie: string | null }> {
  fired += 1;
  inFlight += 1;
  try {
    const response = await fetch(baseUrl + path, {
      method,
      headers: {
        ...(cookie === '' ? {} : { cookie }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    statusCounts.set(response.status, (statusCounts.get(response.status) ?? 0) + 1);
    if (response.status >= 500) fail(`${method} ${path} answered ${String(response.status)}: ${raw}`);
    const json: unknown = raw === '' ? null : JSON.parse(raw);
    return { status: response.status, raw, json, setCookie: response.headers.get('set-cookie') };
  } finally {
    inFlight -= 1;
  }
}

/** The round carried by an answer: a success holds it, and so does a 409. */
function roundIn(answer: Answer): RoundView | null {
  const round =
    answer.status === 200
      ? successShape.parse(answer.json).round
      : (refusalShape.parse(answer.json).error.round ?? null);
  if (round !== null) {
    // A reveal exists only once the round is over.
    checks.rounds += 1;
    const shown = round.balloons.filter((balloon) => balloon.afterRound !== null).length;
    if (round.status === 'active' && shown > 0) {
      fail(`round ${round.id}: a reveal was shown while the round was in progress`);
    }
    if (round.status === 'finished') {
      for (const balloon of round.balloons) {
        if (balloon.afterRound !== null) revealsSeen.add(`${round.id}:${String(balloon.index)}`);
      }
    }
  }
  return round;
}

// --- one player -----------------------------------------------------------

let keyCounter = 0;
const newKey = (): string => `hammer-${String(process.pid)}-${String(keyCounter++)}`;

/** A small repeatable generator, so every player plays differently but the same on each run. */
function generator(seed: number): (below: number) => number {
  let state = seed >>> 0;
  return (below) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % below;
  };
}

const BETS = [10, 11, 99, 100, 250, 1234, 5000, 100_000] as const;

class Player {
  cookie = '';
  /** Unique to this run (see RUN_TAG), so the final check can find this player. */
  readonly clientSeed: string;
  /**
   * The balance the server last reported, in cents. Bets are picked so that
   * it covers them. In the storm a player's balloons are played at the same
   * time, so the last answer to arrive may not be the latest; finishRound
   * reads the session after the storm, which puts it right.
   */
  balanceCents = 0;
  /** Set once this player's balance cannot cover a bet. They play no more rounds. */
  outOfMoney = false;
  private readonly pick: (below: number) => number;

  constructor(readonly number: number) {
    this.pick = generator(1000 + number);
    this.clientSeed = `${RUN_TAG}-${String(number)}`;
  }

  /** Keeps the balance a successful answer carries. */
  private noteBalance(answer: Answer): void {
    if (answer.status === 200) {
      this.balanceCents = walletAnswerShape.parse(answer.json).wallet.balanceCents;
    }
  }

  async join(): Promise<void> {
    const first = await send('', 'GET', '/api/session');
    const token = /pump_player=[^;]+/.exec(first.setCookie ?? '')?.[0];
    if (first.status !== 200 || !token) {
      fail(`player ${String(this.number)} could not join`);
      return;
    }
    this.cookie = token;
    this.noteBalance(first);
    const seeded = await send(
      this.cookie,
      'PUT',
      '/api/fairness/client-seed',
      { clientSeed: this.clientSeed },
      newKey(),
    );
    if (seeded.status !== 200) {
      fail(`player ${String(this.number)} could not set a client seed (${String(seeded.status)})`);
    }
  }

  private pump(round: RoundView, balloonIndex: number, drawIndex: number, patch: boolean, key: string) {
    return send(
      this.cookie,
      'POST',
      `/api/rounds/${round.id}/pump`,
      { balloonIndex, expectedDrawIndex: drawIndex, patch },
      key,
    );
  }

  private cashOut(round: RoundView, balloonIndex: number, drawIndex: number, key: string) {
    return send(
      this.cookie,
      'POST',
      `/api/rounds/${round.id}/cash-out`,
      { balloonIndex, expectedDrawIndex: drawIndex },
      key,
    );
  }

  /**
   * Several different requests for one balloon, all made from the same
   * screen and sent together, each also sent twice with its own key.
   * Exactly one of the different requests may succeed. Returns the round as
   * it is afterwards.
   */
  private async burst(
    label: string,
    requests: readonly ((key: string) => Promise<Answer>)[],
  ): Promise<RoundView | null> {
    const keys = requests.map(() => newKey());
    const answers = await Promise.all(
      requests.flatMap((request, i) => [request(keys[i] ?? ''), request(keys[i] ?? '')]),
    );
    const firsts = requests.map((_, i) => answers[i * 2]);
    const repeats = requests.map((_, i) => answers[i * 2 + 1]);

    firsts.forEach((first, i) => {
      const repeat = repeats[i];
      checks.repeats += 1;
      if (!first || !repeat || first.status !== repeat.status || first.raw !== repeat.raw) {
        fail(`${label}: the same key got two different answers`);
      }
    });

    const winners = firsts.filter((answer) => answer?.status === 200);
    checks.pairs += 1;
    if (winners.length !== 1) {
      fail(
        `${label}: ${String(winners.length)} of ${String(requests.length)} same-moment requests ` +
          `succeeded (statuses ${firsts.map((answer) => String(answer?.status)).join(', ')})`,
      );
    }
    for (const loser of firsts) {
      // 409: the balloon had moved on. 402: a Patch the balance cannot cover.
      if (loser && ![200, 402, 409].includes(loser.status)) {
        fail(`${label}: a losing request got ${String(loser.status)}: ${loser.raw}`);
      }
    }
    // Every answer that carries a round is checked, the losers' too.
    for (const answer of answers) {
      if (answer !== winners[0] && (answer.status === 200 || answer.status === 409)) roundIn(answer);
    }
    const winner = winners[0];
    if (!winner) return null;
    // The losers changed nothing, so the winner's wallet is the balance now.
    this.noteBalance(winner);
    return roundIn(winner);
  }

  private async startRound(): Promise<RoundView | null> {
    const difficulty = GAME_CONFIG.difficulties[this.pick(GAME_CONFIG.difficulties.length)];
    // One to three bets, each covered by what is left of the balance.
    const wanted = 1 + this.pick(3);
    const betsCents: number[] = [];
    let left = this.balanceCents;
    for (let i = 0; i < wanted; i += 1) {
      const fits = BETS.filter((bet) => bet <= left);
      const bet = fits.length > 0 ? fits[this.pick(fits.length)] : undefined;
      if (bet === undefined) break;
      betsCents.push(bet);
      left -= bet;
    }
    if (betsCents.length === 0) {
      // Not even the smallest bet fits, so this player stops playing.
      this.outOfMoney = true;
      return null;
    }
    const body = { difficultyId: difficulty?.id ?? 'easy', betsCents };
    // Four starts at once, with four different keys: one round, one set of bets.
    const answers = await Promise.all(
      [newKey(), newKey(), newKey(), newKey()].map((key) =>
        send(this.cookie, 'POST', '/api/rounds', body, key),
      ),
    );
    checks.starts += 1;
    if (answers.every((answer) => answer.status === 402)) {
      await this.checkUnaffordable(answers, betsCents);
      return null;
    }
    const started = answers.filter((answer) => answer.status === 200);
    if (started.length !== 1) {
      fail(`player ${String(this.number)}: ${String(started.length)} of 4 simultaneous starts succeeded`);
    }
    for (const answer of answers) {
      if (answer.status !== 200 && answer.status !== 409) {
        fail(`player ${String(this.number)}: a losing start got ${String(answer.status)}: ${answer.raw}`);
      }
    }
    const winner = started[0];
    if (!winner) return null;
    this.noteBalance(winner);
    return roundIn(winner);
  }

  /**
   * All four starts were refused with 402. Bets are picked to fit the
   * balance the server last reported, so this should not happen; if it
   * does, the refusals are right only if the balance really is below the
   * bets and they charged nothing. Each refusal says what the balance was
   * once it was refused, and all four must match the balance read
   * afterwards. Either way this player stops playing.
   */
  private async checkUnaffordable(answers: readonly Answer[], betsCents: readonly number[]): Promise<void> {
    const costCents = betsCents.reduce((sum, bet) => sum + bet, 0);
    const told = answers.map((answer) => refusalWalletShape.parse(answer.json).error.wallet.balanceCents);
    const after = await this.balance();
    const wrong = [
      ...(after !== null && after >= costCents
        ? [`the balance of ${String(after)} covers the bets of ${String(costCents)}`]
        : []),
      ...(after === null || told.some((balance) => balance !== after)
        ? [`the refusals said the balance was ${told.join(', ')} and afterwards it was ${String(after)}`]
        : []),
    ];
    if (wrong.length > 0) {
      fail(
        `player ${String(this.number)}: all 4 simultaneous starts were refused for want of money, ` +
          `but ${wrong.join(', and ')}`,
      );
    } else {
      checks.unaffordableStarts += 1;
    }
    this.outOfMoney = true;
  }

  async playRound(): Promise<void> {
    let round = await this.startRound();
    for (let step = 0; step < 80 && round?.status === 'active'; step += 1) {
      const live = round.balloons.filter((balloon) => balloon.status === 'active');
      const balloon = live[this.pick(live.length)];
      if (!balloon) break;
      const current: RoundView = round;
      const { index, drawIndex } = balloon;
      const label = `player ${String(this.number)} round ${current.id} balloon ${String(index)}`;
      const choice = this.pick(10);

      if (step === 1) {
        // Seeds must not change while a round is in progress.
        const rotate = await send(this.cookie, 'POST', '/api/fairness/rotate', undefined, newKey());
        checks.refusedSeedChanges += 1;
        if (rotate.status !== 409) fail(`${label}: rotating mid-round got ${String(rotate.status)}`);
      }

      let after: RoundView | null;
      if (balloon.rung === 0 || choice < 3) {
        // Two pumps from the same screen.
        after = await this.burst(label, [
          (key) => this.pump(current, index, drawIndex, false, key),
          (key) => this.pump(current, index, drawIndex, false, key),
        ]);
      } else if (choice < 6) {
        // Pump and Cash Out from the same screen.
        after = await this.burst(label, [
          (key) => this.pump(current, index, drawIndex, false, key),
          (key) => this.cashOut(current, index, drawIndex, key),
        ]);
      } else if (choice < 8) {
        // A Patch + pump, a plain pump and a cash-out, all at once.
        after = await this.burst(label, [
          (key) => this.cashOut(current, index, drawIndex, key),
          (key) => this.pump(current, index, drawIndex, true, key),
          (key) => this.pump(current, index, drawIndex, false, key),
        ]);
      } else {
        // Two cash-outs: the balloon must be paid once.
        after = await this.burst(label, [
          (key) => this.cashOut(current, index, drawIndex, key),
          (key) => this.cashOut(current, index, drawIndex, key),
        ]);
      }
      if (!after) break;
      round = after;
    }
  }

  async balance(): Promise<number | null> {
    const answer = await send(this.cookie, 'GET', '/api/session');
    if (answer.status !== 200) return null;
    this.balanceCents = sessionShape.parse(answer.json).wallet.balanceCents;
    return this.balanceCents;
  }

  /** This player's round in progress, as the server has it now, or null. */
  async currentRound(): Promise<RoundView | null> {
    const answer = await send(this.cookie, 'GET', '/api/session');
    if (answer.status !== 200) {
      fail(`player ${String(this.number)}: GET /api/session answered ${String(answer.status)}`);
      return null;
    }
    this.noteBalance(answer);
    const round = sessionShape.parse(answer.json).activeRound;
    return round === null ? null : roundIn({ ...answer, json: { round } });
  }

  /** Starts this player's storm round: STORM_BALLOONS balloons of STORM_BET_CENTS. */
  async startStormRound(): Promise<void> {
    const body = {
      difficultyId: STORM_DIFFICULTY?.id ?? 'easy',
      betsCents: Array.from({ length: STORM_BALLOONS }, () => STORM_BET_CENTS),
    };
    const answer = await send(this.cookie, 'POST', '/api/rounds', body, newKey());
    if (answer.status !== 200) {
      fail(`player ${String(this.number)}: the storm round did not start (${String(answer.status)})`);
    }
    this.noteBalance(answer);
  }

  /**
   * One storm wave for this player: for every balloon still in play,
   * STORM_PER_BALLOON different requests made from the same screen, each
   * sent twice with its own key, all at once (burst). On a balloon not
   * pumped yet they are all pumps, since nothing can be cashed out before
   * the first pump. On a pumped balloon they mix Cash Out, Pump and
   * Patch + Pump. Each balloon's group must have exactly one winner.
   *
   * Every request is sent before this returns its promise: `send` counts a
   * request as in flight before its first await. So when the waves of all
   * players are started in one go, all of their requests are in flight
   * together.
   */
  stormWave(round: RoundView | null, wave: number): Promise<unknown> {
    if (round === null) return Promise.resolve();
    const live = round.balloons.filter((balloon) => balloon.status === 'active');
    return Promise.all(
      live.map(({ index, drawIndex, rung }) => {
        const label = `storm wave ${String(wave)}: player ${String(this.number)} round ${round.id} balloon ${String(index)}`;
        const requests = Array.from({ length: STORM_PER_BALLOON }, (_, i) => {
          const kind = rung === 0 ? 1 : i % 3;
          if (kind === 0) return (key: string) => this.cashOut(round, index, drawIndex, key);
          return (key: string) => this.pump(round, index, drawIndex, kind === 2, key);
        });
        return this.burst(label, requests);
      }),
    );
  }

  /**
   * Ends this player's round in progress, one balloon at a time: a balloon
   * never pumped is pumped once, a pumped one is cashed out.
   */
  async finishRound(): Promise<void> {
    for (let step = 0; step < 4 * STORM_BALLOONS; step += 1) {
      const round = await this.currentRound();
      const balloon = round?.balloons.find((b) => b.status === 'active');
      if (!round || !balloon) return;
      const answer =
        balloon.rung === 0
          ? await this.pump(round, balloon.index, balloon.drawIndex, false, newKey())
          : await this.cashOut(round, balloon.index, balloon.drawIndex, newKey());
      if (answer.status !== 200) {
        fail(`player ${String(this.number)}: finishing the storm round got ${String(answer.status)}`);
        return;
      }
      this.noteBalance(answer);
      roundIn(answer);
    }
    fail(`player ${String(this.number)}: the storm round did not finish`);
  }
}

// --- the server under test --------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (typeof address === 'object' && address !== null) resolve(address.port);
        else reject(new Error('could not find a free port'));
      });
    });
  });
}

async function waitUntilUp(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The server at ${url} did not come up`);
}

interface Target {
  readonly url: string;
  readonly databasePath: string;
  readonly child: ChildProcess | null;
}

async function target(): Promise<Target> {
  const url = option('url');
  if (url !== undefined) {
    // checkOptions has made sure --db came with it.
    const databasePath = option('db');
    if (databasePath === undefined) throw new Error('--url needs --db');
    return { url: url.replace(/\/$/, ''), databasePath: fullPath(databasePath), child: null };
  }
  const port = await freePort();
  const databasePath = join(mkdtempSync(join(tmpdir(), 'pump-hammer-')), 'hammer.db');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: databasePath },
    stdio: 'ignore',
  });
  return { url: `http://127.0.0.1:${String(port)}`, databasePath, child };
}

// --- the final check ------------------------------------------------------

/** What the final check read from the database, or why it read nothing. */
type Books =
  | { readonly ok: false; readonly why: string }
  | {
      readonly ok: true;
      readonly report: ReconcileReport;
      /** Every stored balance added up, in cents. */
      readonly storedTotal: number;
      /** Players whose stored balance is below zero. */
      readonly negative: number;
    };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Why the database is not the one the server under test uses, or null if
 * it is. It must hold each of this run's players exactly once, found by
 * their client seeds (see RUN_TAG), and no other player with this run's tag.
 */
function notThisRun(db: DatabaseSync, path: string, players: readonly Player[]): string | null {
  const prefix = `${RUN_TAG}-`;
  let seeds: string[];
  try {
    seeds = db
      .prepare('SELECT client_seed FROM players WHERE substr(client_seed, 1, :length) = :prefix')
      .all({ length: prefix.length, prefix })
      .map((row) => text(row, 'client_seed'));
  } catch (error) {
    return `Could not read the players in ${path}: ${messageOf(error)}.`;
  }
  const ours = new Set(players.map((player) => player.clientSeed));
  const found = new Set(seeds.filter((seed) => ours.has(seed)));
  if (found.size === ours.size && seeds.length === ours.size) return null;
  if (found.size === 0) {
    return `${path} holds none of this run's ${String(ours.size)} players, so it is not the database of the server that was hammered.`;
  }
  return (
    `${path} should hold each of this run's ${String(ours.size)} players once, ` +
    `but holds ${String(found.size)} of them in ${String(seeds.length)} rows.`
  );
}

/**
 * Reads the books from the database file, read-only. First it makes sure
 * the file is the one the server under test uses (notThisRun). Another
 * server's database, or an older one, says nothing about this run, so then
 * nothing more is read.
 */
function readBooks(path: string, players: readonly Player[]): Books {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    return { ok: false, why: `Could not open the database ${path}: ${messageOf(error)}.` };
  }
  try {
    const why = notThisRun(db, path, players);
    if (why !== null) return { ok: false, why };
    const report = reconcile(db);
    // COALESCE: a sum over no rows is NULL, not 0.
    const total = db.prepare('SELECT COALESCE(SUM(balance_cents), 0) AS total FROM players').get();
    const negative = db.prepare('SELECT COUNT(*) AS n FROM players WHERE balance_cents < 0').get();
    return {
      ok: true,
      report,
      storedTotal: total ? int(total, 'total') : -1,
      negative: negative ? int(negative, 'n') : -1,
    };
  } finally {
    db.close();
  }
}

// --- run ------------------------------------------------------------------

function line(label: string, ok: boolean, detail: string): void {
  console.log(`  ${label} ${'.'.repeat(Math.max(3, 58 - label.length))} ${ok ? 'PASS' : 'FAIL'}  ${detail}`);
}

const started = performance.now();
const server = await target();
baseUrl = server.url;
console.log('Pump: hammer');
console.log(
  server.child
    ? `Server: started for this run at ${server.url}, database ${server.databasePath}`
    : `Server: yours, at ${server.url}, database ${server.databasePath}`,
);

async function run(): Promise<number> {
  await waitUntilUp(server.url);

  const players = Array.from({ length: PLAYERS }, (_, i) => new Player(i + 1));
  await Promise.all(players.map((player) => player.join()));

  // The storm. Each wave starts every player's requests in one go, so they
  // are all in flight at the same moment (see stormWave).
  await Promise.all(players.map((player) => player.startStormRound()));
  for (let wave = 1; wave <= 2; wave += 1) {
    const rounds = await Promise.all(players.map((player) => player.currentRound()));
    const inFlightBefore = inFlight;
    const waveDone = Promise.all(players.map((player, i) => player.stormWave(rounds[i] ?? null, wave)));
    stormPeak = Math.max(stormPeak, inFlight - inFlightBefore);
    await waveDone;
  }
  await Promise.all(players.map((player) => player.finishRound()));
  const stormFired = fired;

  // Everyone plays at once; within each player, every step is a burst. A
  // player whose balance no longer covers a bet stops.
  await Promise.all(
    players.map(async (player) => {
      for (let round = 0; round < ROUNDS && !player.outOfMoney; round += 1) await player.playRound();
    }),
  );
  const balances = await Promise.all(players.map((player) => player.balance()));
  const stopped = players.filter((player) => player.outOfMoney).length;

  console.log(
    `Fired ${fired.toLocaleString('en-US')} requests from ${String(PLAYERS)} players: ` +
      `${stormFired.toLocaleString('en-US')} in the storm, with up to ${stormPeak.toLocaleString('en-US')} ` +
      `in flight at once, then the rest round by round.`,
  );
  console.log(
    `Answers: ${[...statusCounts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([status, n]) => `${String(status)} x ${n.toLocaleString('en-US')}`)
      .join(', ')}`,
  );
  if (stopped > 0) {
    console.log(
      `${String(stopped)} of ${String(PLAYERS)} players stopped early: their balance could no longer cover a bet.`,
    );
  }

  // The final check reads the server's own database file, read-only, once
  // it is sure the file is that server's (see readBooks).
  const books = readBooks(server.databasePath, players);
  const seenTotal = balances.reduce<number>((sum, balance) => sum + (balance ?? 0), 0);
  const before = failures.length;

  console.log('');
  line(
    'At least 1,000 requests were in flight at the same moment',
    stormPeak >= 1000,
    `${stormPeak.toLocaleString('en-US')} at once, ${fired.toLocaleString('en-US')} fired in all`,
  );
  line('The server never answered with a 5xx', ![...statusCounts.keys()].some((s) => s >= 500), '');
  line(
    'A repeated key always got the same answer',
    !failures.some((f) => f.includes('same key')),
    `${checks.repeats.toLocaleString('en-US')} double sends`,
  );
  line(
    'Exactly one of each same-moment group succeeded',
    !failures.some((f) => f.includes('same-moment') || f.includes('losing request')),
    `${checks.pairs.toLocaleString('en-US')} groups`,
  );
  line(
    'One round from four simultaneous starts',
    !failures.some((f) => f.includes('simultaneous starts') || f.includes('losing start')),
    `${checks.starts.toLocaleString('en-US')} times` +
      (checks.unaffordableStarts > 0
        ? `, ${checks.unaffordableStarts.toLocaleString('en-US')} of them all refused: the balance was too low`
        : ''),
  );
  line(
    'Seeds could not be rotated mid-round',
    !failures.some((f) => f.includes('rotating mid-round')),
    `${checks.refusedSeedChanges.toLocaleString('en-US')} tries`,
  );
  line(
    'No reveal was shown while its round was in progress',
    !failures.some((f) => f.includes('reveal was shown')),
    `${checks.rounds.toLocaleString('en-US')} rounds seen, ${revealsSeen.size.toLocaleString('en-US')} reveals on finished ones`,
  );
  line(
    "The database holds exactly this run's players",
    books.ok,
    books.ok ? `${String(PLAYERS)} found by client seed` : 'so its books were not checked',
  );
  if (books.ok) {
    line('No balance is below zero', books.negative === 0, '');
    line(
      'Balances the players see equal the stored balances',
      !server.child || seenTotal === books.storedTotal,
      server.child
        ? `$${(books.storedTotal / 100).toLocaleString('en-US')} in total`
        : 'skipped: other players exist',
    );
    line(
      'The ledger reconciles',
      books.report.problems.length === 0,
      `${String(books.report.players)} players, ${books.report.ledgerRows.toLocaleString('en-US')} ledger rows, ` +
        `${books.report.rounds.toLocaleString('en-US')} rounds`,
    );
  }

  const problems = [
    // First, as nothing about the books can be said without it.
    ...(books.ok
      ? []
      : [
          books.why +
            (server.child ? '' : ' Is --db the file that server was started with (its DATABASE_PATH)?'),
        ]),
    ...failures,
    ...(books.ok ? books.report.problems : []),
    ...(stormPeak >= 1000 ? [] : ['fewer than 1,000 requests were in flight at the same moment']),
    ...(books.ok && server.child && seenTotal !== books.storedTotal
      ? [`players see ${String(seenTotal)} cents in total but the database holds ${String(books.storedTotal)}`]
      : []),
  ];
  if (problems.length > 0) {
    console.log('');
    for (const problem of problems.slice(0, 25)) console.log(`  - ${problem}`);
    if (failures.length > before) console.log('  (more were found while checking)');
  }

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log('');
  console.log(
    problems.length === 0
      ? `RESULT: PASS. The wallet held under overlapping requests. (${seconds}s)`
      : `RESULT: FAIL. ${String(problems.length)} problem(s). (${seconds}s)`,
  );
  return problems.length === 0 ? 0 : 1;
}

const exitCode = await run().finally(() => server.child?.kill('SIGTERM'));
process.exit(exitCode);
