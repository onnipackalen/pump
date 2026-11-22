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
 * How a run is judged. Nothing is measured against the engine itself: every
 * yardstick comes from the rules worked out apart from it (cli/rules.ts).
 *
 * 1. Exactly, with no luck in it. Every pump must make one draw, at the
 *    rules' chance for that pump, and keep the roll it was handed. Every
 *    outcome must follow from that roll, and every payout, Patch charge and
 *    top rung must be the rules' number to the cent. One mismatch in
 *    millions is a FAIL.
 * 2. By counting. Luck moves a simulated RTP, and it moves it a lot on
 *    ladders with rare huge prizes. So the result is compared with the exact
 *    RTP of the way the simulator plays, cent rounding included. Each pump's
 *    survival count is compared with its exact chance. The first pump is the
 *    only one the RTP sets, so its count alone gives the RTP to within a few
 *    hundredths of a point, and is compared with the configured RTP. Each
 *    must land within 6 standard errors. That mark is set for the whole run,
 *    which makes many such checks, not for one check (see PASS_MARK in
 *    cli/simulate.ts).
 *
 * Each difficulty is played two ways (cli/simulate.ts): the main run, which
 * cashes out all over the ladder, and a smaller climb in which every balloon
 * that survives its first pump goes all the way to its top rung. The main run
 * hardly ever gets that high.
 *
 * The difficulties run side by side, one process each, to save time. The
 * result does not depend on that: each difficulty has its own seed.
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertValidConfig, GAME_CONFIG, type Difficulty } from '../src/index';
import { compare, percent, toNumber, type Fr } from './fraction';
import { createRng } from './prng';
import { rtpOf } from './proof';
import {
  climbPlay,
  PASS_MARK,
  PATCH_ONE_IN,
  report,
  SIM_BETS,
  simulate,
  SPREAD,
  type Play,
  type SimResult,
} from './simulate';

/** The main run's exact RTP may sit this far under the configured RTP, from cent rounding. */
const ROUNDING_ROOM = 0.005;
/** The climb plays one round for every this many of the main run, and at least CLIMB_MIN. */
const CLIMB_ONE_IN = 50;
const CLIMB_MIN = 2000;

const OPTIONS = ['rounds', 'seed', 'only'] as const;
const FLAGS = ['serial'] as const;

/** Reads --name=value and --name value. Anything it does not know is an error. */
function readOptions(args: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    const [name, inline] = arg.replace(/^--/, '').split('=', 2);
    if (!arg.startsWith('--') || name === undefined) {
      throw new RangeError(`Unknown option "${arg}"`);
    }
    if ((FLAGS as readonly string[]).includes(name) && inline === undefined) {
      found.set(name, 'yes');
    } else if ((OPTIONS as readonly string[]).includes(name)) {
      const value = inline ?? args[(i += 1)];
      if (value === undefined) throw new RangeError(`--${name} needs a number`);
      found.set(name, value);
    } else {
      throw new RangeError(`Unknown option "${arg}"`);
    }
  }
  return found;
}

function numberOption(options: Map<string, string>, name: string, fallback: number): number {
  const given = options.get(name);
  if (given === undefined) return fallback;
  const value = Number(given);
  if (given.trim() === '' || !Number.isSafeInteger(value) || value < 0) {
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

/** Both ways of playing one difficulty. */
interface Played {
  readonly main: SimResult;
  readonly climb: SimResult;
}

const climbRounds = (rounds: number): number =>
  Math.max(CLIMB_MIN, Math.floor(rounds / CLIMB_ONE_IN));

/** One difficulty, in this process. Each difficulty and each way of playing has its own seed. */
function play(index: number, rounds: number, seed: number): Played {
  const difficulty = config.difficulties[index];
  if (difficulty === undefined) throw new RangeError(`There is no difficulty ${String(index)}`);
  return {
    main: simulate(config, difficulty, rounds, createRng(seed + index), SPREAD),
    climb: simulate(
      config,
      difficulty,
      climbRounds(rounds),
      createRng(seed + 1000 + index),
      climbPlay(config),
    ),
  };
}

function isPlayed(value: unknown): value is Played {
  return typeof value === 'object' && value !== null && 'main' in value && 'climb' in value;
}

/** One difficulty, in a process of its own. */
function playApart(index: number, rounds: number, seed: number): Promise<Played> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), [
      `--only=${String(index)}`,
      `--rounds=${String(rounds)}`,
      `--seed=${String(seed)}`,
    ]);
    let answered = false;
    child.on('message', (message) => {
      if (!isPlayed(message)) return;
      answered = true;
      resolve(message);
    });
    child.on('error', reject);
    child.on('exit', () => {
      if (!answered) reject(new Error(`The process for difficulty ${String(index)} ended early`));
    });
  });
}

async function playAll(rounds: number, seed: number, serial: boolean): Promise<readonly Played[]> {
  const indexes = config.difficulties.map((_, index) => index);
  if (serial) return indexes.map((index) => play(index, rounds, seed));
  try {
    return await Promise.all(indexes.map((index) => playApart(index, rounds, seed)));
  } catch {
    // Starting extra processes is only a speed-up. Without it, play in this one.
    return indexes.map((index) => play(index, rounds, seed));
  }
}

let failures = 0;
const verdict = (ok: boolean): string => {
  if (!ok) failures += 1;
  return ok ? 'PASS' : 'FAIL';
};

/**
 * The checks both ways of playing share. `room` is how far under the
 * configured RTP the exact figure may sit; null means any amount.
 */
