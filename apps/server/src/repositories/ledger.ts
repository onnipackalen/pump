import type { Db } from '../db/database';
import { int, nullableInt, nullableText, text, type Row } from '../db/rows';
import { assertInTransaction } from '../db/transaction';

export type LedgerKind = 'grant' | 'bet' | 'patch' | 'payout' | 'refund';

export interface LedgerEntry {
  readonly id: number;
  readonly playerId: string;
  readonly kind: LedgerKind;
  /** Signed: negative took money from the player, positive gave it. */
  readonly amountCents: number;
  /** The player's balance once this row was applied. */
  readonly balanceAfterCents: number;
  readonly roundId: string | null;
  readonly balloonIndex: number | null;
  readonly createdAt: string;
}

export interface NewLedgerEntry {
  readonly playerId: string;
  readonly kind: LedgerKind;
  /** Signed: negative takes money from the player, positive gives it. */
  readonly amountCents: number;
  readonly roundId: string | null;
  readonly balloonIndex: number | null;
  readonly at: string;
}

const KINDS: readonly string[] = ['grant', 'bet', 'patch', 'payout', 'refund'];

function isLedgerKind(value: string): value is LedgerKind {
  return KINDS.includes(value);
}

function toEntry(row: Row): LedgerEntry {
  const kind = text(row, 'kind');
  if (!isLedgerKind(kind)) throw new Error(`Unknown ledger kind ${kind}`);
  return {
    id: int(row, 'id'),
    playerId: text(row, 'player_id'),
    kind,
    amountCents: int(row, 'amount_cents'),
    balanceAfterCents: int(row, 'balance_after_cents'),
    roundId: nullableText(row, 'round_id'),
    balloonIndex: nullableInt(row, 'balloon_index'),
    createdAt: text(row, 'created_at'),
  };
}

export type LedgerRepository = ReturnType<typeof ledgerRepository>;

/** The only code that writes to the ledger or changes a balance. */
export function ledgerRepository(db: Db) {
  // Check, record and move the balance in ONE statement. The row is written
  // only if the balance can take the amount, and a database trigger then
  // sets the stored balance to this row's balance_after_cents as part of the
  // same insert. There is no gap between "is there enough?", "write it down"
  // and "move the balance" for another request, or a crash, to slip into.
  const insertIfAffordable = db.prepare(`
    INSERT INTO ledger
      (player_id, kind, amount_cents, balance_after_cents, round_id, balloon_index, created_at)
    SELECT id, :kind, :amount, balance_cents + :amount, :roundId, :balloonIndex, :at
    FROM players
    WHERE id = :playerId AND balance_cents + :amount >= 0
  `);
  const selectBalance = db.prepare('SELECT balance_cents FROM players WHERE id = :playerId');
  const selectByPlayer = db.prepare('SELECT * FROM ledger WHERE player_id = :playerId ORDER BY id');

  function balanceOf(playerId: string): number {
    const row = selectBalance.get({ playerId });
    if (!row) throw new Error('No such player');
    return int(row, 'balance_cents');
  }

  return {
    /**
     * Writes one ledger row and moves the balance with it. Returns the new
     * balance, or null if the player cannot afford it, in which case nothing
     * at all was written.
     */
    append(entry: NewLedgerEntry): number | null {
      assertInTransaction(db);
      const written = insertIfAffordable.run({
        playerId: entry.playerId,
        kind: entry.kind,
        amount: entry.amountCents,
        roundId: entry.roundId,
        balloonIndex: entry.balloonIndex,
        at: entry.at,
      });
      if (Number(written.changes) !== 1) return null;
      return balanceOf(entry.playerId);
    },

    balanceOf,

    entriesOf(playerId: string): LedgerEntry[] {
      return selectByPlayer.all({ playerId }).map(toEntry);
    },
  };
}
