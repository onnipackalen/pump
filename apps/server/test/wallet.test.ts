import { beforeEach, describe, expect, it } from 'vitest';
import { immediate } from '../src/db/transaction';
import { ApiError } from '../src/errors';
import { ledgerRepository } from '../src/repositories/ledger';
import { walletProblems } from '../src/services/reconcile';
import { STARTING_BALANCE_CENTS } from '../src/settings';
import { cashOutByHand, count, insertActiveRound, testWorld, type TestWorld } from './helpers';

const AT = '2026-01-01T00:00:00.000Z';
let world: TestWorld;
let playerId: string;

/** Balloon n of the test round. The round has three balloons with a bet of $10 each. */
const balloon = (balloonIndex: number) => ({ roundId: 'round-1', balloonIndex });

/**
 * A charge of any size. Bets must equal their balloon's bet, so tests that
 * need an arbitrary amount charge it as a Patch.
 */
function charge(cents: number, balloonIndex = 0): number {
  return immediate(world.db, () =>
    world.services.wallet.charge(playerId, 'patch', cents, balloon(balloonIndex), AT),
  );
}

beforeEach(() => {
  world = testWorld();
  playerId = world.services.players.create().player.id;
  insertActiveRound(world.db, playerId, 'round-1', [1000, 1000, 1000]);
});

describe('a new player', () => {
  it('starts with $10,000, and it arrived through the ledger', () => {
    expect(world.services.wallet.balanceOf(playerId)).toBe(STARTING_BALANCE_CENTS);
    const entries = ledgerRepository(world.db).entriesOf(playerId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'grant',
      amountCents: 1_000_000,
      balanceAfterCents: 1_000_000,
      roundId: null,
    });
  });

  it('has a wallet that adds up', () => {
    expect(walletProblems(world.db)).toEqual([]);
  });
});