function judge(
  difficulty: Difficulty,
  result: SimResult,
  way: Play,
  rtp: Fr,
  room: number | null,
): void {
  const stats = report(config, difficulty, result, way);
  const { mismatches } = result;
  const draws = result.pumps.reduce((sum, pump) => sum + pump.attempts, 0);
  console.log(
    `  to the cent    ${count(draws)} draws, ${count(result.payouts)} payouts, ` +
      `${count(result.patchesBought)} Patch charges and ${count(result.balloons)} top rungs ` +
      `are exactly what the rules give ... ${verdict(stats.exact)}`,
  );
  if (!stats.exact) {
    console.log(
      `                 not so: ${count(mismatches.chances)} chances, ` +
        `${count(mismatches.rolls)} rolls, ` +
        `${count(mismatches.outcomes)} outcomes, ${count(mismatches.payouts)} payouts, ` +
        `${count(mismatches.patchPrices)} Patch charges, ${count(mismatches.topRungs)} top rungs`,
    );
    console.log(`                 first: ${mismatches.first}`);
  }

  const shortfall = toNumber(rtp) - toNumber(stats.expectedRtp);
  const figureOk = compare(stats.expectedRtp, rtp) <= 0 && (room === null || shortfall <= room);
  const rtpOk = Math.abs(stats.z) <= PASS_MARK && figureOk;
  console.log(
    `  RTP            ${pct(stats.rtp, 3)} simulated; ${percent(stats.expectedRtp, 3)} is the ` +
      'exact figure for this way of playing',
  );
  console.log(
    `                 ${Math.abs(stats.z).toFixed(2)} standard errors apart ` +
      `(one is ${pct(stats.standardError, 3)}) ... ${verdict(rtpOk)}`,
  );
  if (!figureOk) {
    console.log(
      compare(stats.expectedRtp, rtp) > 0
        ? `                 the exact figure is above the configured ${percent(rtp)}`
        : `                 the exact figure is ${pct(shortfall, 3)} under the configured ` +
            `${percent(rtp)}; cent rounding should cost no more than ${pct(room ?? 0, 1)} here`,
    );
  }
  console.log(
    `  pump counts    worst of ${String(difficulty.ladder.length)} pumps is pump ` +
      `${String(stats.worstPump)}, ${stats.worstPumpZ.toFixed(2)} standard errors from its ` +
      `exact chance ... ${verdict(stats.worstPumpZ <= PASS_MARK)}`,
  );
  console.log(
    `  pump 1 alone   puts the RTP at ${pct(stats.pumpOneRtp, 3)}, give or take ` +
      `${pct(stats.pumpOneError, 3)}; configured ${percent(rtp)} ... ` +
      verdict(stats.pumpOneZ <= PASS_MARK),
  );
}

function print(results: readonly Played[], rtp: Fr): void {
  const climb = climbPlay(config);
  config.difficulties.forEach((difficulty, index) => {
    const played = results[index];
    if (played === undefined) throw new Error('A difficulty has no result');
    const { main } = played;
    const stats = report(config, difficulty, main, SPREAD);
    const { biggest } = main;
    const multiple = (difficulty.ladder[biggest.rung - 1] ?? 0) / 100;

    console.log('');
    console.log(
      `${difficulty.label}: ${count(main.rounds)} rounds, ${count(main.balloons)} balloons, ` +
        `${count(main.patchesBought)} Patches`,
    );
    judge(difficulty, main, SPREAD, rtp, ROUNDING_ROOM);
    console.log(`  hit rate       ${pct(stats.hitRate)} of rounds paid out something`);
    console.log(
      `  volatility     ${stats.volatility.toFixed(2)} (standard deviation of a round's ` +
        'payout per $1 paid in; rare huge wins move it from run to run)',
    );
    console.log(
      `  biggest win    ${multiple.toLocaleString('en-US')}x: ${dollars(biggest.payoutCents)} ` +
        `on a ${dollars(biggest.betCents)} bet`,
    );

    const up = played.climb;
    console.log(
      `  The climb: ${count(up.rounds)} rounds, ${count(up.balloons)} balloons, a Patch ` +
        `before every pump after the first, never cashing out`,
    );
    const survivors = up.pumps[1]?.survived ?? 0;
    console.log(
      `  to the top     ${count(up.topsReached)} balloons reached their top rung, of ` +
        `${count(survivors)} that survived pump 1; the cap stopped ` +
        `${count(up.cappedBalloons)} balloons below the end of the ladder ... ` +
        verdict(up.topsReached === survivors && survivors > 0),
    );
    judge(difficulty, up, climb, rtp, null);
  });
}

async function main(options: Map<string, string>): Promise<void> {
  const started = performance.now();
  const rounds = Math.max(1, numberOption(options, 'rounds', 10_000_000));
  const seed = numberOption(options, 'seed', 1);
  console.log('Pump: simulator');
  // First of all: a configuration the engine refuses is reported as that.
  assertValidConfig(config);
  const rtp = rtpOf(config.rtpBp);
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
  console.log(
    `Then the climb: ${count(climbRounds(rounds))} rounds with bets of ` +
      `${climbPlay(config).bets.map(dollars).join(', ')}, straight to the top rung.`,
  );
  const results = await playAll(rounds, seed, options.has('serial'));
  print(results, rtp);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log('');
  console.log(
    failures === 0
      ? `RESULT: PASS. The engine plays as the rules say it should. (${seconds}s)`
      : `RESULT: FAIL. ${String(failures)} check(s) failed. (${seconds}s)`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

function fail(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

try {
  const options = readOptions(process.argv.slice(2));
  const only = numberOption(options, 'only', -1);
  if (options.has('only')) {
    // Started by playApart: play one difficulty and hand the counts back.
    const rounds = Math.max(1, numberOption(options, 'rounds', 10_000_000));
    process.send?.(play(only, rounds, numberOption(options, 'seed', 1)));
  } else {
    main(options).catch(fail);
  }
} catch (error) {
  fail(error);
}
