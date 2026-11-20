/**
 * npm run sim: plays millions of rounds through the real engine.
 *
 * For each difficulty it prints the RTP it measured, the hit rate, the
 * volatility and the biggest win, and PASS or FAIL. It exits with an error if
 * anything fails.
 *
 *   npm run sim                      10 million rounds per difficulty
 *   npm run sim -- --rounds=200000   a quicker run
 *   npm run sim -- --seed=7          a different stream of rolls
 *   npm run sim -- --serial          one difficulty at a time, in one process
 *
 * How a run is judged. Luck moves a simulated RTP, and it moves it a lot on
 * ladders with rare huge prizes. So the result is not compared with the bare
 * RTP. It is compared with the exact RTP of the way the simulator plays
 * (cli/simulate.ts), which the proof code works out with cent rounding
 * included, and it must land within 4 standard errors of it. Each pump's
 * survival count must also land within 5 standard errors of its exact chance.
 * The first pump is the only one the RTP sets, so its count alone shows the
 * RTP to within a few hundredths of a point.
 *
 * The difficulties run side by side, one process each, to save time. The
 * result does not depend on that: each difficulty has its own seed.
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertValidConfig, GAME_CONFIG } from '../src/index';
import { compare, percent } from './fraction';
import { createRng } from './prng';
import { rtpOf } from './proof';
import { PATCH_ONE_IN, report, SIM_BETS, simulate, type SimResult } from './simulate';

const RTP_LIMIT = 4;
const PUMP_LIMIT = 5;

function option(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const given = process.argv.find((arg) => arg.startsWith(prefix));
  if (given === undefined) return fallback;
  const value = Number(given.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`--${name} must be a whole number`);
  }
  return value;
}

function dollars(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString('en-US');
  return `$${whole}.${String(cents % 100).padStart(2, '0')}`;
}

const pct = (value: number, digits = 2): string => `${(value * 100).toFixed(digits)}%`;
const count = (value: number): string => value.toLocaleString('en-US');

const config = GAME_CONFIG;
const rounds = Math.max(1, option('rounds', 10_000_000));
const seed = option('seed', 1);
const only = option('only', -1);
const rtp = rtpOf(config.rtpBp);

/** One difficulty, in this process. Each difficulty gets its own seed. */
function play(index: number): SimResult {
  const difficulty = config.difficulties[index];
  if (difficulty === undefined) throw new RangeError(`There is no difficulty ${String(index)}`);
  return simulate(config, difficulty, rounds, createRng(seed + index));
}

function isSimResult(value: unknown): value is SimResult {
  return typeof value === 'object' && value !== null && 'rounds' in value && 'pumps' in value;
}

/** One difficulty, in a process of its own. */
function playApart(index: number): Promise<SimResult> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), [
      `--only=${String(index)}`,
      `--rounds=${String(rounds)}`,
      `--seed=${String(seed)}`,
    ]);
    let answered = false;
    child.on('message', (message) => {
      if (!isSimResult(message)) return;
      answered = true;
      resolve(message);
    });
    child.on('error', reject);
    child.on('exit', () => {
      if (!answered) reject(new Error(`The process for difficulty ${String(index)} ended early`));
    });
  });
}

async function playAll(): Promise<readonly SimResult[]> {
  const indexes = config.difficulties.map((_, index) => index);
  if (process.argv.includes('--serial')) return indexes.map(play);
  try {
    return await Promise.all(indexes.map(playApart));
  } catch {
    // Starting extra processes is only a speed-up. Without it, play in this one.
    return indexes.map(play);
  }
}

function print(results: readonly SimResult[], seconds: string): number {
  let failures = 0;
  const verdict = (ok: boolean): string => {
    if (!ok) failures += 1;
    return ok ? 'PASS' : 'FAIL';
  };

  config.difficulties.forEach((difficulty, index) => {
    const result = results[index];
    if (result === undefined) throw new Error('A difficulty has no result');
    const stats = report(config, difficulty, result);
    const { biggest } = result;
    const multiple = (difficulty.ladder[biggest.rung - 1] ?? 0) / 100;

    console.log('');
    console.log(
      `${difficulty.label}: ${count(result.rounds)} rounds, ${count(result.balloons)} balloons, ` +
        `${count(result.patchesBought)} Patches`,
    );
    const rtpOk = Math.abs(stats.z) <= RTP_LIMIT && compare(stats.expectedRtp, rtp) <= 0;
    console.log(
      `  RTP           ${pct(stats.rtp, 3)} simulated; ${percent(stats.expectedRtp, 3)} is the ` +
        'exact figure for this way of playing',
    );
    console.log(
      `                ${Math.abs(stats.z).toFixed(2)} standard errors apart ` +
        `(one is ${pct(stats.standardError, 3)}) ... ${verdict(rtpOk)}`,
    );
    console.log(`  hit rate      ${pct(stats.hitRate)} of rounds paid out something`);
    console.log(
      `  volatility    ${stats.volatility.toFixed(2)} ` +
        "(standard deviation of a round's payout per $1 paid in)",
    );
    console.log(
      `  biggest win   ${multiple.toLocaleString('en-US')}x: ${dollars(biggest.payoutCents)} ` +
        `on a ${dollars(biggest.betCents)} bet`,
    );
    console.log(
      `  pump counts   worst of ${String(difficulty.ladder.length)} pumps is pump ` +
        `${String(stats.worstPump)}, ${stats.worstPumpZ.toFixed(2)} standard errors from its ` +
        `exact chance ... ${verdict(stats.worstPumpZ <= PUMP_LIMIT)}`,
    );
    console.log(
      `  pump 1 alone  puts the RTP at ${pct(stats.pumpOneRtp, 3)}, ` +
        `give or take ${pct(stats.pumpOneError, 3)}`,
    );
  });

  console.log('');
  console.log(
    failures === 0
      ? `RESULT: PASS. The engine plays as the exact calculation says it should. (${seconds}s)`
      : `RESULT: FAIL. ${String(failures)} check(s) failed. (${seconds}s)`,
  );
  return failures;
}

async function main(): Promise<void> {
  const started = performance.now();
  console.log('Pump: simulator');
  console.log(
    `RTP ${percent(rtp)} (${String(config.rtpBp)} basis points), ` +
      `${count(rounds)} rounds per difficulty, seed ${String(seed)}`,
  );
  console.log(
    `Each round: 1 to ${String(config.limits.maxBalloons)} balloons, ` +
      `bets of ${SIM_BETS.map(dollars).join(', ')}.`,
  );
  console.log(
    'Each balloon aims for a rung (lower rungs more often) and cashes out there; ' +
      `a Patch is bought before 1 pump in ${String(PATCH_ONE_IN)} after the first.`,
  );
  assertValidConfig(config);
  const results = await playAll();
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  process.exitCode = print(results, seconds) === 0 ? 0 : 1;
}

if (only >= 0) {
  // Started by playApart: play one difficulty and hand the counts back.
  process.send?.(play(only));
} else {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
