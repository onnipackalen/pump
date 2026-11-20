import { beforeEach, describe, expect, it } from 'vitest';
import { immediate } from '../src/db/transaction';
import { ApiError } from '../src/errors';
import { ledgerRepository } from '../src/repositories/ledger';
import { walletProblems } from '../src/services/reconcile';
import { STARTING_BALANCE_CENTS } from '../src/settings';
import { count, insertActiveRound, testWorld, type TestWorld } from './helpers';

const AT = '2026-01-01T00:00:00.000Z';
let world: TestWorld;
let playerId: string;

/** Balloon n of the test round. */
const balloon = (balloonIndex: number) => ({ roundId: 'round-1', balloonIndex });

beforeEach(() => {
  world = testWorld();
  playerId = world.services.players.resolve(undefined).player.id;
  insertActiveRound(world.db, playerId);
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

  it('has books that add up', () => {
    expect(walletProblems(world.db)).toEqual([]);
  });
});

describe('charging', () => {
  it('takes the money and writes one ledger row, together', () => {
    const { wallet } = world.services;
    const balance = immediate(world.db, () => wallet.charge(playerId, 'bet', 250, balloon(0), AT));

    expect(balance).toBe(999_750);
    expect(wallet.balanceOf(playerId)).toBe(999_750);
    const entries = ledgerRepository(world.db).entriesOf(playerId);
    expect(entries.at(-1)).toMatchObject({
      kind: 'bet',
      amountCents: -250,
      balanceAfterCents: 999_750,
      roundId: 'round-1',
      balloonIndex: 0,
    });
  });

  it('refuses a charge the balance cannot cover, and writes nothing', () => {
    const { wallet } = world.services;
    const rowsBefore = count(world.db, 'ledger');

    const attempt = (): number =>
      immediate(world.db, () => wallet.charge(playerId, 'bet', 1_000_001, balloon(0), AT));

    expect(attempt).toThrow(ApiError);
    expect(attempt).toThrow('balance is too low');
    expect(wallet.balanceOf(playerId)).toBe(STARTING_BALANCE_CENTS);
    expect(count(world.db, 'ledger')).toBe(rowsBefore);
  });

  it('tells the player their balance when it refuses', () => {
    const { wallet } = world.services;
    try {
      immediate(world.db, () => wallet.charge(playerId, 'bet', 2_000_000, balloon(0), AT));
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

  it('lets a player with $5 spend $5, but not $10', () => {
    const { wallet } = world.services;
    // Spend down to exactly $5.
    immediate(world.db, () => wallet.charge(playerId, 'bet', 999_500, balloon(0), AT));

    expect(() =>
      immediate(world.db, () => wallet.charge(playerId, 'bet', 1000, balloon(1), AT)),
    ).toThrow('balance is too low');
    expect(wallet.balanceOf(playerId)).toBe(500);

    immediate(world.db, () => wallet.charge(playerId, 'bet', 500, balloon(1), AT));
    expect(wallet.balanceOf(playerId)).toBe(0);
  });

  it('lets only one of two charges through when together they are too much', () => {
    const { wallet } = world.services;
    immediate(world.db, () => wallet.charge(playerId, 'bet', 999_000, balloon(0), AT));
    // $10 left. Two Patches of $6 each: the first fits, the second must not.
    const results = [1, 2].map(() => {
      try {
        immediate(world.db, () => wallet.charge(playerId, 'patch', 600, balloon(0), AT));
        return 'charged';
      } catch {
        return 'refused';
      }
    });

    expect(results).toEqual(['charged', 'refused']);
    expect(wallet.balanceOf(playerId)).toBe(400);
    expect(walletProblems(world.db)).toEqual([]);
  });

  it('is undone completely if the request fails after it', () => {
    const { wallet } = world.services;
    const rowsBefore = count(world.db, 'ledger');

    expect(() =>
      immediate(world.db, () => {
        wallet.charge(playerId, 'bet', 250, balloon(0), AT);
        throw new Error('the server crashed here');
      }),
    ).toThrow('crashed');

    expect(wallet.balanceOf(playerId)).toBe(STARTING_BALANCE_CENTS);
    expect(count(world.db, 'ledger')).toBe(rowsBefore);
  });

  it('only works inside a transaction', () => {
    expect(() => world.services.wallet.charge(playerId, 'bet', 250, balloon(0), AT)).toThrow(
      'inside a transaction',
    );
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'refuses an amount of %s cents',
    (cents) => {
      expect(() =>
        immediate(world.db, () =>
          world.services.wallet.charge(playerId, 'bet', cents, balloon(0), AT),
        ),
      ).toThrow('positive whole number of cents');
      expect(world.services.wallet.balanceOf(playerId)).toBe(STARTING_BALANCE_CENTS);
    },
  );
});

describe('paying out', () => {
  it('adds the money and writes one ledger row', () => {
    const { wallet } = world.services;
    immediate(world.db, () => {
      wallet.charge(playerId, 'bet', 1000, balloon(0), AT);
      wallet.credit(playerId, 'payout', 1230, balloon(0), AT);
    });
    expect(wallet.balanceOf(playerId)).toBe(1_000_230);
    expect(walletProblems(world.db)).toEqual([]);
  });

  it('can never pay the same balloon twice', () => {
    const { wallet } = world.services;
    immediate(world.db, () => {
      wallet.charge(playerId, 'bet', 1000, balloon(0), AT);
      wallet.credit(playerId, 'payout', 1230, balloon(0), AT);
    });

    expect(() =>
      immediate(world.db, () => wallet.credit(playerId, 'payout', 1230, balloon(0), AT)),
    ).toThrow('UNIQUE constraint failed');
    expect(() =>
      immediate(world.db, () => wallet.credit(playerId, 'refund', 1000, balloon(0), AT)),
    ).toThrow('UNIQUE constraint failed');

    expect(wallet.balanceOf(playerId)).toBe(1_000_230);
    expect(walletProblems(world.db)).toEqual([]);
  });

  it('can never give a second opening grant', () => {
    expect(() =>
      immediate(world.db, () => world.services.wallet.grant(playerId, 1_000_000, AT)),
    ).toThrow('UNIQUE constraint failed');
    expect(world.services.wallet.balanceOf(playerId)).toBe(STARTING_BALANCE_CENTS);
  });
});

describe('the wallet check', () => {
  it('passes after a mix of charges and payouts', () => {
    const { wallet } = world.services;
    immediate(world.db, () => {
      wallet.charge(playerId, 'bet', 1000, balloon(0), AT);
      wallet.charge(playerId, 'bet', 2500, balloon(1), AT);
      wallet.charge(playerId, 'patch', 37, balloon(0), AT);
      wallet.charge(playerId, 'patch', 41, balloon(0), AT);
      wallet.credit(playerId, 'payout', 1530, balloon(0), AT);
      wallet.credit(playerId, 'refund', 2500, balloon(1), AT);
    });
    expect(walletProblems(world.db)).toEqual([]);
    expect(count(world.db, 'ledger')).toBe(7);
    expect(wallet.balanceOf(playerId)).toBe(1_000_000 - 1000 - 2500 - 37 - 41 + 1530 + 2500);
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
    const { wallet } = world.services;
    immediate(world.db, () => {
      wallet.charge(playerId, 'bet', 1000, balloon(0), AT);
      wallet.charge(playerId, 'patch', 50, balloon(0), AT);
    });
    world.db.exec('DROP TRIGGER ledger_no_update');
    world.db.exec("UPDATE ledger SET amount_cents = -1 WHERE kind = 'bet'");

    const problems = walletProblems(world.db).join('\n');
    expect(problems).toContain('does not continue from the row before it');
    expect(problems).toContain('ledger sums to');
  });

  it('notices a missing opening grant', () => {
    world.db.exec("INSERT INTO players (id, token_hash, created_at) VALUES ('ghost', 'h', 'now')");
    expect(walletProblems(world.db)).toContain(
      'player ghost: 0 opening grants, expected 1',
    );
  });
});
