import type { RoundView } from '@pump/contract';
import { GAME_CONFIG } from '@pump/engine';
import { beforeEach, describe, expect, it } from 'vitest';
import { text } from '../src/db/rows';
import { immediate } from '../src/db/transaction';
import { reconcile, roundProblems } from '../src/services/reconcile';
import { cashOutByHand, insertActiveRound, testWorld, type TestWorld } from './helpers';
import { Seat } from './play';

const AT = '2026-01-01T00:00:00.000Z';
let world: TestWorld;
let seats: Seat[];

/** A small repeatable generator, so a failing run can be played again exactly. */
function generator(seed: number): (below: number) => number {
  let state = seed >>> 0;
  return (below) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % below;
  };
}

/**
 * Plays one round to the end the way a restless player would: random
 * balloons, pumps with and without a Patch, cash-outs, and now and then a
 * request that must be refused.
 */
async function playRound(seat: Seat, pick: (below: number) => number): Promise<void> {
  const difficulty = GAME_CONFIG.difficulties[pick(GAME_CONFIG.difficulties.length)];
  const bets = Array.from({ length: 1 + pick(3) }, () => [10, 11, 99, 250, 1234, 5000][pick(6)] ?? 10);
  const started = await seat.start(difficulty?.id ?? 'easy', bets);
  if (started.status !== 200) return;
  let round: RoundView = started.body.round;

  for (let step = 0; step < 60 && round.status === 'active'; step += 1) {
    const live = round.balloons.filter((balloon) => balloon.status === 'active');
    const balloon = live[pick(live.length)];
    if (!balloon) return;
    const choice = pick(10);
    if (choice === 0) {
      // An out-of-date request: must be refused and change nothing.
      await seat.pump(round, balloon.index, { expectedDrawIndex: balloon.drawIndex + 1 });
    } else if (choice <= 2 && balloon.rung >= 1) {
      const reply = await seat.cashOut(round, balloon.index);
      if (reply.status === 200) round = reply.body.round;
    } else {
      const reply = await seat.pump(round, balloon.index, {
        patch: balloon.rung >= 1 && pick(3) === 0,
      });
      if (reply.status === 200) round = reply.body.round;
    }
  }
  // Whatever is left, cash out or pump until the round is over.
  for (const balloon of round.balloons) {
    let current = round.balloons[balloon.index];
    while (current?.status === 'active') {
      const reply: { status: number; body: { round: RoundView } } =
        current.rung >= 1
          ? await seat.cashOut(round, balloon.index)
          : await seat.pump(round, balloon.index);
      if (reply.status !== 200) return;
      round = reply.body.round;
      current = round.balloons[balloon.index];
    }
  }
}

beforeEach(async () => {
  world = testWorld();
  seats = [await Seat.join(world.app, 'a'), await Seat.join(world.app, 'b')];
});

describe('after many rounds of mixed play', () => {
  it('the books add up, and every cent is accounted for', async () => {
    const pick = generator(20261120);
    for (let i = 0; i < 40; i += 1) {
      const seat = seats[i % seats.length];
      if (!seat) throw new Error('no seat');
      await playRound(seat, pick);
    }

    const report = reconcile(world.db);

    expect(report.problems).toEqual([]);
    expect(report.players).toBe(2);
    expect(report.rounds).toBe(40);
    // Money in equals money out: grants - bets - Patches + payouts + refunds = balances.
    const totals = world.db
      .prepare(
        `SELECT (SELECT SUM(balance_cents) FROM players) AS balances,
                (SELECT SUM(amount_cents) FROM ledger)   AS ledger,
                (SELECT SUM(payout_cents) - SUM(bet_cents) - SUM(patches_cents) FROM balloons) AS net`,
      )
      .get();
    expect(totals?.balances).toBe(totals?.ledger);
    expect(totals?.balances).toBe(2_000_000 + Number(totals?.net));
  });
});