describe('charging', () => {
  it('takes the money and writes one ledger row, together', () => {
    const { wallet } = world.services;
    const balance = immediate(world.db, () => wallet.charge(playerId, 'bet', 1000, balloon(0), AT));

    expect(balance).toBe(999_000);
    expect(wallet.balanceOf(playerId)).toBe(999_000);
    expect(ledgerRepository(world.db).entriesOf(playerId).at(-1)).toMatchObject({
      kind: 'bet',
      amountCents: -1000,
      balanceAfterCents: 999_000,
      roundId: 'round-1',
      balloonIndex: 0,
    });
  });

  it('refuses a charge the balance cannot cover, and writes nothing', () => {
    const rowsBefore = count(world.db, 'ledger');

    expect(() => charge(1_000_001)).toThrow(ApiError);
    expect(() => charge(1_000_001)).toThrow('balance is too low');
    expect(world.services.wallet.balanceOf(playerId)).toBe(STARTING_BALANCE_CENTS);
    expect(count(world.db, 'ledger')).toBe(rowsBefore);
  });

  it('tells the player their real balance when it refuses', () => {
    try {
      charge(2_000_000);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      if (!(error instanceof ApiError)) return;
      expect(error.status).toBe(402);
      expect(error.toResponse()).toEqual({
        error: {
          code: 'insufficient_funds',
          message: 'Your balance is too low for this',
          wallet: { balanceCents: 1_000_000 },
        },
      });
    }
  });

  it('reports the balance after the rollback, not one the refused request had moved', () => {
    // A request that spends 400,000 and then asks for more than is left. The
    // whole request is undone, so the answer must show 1,000,000, not 600,000.
    const answer = world.services.idempotency.once(
      { playerId, key: 'two-charges', fingerprint: 'f' },
      () => {
        world.services.wallet.charge(playerId, 'patch', 400_000, balloon(0), AT);
        world.services.wallet.charge(playerId, 'patch', 700_000, balloon(0), AT);
        return { status: 200, body: {} };
      },
    );

    expect(answer.status).toBe(402);
    expect(answer.body).toMatchObject({ error: { wallet: { balanceCents: 1_000_000 } } });
    expect(world.services.wallet.balanceOf(playerId)).toBe(1_000_000);
  });

  it('lets a player with $5 spend $5, but not $10', () => {
    charge(999_500);

    expect(() => charge(1000)).toThrow('balance is too low');
    expect(world.services.wallet.balanceOf(playerId)).toBe(500);

    charge(500);
    expect(world.services.wallet.balanceOf(playerId)).toBe(0);
  });

  it('lets only one of two charges through when together they are too much', () => {
    charge(999_000);
    // $10 left. Two Patches of $6 each: the first fits, the second must not.
    const results = [1, 2].map(() => {
      try {
        charge(600);
        return 'charged';
      } catch {
        return 'refused';
      }
    });

    expect(results).toEqual(['charged', 'refused']);
    expect(world.services.wallet.balanceOf(playerId)).toBe(400);
    expect(walletProblems(world.db)).toEqual([]);
  });

  it('is undone completely if the request fails after it', () => {
    const rowsBefore = count(world.db, 'ledger');

    expect(() =>
      immediate(world.db, () => {
        world.services.wallet.charge(playerId, 'patch', 250, balloon(0), AT);
        throw new Error('the server crashed here');
      }),
    ).toThrow('crashed');

    expect(world.services.wallet.balanceOf(playerId)).toBe(STARTING_BALANCE_CENTS);
    expect(count(world.db, 'ledger')).toBe(rowsBefore);
  });

  it('only works inside a transaction', () => {
    expect(() => world.services.wallet.charge(playerId, 'patch', 250, balloon(0), AT)).toThrow(
      'inside a transaction',
    );
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'refuses an amount of %s cents',
    (cents) => {
      expect(() => charge(cents)).toThrow('positive whole number of cents');
      expect(world.services.wallet.balanceOf(playerId)).toBe(STARTING_BALANCE_CENTS);
    },
  );

  it('refuses a bet that is not the balloon’s bet, or is for a balloon that does not exist', () => {
    const { wallet } = world.services;
    expect(() =>
      immediate(world.db, () => wallet.charge(playerId, 'bet', 999, balloon(0), AT)),
    ).toThrow('must match a balloon of its own player');
    expect(() =>
      immediate(world.db, () => wallet.charge(playerId, 'bet', 1000, balloon(7), AT)),
    ).toThrow('must match a balloon of its own player');
    expect(wallet.balanceOf(playerId)).toBe(STARTING_BALANCE_CENTS);
  });
});

describe('paying out', () => {
  it('adds the money and writes one ledger row', () => {
    const { wallet } = world.services;
    immediate(world.db, () => {
      wallet.charge(playerId, 'bet', 1000, balloon(0), AT);
      cashOutByHand(world.db, 'round-1', 0, 1230);
      wallet.credit(playerId, 'payout', 1230, balloon(0), AT);
    });
    expect(wallet.balanceOf(playerId)).toBe(1_000_230);
    expect(walletProblems(world.db)).toEqual([]);
  });

  it('can never pay the same balloon twice', () => {
    const { wallet } = world.services;
    immediate(world.db, () => {
      wallet.charge(playerId, 'bet', 1000, balloon(0), AT);
      cashOutByHand(world.db, 'round-1', 0, 1230);
      wallet.credit(playerId, 'payout', 1230, balloon(0), AT);
    });

    expect(() =>
      immediate(world.db, () => wallet.credit(playerId, 'payout', 1230, balloon(0), AT)),
    ).toThrow('this money was already moved');
    expect(() =>
      immediate(world.db, () => wallet.credit(playerId, 'refund', 1000, balloon(0), AT)),
    ).toThrow(/already moved|must match a balloon/);

    expect(wallet.balanceOf(playerId)).toBe(1_000_230);
    expect(walletProblems(world.db)).toEqual([]);
  });

  it('refuses a payout the balloon did not earn', () => {
    const { wallet } = world.services;
    // Balloon 1 is still in play: nothing is due.
    expect(() =>
      immediate(world.db, () => wallet.credit(playerId, 'payout', 5000, balloon(1), AT)),
    ).toThrow('must match a balloon of its own player');
    // Balloon 0 cashed out for 1,230: 5,000 is not what it recorded.
    cashOutByHand(world.db, 'round-1', 0, 1230);
    expect(() =>
      immediate(world.db, () => wallet.credit(playerId, 'payout', 5000, balloon(0), AT)),
    ).toThrow('must match a balloon of its own player');
    expect(wallet.balanceOf(playerId)).toBe(STARTING_BALANCE_CENTS);
  });

  it('can never give a second opening grant', () => {
    expect(() =>
      immediate(world.db, () => world.services.wallet.grant(playerId, 1_000_000, AT)),
    ).toThrow('this money was already moved');
    expect(world.services.wallet.balanceOf(playerId)).toBe(STARTING_BALANCE_CENTS);
  });
});

describe('the wallet check', () => {
  it('passes after a mix of charges and payouts', () => {
    const { wallet } = world.services;
    immediate(world.db, () => {
      wallet.charge(playerId, 'bet', 1000, balloon(0), AT);
      wallet.charge(playerId, 'bet', 1000, balloon(1), AT);
      wallet.charge(playerId, 'patch', 37, balloon(0), AT);
      wallet.charge(playerId, 'patch', 41, balloon(0), AT);
      cashOutByHand(world.db, 'round-1', 0, 1530);
      wallet.credit(playerId, 'payout', 1530, balloon(0), AT);
    });
    expect(walletProblems(world.db)).toEqual([]);
    expect(count(world.db, 'ledger')).toBe(6);
    expect(wallet.balanceOf(playerId)).toBe(1_000_000 - 1000 - 1000 - 37 - 41 + 1530);
  });

  it('notices a balance that was changed behind the ledger’s back', () => {
    // Only possible with the guard removed, which is what this simulates.
    world.db.exec('DROP TRIGGER players_balance_follows_ledger');
    world.db.exec('UPDATE players SET balance_cents = balance_cents + 500');

    const problems = walletProblems(world.db).join('\n');
    expect(problems).toContain('balance 1000500 but ledger sums to 1000000');
    expect(problems).toContain('balance 1000500 but the last ledger row says 1000000');
  });

  it('notices a ledger row that was edited', () => {
    charge(1000);
    charge(50);
    world.db.exec('DROP TRIGGER ledger_no_update');
    world.db.exec('UPDATE ledger SET amount_cents = -1 WHERE amount_cents = -1000');

    const problems = walletProblems(world.db).join('\n');
    expect(problems).toContain('does not continue from the row before it');
    expect(problems).toContain('ledger sums to');
  });

  it('notices a missing opening grant', () => {
    world.db.exec("INSERT INTO players (id, token_hash, created_at) VALUES ('ghost', 'h', 'now')");
    expect(walletProblems(world.db)).toContain('player ghost: 0 opening grants, expected 1');
  });
});
