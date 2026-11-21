/**
 * npm run rtp: the exact RTP check.
 *
 * Reads the RTP and the ladders from the game's configuration and proves, in
 * whole numbers and exact fractions, what cli/proof.ts lists: every pump's
 * chance is the one the rules give; every cash-out point and every Patch
 * returns exactly the RTP before rounding; for every legal bet no cash-out
 * and no Patch returns more than the RTP after rounding; and no way of
 * playing beats it. It prints every rung, the worst that cent rounding does,
 * and PASS or FAIL. It exits with an error if anything fails.
 *
 * Change RTP_BP in src/config.ts and run it again: nothing here assumes 97.
 */
import { assertValidConfig, GAME_CONFIG, type Difficulty, type Limits } from '../src/index';
import { compare, percent, toNumber, ZERO, type Fr } from './fraction';
import { bestStrategyEdge, proveRungs, rtpOf, scanBets, type Worst } from './proof';

const config = GAME_CONFIG;
let failures = 0;

function dollars(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString('en-US');
  return `$${whole}.${String(cents % 100).padStart(2, '0')}`;
}

function times(hundredths: number): string {
  return `${(hundredths / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}x`;
}

/** Prints one check with PASS or FAIL at the end of a dotted line. */
function check(label: string, ok: boolean): void {
  if (!ok) failures += 1;
  console.log(`  ${label} ${'.'.repeat(Math.max(3, 66 - label.length))} ${ok ? 'PASS' : 'FAIL'}`);
}

function* everyBet(limits: Limits): Generator<number> {
  for (let bet = limits.minBetCents; bet <= limits.maxBetCents; bet += 1) yield bet;
}

function worstLine(label: string, worst: Worst | null, where: string, none: string): void {
  if (worst === null) return;
  if (worst.betCents === 0) {
    console.log(`    ${label} ${none}`);
    return;
  }
  const place = `bet ${dollars(worst.betCents)}, ${where} ${String(worst.rung)}`;
  console.log(`    ${label} ${percent(worst.value)} (${place})`);
}