describe('the round check notices', () => {
  // A hand-made round of two $10 balloons with both bets charged correctly.
  beforeEach(() => {
    const playerId = text(world.db.prepare('SELECT id FROM players LIMIT 1').get() ?? {}, 'id');
    insertActiveRound(world.db, playerId, 'by-hand', [1000, 1000]);
    immediate(world.db, () => {
      world.services.wallet.charge(playerId, 'bet', 1000, { roundId: 'by-hand', balloonIndex: 0 }, AT);
      world.services.wallet.charge(playerId, 'bet', 1000, { roundId: 'by-hand', balloonIndex: 1 }, AT);
    });
    expect(roundProblems(world.db)).toEqual([]);
  });

  it('a balloon that cashed out but was never paid', () => {
    cashOutByHand(world.db, 'by-hand', 0, 1010);
    expect(roundProblems(world.db).join('\n')).toContain(
      'balloon 0: cashed, so payout 1010 and refund 0 are due, but the ledger paid 0 and refunded 0',
    );
  });

  it('Patches recorded that were never charged', () => {
    world.db.exec('UPDATE balloons SET patches_cents = 37 WHERE balloon_index = 1');
    expect(roundProblems(world.db).join('\n')).toContain(
      'balloon 1: Patches of 37 recorded but the ledger charged 0',
    );
  });

  it('a draw that was used but not recorded', () => {
    world.db.exec('UPDATE balloons SET draw_index = draw_index + 1 WHERE balloon_index = 1');
    expect(roundProblems(world.db).join('\n')).toContain('1 draws used but 0 pumps recorded');
  });

  it('a finished round without the reveal it is due', () => {
    cashOutByHand(world.db, 'by-hand', 0, 1010);
    world.db.exec("UPDATE balloons SET status = 'popped' WHERE balloon_index = 1");
    world.db.exec('DROP TRIGGER rounds_finish_with_their_reveals');
    world.db.exec("UPDATE rounds SET status = 'finished', finished_at = '2026-01-01T01:00:00.000Z'");
    expect(roundProblems(world.db).join('\n')).toContain(
      'balloon 0: cashed out on rung 1, below its top rung 2, but has no reveal',
    );
  });

  describe('with the reveal guards removed', () => {
    const draw = (drawIndex: number, roll: number): string =>
      `{"drawIndex":${String(drawIndex)},"den":111,"num":101,"roll":${String(roll)}}`;
    const reveal = (balloonIndex: number, outcome: string, reached: number, draws: string): void => {
      world.db.exec(
        `INSERT INTO balloon_reveals (round_id, balloon_index, outcome, reached_rung, draws_json, created_at)
         VALUES ('by-hand', ${String(balloonIndex)}, '${outcome}', ${String(reached)}, '${draws}', '${AT}')`,
      );
    };
    beforeEach(() => {
      world.db.exec('DROP TRIGGER balloon_reveals_at_round_end');
      world.db.exec('DROP TRIGGER balloon_reveals_fit_their_balloon');
    });

    it('a reveal while the round is in progress', () => {
      reveal(1, 'popped', 1, `[${draw(0, 105)}]`);
      expect(roundProblems(world.db).join('\n')).toContain(
        'balloon 1: has a reveal while its round is still in progress',
      );
    });

    it('a reveal for a balloon that has none, and one that does not fit its balloon', () => {
      cashOutByHand(world.db, 'by-hand', 0, 1010);
      world.db.exec("UPDATE balloons SET status = 'popped' WHERE balloon_index = 1");
      reveal(0, 'popped', 1, `[${draw(0, 105)}]`);
      reveal(1, 'popped', 1, `[${draw(0, 105)}]`);
      world.db.exec("UPDATE rounds SET status = 'finished', finished_at = '2026-01-01T01:00:00.000Z'");

      const problems = roundProblems(world.db).join('\n');
      expect(problems).toContain(
        'balloon 1: popped on rung 0 of 2, so it has no reveal, but one is stored',
      );
      expect(problems).toContain('balloon 0: its reveal draws do not start at draw 1');
    });

    it('a reveal whose rolls tell another story than its outcome', () => {
      cashOutByHand(world.db, 'by-hand', 0, 1010);
      world.db.exec("UPDATE balloons SET status = 'popped' WHERE balloon_index = 1");
      // Roll 5 is below 101: that pump survives, so it cannot be the pop.
      reveal(0, 'popped', 1, `[${draw(1, 5)}]`);
      world.db.exec("UPDATE rounds SET status = 'finished', finished_at = '2026-01-01T01:00:00.000Z'");

      expect(roundProblems(world.db).join('\n')).toContain(
        'balloon 0: its reveal draw 1 does not match the outcome popped',
      );
    });
  });

  it('a finished round with a balloon still in play', () => {
    // Only possible with the guard removed, which is what this simulates.
    world.db.exec('DROP TRIGGER rounds_finish_when_no_balloon_in_play');
    world.db.exec(
      "UPDATE rounds SET status = 'finished', finished_at = '2026-01-01T01:00:00.000Z'",
    );
    expect(roundProblems(world.db).join('\n')).toContain('finished with');
  });
});
