/**
 * npm run hammer: fires overlapping requests at a running server, then checks
 * that the ledger still adds up.
 *
 *   npm run hammer
 *       Starts its own server (a separate process, on a free port, with a
 *       fresh database file), hammers it over real HTTP, and stops it.
 *
 *   npm run hammer -- --url=http://localhost:3000 --db=data/pump.db
 *       Hammers a server you already have running. --db is that server's
 *       SQLite file, which is opened read-only for the final check.
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
 * Every round in every answer is also checked: no balloon shows a reveal
 * ("where it would have popped") while its round is still in progress.
 *
 * Then it reads the database and runs the full reconcile: every balance
 * equals the sum of its ledger rows, the ledger chain is unbroken, every
 * balloon was charged and paid exactly what its round says, and every
 * finished round holds exactly the reveals it should.
 *
 * It exits with an error if anything is wrong.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GAME_CONFIG } from '@pump/engine';
import { z } from 'zod';
import { int } from '../src/db/rows';
import { reconcile } from '../src/services/reconcile';

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
const successShape = z.object({ round: roundShape });
const refusalShape = z.object({ error: z.object({ round: roundShape.nullish() }) });
const sessionShape = z.object({ wallet: z.object({ balanceCents: z.int() }) });

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

const PLAYERS = wholeOption('players', 20);
const ROUNDS = wholeOption('rounds', 8);

// --- counting -------------------------------------------------------------

let fired = 0;
let inFlight = 0;
let peakInFlight = 0;
const statusCounts = new Map<number, number>();
const failures: string[] = [];
const checks = { pairs: 0, repeats: 0, starts: 0, refusedSeedChanges: 0, rounds: 0, reveals: 0 };

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
  peakInFlight = Math.max(peakInFlight, inFlight);
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
    if (round.status === 'finished') checks.reveals += shown;
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
  private readonly pick: (below: number) => number;

  constructor(readonly number: number) {
    this.pick = generator(1000 + number);
  }

  async join(): Promise<void> {
    const first = await send('', 'GET', '/api/session');
    const token = /pump_player=[^;]+/.exec(first.setCookie ?? '')?.[0];
    if (first.status !== 200 || !token) {
      fail(`player ${String(this.number)} could not join`);
      return;
    }
    this.cookie = token;
    await send(this.cookie, 'PUT', '/api/fairness/client-seed', { clientSeed: `hammer-${String(this.number)}` }, newKey());
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
    return winner ? roundIn(winner) : null;
  }

  private async startRound(): Promise<RoundView | null> {
    const difficulty = GAME_CONFIG.difficulties[this.pick(GAME_CONFIG.difficulties.length)];
    const betsCents = Array.from({ length: 1 + this.pick(3) }, () => BETS[this.pick(BETS.length)] ?? 10);
    const body = { difficultyId: difficulty?.id ?? 'easy', betsCents };
    // Four starts at once, with four different keys: one round, one set of bets.
    const answers = await Promise.all(
      [newKey(), newKey(), newKey(), newKey()].map((key) =>
        send(this.cookie, 'POST', '/api/rounds', body, key),
      ),
    );
    checks.starts += 1;
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
    return winner ? roundIn(winner) : null;
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
    return answer.status === 200 ? sessionShape.parse(answer.json).wallet.balanceCents : null;
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
    return { url: url.replace(/\/$/, ''), databasePath: option('db') ?? 'data/pump.db', child: null };
  }
  const port = await freePort();
  const databasePath = join(mkdtempSync(join(tmpdir(), 'pump-hammer-')), 'hammer.db');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: databasePath },
    stdio: 'ignore',
  });
  return { url: `http://127.0.0.1:${String(port)}`, databasePath, child };
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
  // Everyone plays at once; within each player, every step is a burst.
  await Promise.all(
    players.map(async (player) => {
      for (let round = 0; round < ROUNDS; round += 1) await player.playRound();
    }),
  );
  const balances = await Promise.all(players.map((player) => player.balance()));

  console.log(
    `Fired ${fired.toLocaleString('en-US')} requests from ${String(PLAYERS)} players, ` +
      `up to ${String(peakInFlight)} in flight at once.`,
  );
  console.log(
    `Answers: ${[...statusCounts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([status, n]) => `${String(status)} x ${n.toLocaleString('en-US')}`)
      .join(', ')}`,
  );

  // The final check reads the server's own database file, read-only.
  const db = new DatabaseSync(server.databasePath, { readOnly: true });
  const report = reconcile(db);
  const storedBalances = db.prepare('SELECT SUM(balance_cents) AS total FROM players').get();
  const negative = db.prepare('SELECT COUNT(*) AS n FROM players WHERE balance_cents < 0').get();
  db.close();

  const seenTotal = balances.reduce<number>((sum, balance) => sum + (balance ?? 0), 0);
  const storedTotal = storedBalances ? int(storedBalances, 'total') : -1;
  const before = failures.length;

  console.log('');
  line('At least 1,000 overlapping requests were fired', fired >= 1000, `${fired.toLocaleString('en-US')} fired`);
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
    `${checks.starts.toLocaleString('en-US')} times`,
  );
  line(
    'Seeds could not be rotated mid-round',
    !failures.some((f) => f.includes('rotating mid-round')),
    `${checks.refusedSeedChanges.toLocaleString('en-US')} tries`,
  );
  line(
    'No reveal was shown while its round was in progress',
    !failures.some((f) => f.includes('reveal was shown')),
    `${checks.rounds.toLocaleString('en-US')} rounds seen, ${checks.reveals.toLocaleString('en-US')} reveals on finished ones`,
  );
  line('No balance is below zero', negative !== undefined && int(negative, 'n') === 0, '');
  line(
    'Balances the players see equal the stored balances',
    !server.child || seenTotal === storedTotal,
    server.child ? `$${(storedTotal / 100).toLocaleString('en-US')} in total` : 'skipped: other players exist',
  );
  line(
    'The ledger reconciles',
    report.problems.length === 0,
    `${String(report.players)} players, ${report.ledgerRows.toLocaleString('en-US')} ledger rows, ` +
      `${report.rounds.toLocaleString('en-US')} rounds`,
  );

  const problems = [
    ...failures,
    ...report.problems,
    ...(fired >= 1000 ? [] : ['fewer than 1,000 requests were fired']),
    ...(server.child && seenTotal !== storedTotal
      ? [`players see ${String(seenTotal)} cents in total but the database holds ${String(storedTotal)}`]
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