function proveDifficulty(difficulty: Difficulty, rtp: Fr): void {
  const { ladder } = difficulty;
  const top = ladder.at(-1) ?? 0;
  console.log('');
  console.log(`${difficulty.label}: ${String(ladder.length)} pumps to ${times(top)}`);
  console.log('  pump  multiplier   pop chance  chance to reach   cash-out return   Patch price');
  console.log('                                                  before rounding   share of bet');

  const rows = proveRungs(config.rtpBp, ladder);
  for (const row of rows) {
    const pop = percent({ n: BigInt(row.popChance.num), d: BigInt(row.popChance.den) }, 4);
    const patch = row.patchShareOfBet === null ? 'none' : percent(row.patchShareOfBet, 4);
    console.log(
      [
        String(row.rung).padStart(6),
        times(row.multiplierHundredths).padStart(12),
        pop.padStart(13),
        percent(row.reach, 6).padStart(17),
        `${percent(row.cashOutReturn, 4)} ${row.exact ? 'exact' : 'NOT EXACT'}`.padStart(18),
        patch.padStart(14),
      ].join(''),
    );
  }
  const of = (count: number, total: number): string => `${String(count)} of ${String(total)}`;
  const rightChances = rows.filter((row) => row.chanceRight).length;
  check(
    `Every pump's chance is the one the rules give (${of(rightChances, rows.length)})`,
    rightChances === rows.length,
  );
  const exactRungs = rows.filter((row) => row.exact).length;
  check(
    `Every cash-out point returns exactly ${percent(rtp)} before rounding ` +
      `(${of(exactRungs, rows.length)})`,
    exactRungs === rows.length,
  );
  const patchRows = rows.filter((row) => row.patchExact !== null);
  const exactPatches = patchRows.filter((row) => row.patchExact === true).length;
  check(
    `Every Patch returns exactly ${percent(rtp)} before rounding ` +
      `(${of(exactPatches, patchRows.length)})`,
    exactPatches === patchRows.length,
  );

  const scan = scanBets(config.rtpBp, ladder, config.limits, everyBet(config.limits));
  const { minBetCents, maxBetCents, maxPayoutCents } = config.limits;
  console.log(
    `  Every bet from ${dollars(minBetCents)} to ${dollars(maxBetCents)}: ` +
      `${scan.bets.toLocaleString('en-US')} bets, ` +
      `${scan.cashOuts.toLocaleString('en-US')} cash-outs, ` +
      `${scan.patches.toLocaleString('en-US')} Patches`,
  );
  check("Each bet's top rung is the highest one under the cap", scan.topRungsRight);
  check('Payouts are bet x multiplier, rounded down to the cent', scan.payoutsRoundDown);
  check('Patch prices are the exact price, rounded up to the cent', scan.pricesRoundUp);
  check('Whole-dollar bets are paid bet x multiplier exactly', scan.wholeDollarsExact);
  check(`No payout is above the ${dollars(maxPayoutCents)} cap`, scan.underCap);
  check(`No cash-out returns more than ${percent(rtp)}`, scan.cashOutsWithinRtp);
  check(`No Patch returns more than ${percent(rtp)}`, scan.patchesWithinRtp);
  // Rounding moves an amount by under a cent, so it costs most where the
  // amount is small: cash-outs on tiny bets, and any Patch that costs only a
  // few cents, which early pumps offer even at an ordinary bet like $1.
  console.log(
    '  What cent rounding costs at worst (most on small amounts: tiny bets, and cheap Patches at any bet):',
  );
  const nothingLost = 'no payout loses anything to rounding';
  worstLine('lowest cash-out return:', scan.worstCashOut, 'rung', nothingLost);
  worstLine('lowest Patch return:   ', scan.worstPatch, 'pump', nothingLost);

  let checked = 0;
  let best: { edge: Fr; bet: number } | null = null;
  for (const bet of everyBet(config.limits)) {
    checked += 1;
    const edge = bestStrategyEdge(config.rtpBp, ladder, config.limits, bet);
    if (best === null || compare(edge, best.edge) > 0) best = { edge, bet };
  }
  const bets = `${checked.toLocaleString('en-US')} bets`;
  check(
    `The best possible way of playing never beats ${percent(rtp)} (${bets})`,
    best !== null && compare(best.edge, ZERO) <= 0,
  );
  if (best !== null) {
    // The edge is expected payout minus RTP x expected money paid in, in cents.
    const at = `bet ${dollars(best.bet)}`;
    console.log(
      compare(best.edge, ZERO) === 0
        ? `    at best it returns exactly ${percent(rtp)} (for example ${at})`
        : `    at best it is ${toNumber(best.edge).toFixed(4)} cents from ${percent(rtp)} (${at})`,
    );
  }
}

const started = performance.now();
console.log('Pump: exact RTP check');

let shown = `${String(config.rtpBp)} basis points`;
try {
  // First of all: a configuration the engine refuses is reported as that,
  // in the engine's own words, before any arithmetic is tried on it.
  assertValidConfig(config);
  const rtp = rtpOf(config.rtpBp);
  shown = percent(rtp);
  console.log(`RTP ${shown} (${String(config.rtpBp)} basis points), from src/config.ts`);
  check('The configuration passes every start-up check', true);
  for (const difficulty of config.difficulties) proveDifficulty(difficulty, rtp);
} catch (error) {
  check('The configuration passes every start-up check', false);
  console.log(`  ${error instanceof Error ? error.message : String(error)}`);
}

const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log('');
console.log(
  failures === 0
    ? `RESULT: PASS. Everything above holds exactly at RTP ${shown}. (${seconds}s)`
    : `RESULT: FAIL. ${String(failures)} check(s) failed. (${seconds}s)`,
);
process.exitCode = failures === 0 ? 0 : 1;
