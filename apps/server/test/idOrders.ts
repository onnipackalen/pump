import { createHash } from 'node:crypto';
import { buildApp } from '../src/app';
import { buildServices } from '../src/services';
import { testRuntime, type TestWorld } from './helpers';

/*
 * The history is ordered by finish time, then start time, then id. The test
 * runtime's ids count up in the order things are made, so inside a group of
 * rounds that finished in the same millisecond, the round that started later
 * always has the higher id too. Then the id alone gives the same order as the
 * start time, and a test can't tell whether the start time is used at all.
 * Real ids are random (runtime.ts uses randomUUID), so it matters there.
 *
 * These make ids in other orders, the same on every run, so the start time
 * has to decide.
 */

/** How the ids of a test world are made. */
export type IdOrder = 'counting up' | 'counting down' | 'in no order';

export const ID_ORDERS: readonly IdOrder[] = ['counting up', 'counting down', 'in no order'];

function idMaker(order: Exclude<IdOrder, 'counting up'>): () => string {
  let n = 0;
  if (order === 'counting down') {
    // The same width every time, so text order is number order, backwards.
    return () => `id-${String(9_999_999 - n++).padStart(7, '0')}`;
  }
  // A hash of a counter: no link at all between id order and play order.
  return () =>
    createHash('sha256')
      .update(`id:${String(n++)}`)
      .digest('hex')
      .slice(0, 32);
}

/** A fresh test world whose ids are made in `order`. */
export function worldWithIds(order: IdOrder): TestWorld {
  const base = testRuntime();
  const runtime = order === 'counting up' ? base : { ...base, newId: idMaker(order) };
  return {
    runtime,
    db: runtime.db,
    services: buildServices(runtime),
    app: buildApp({ runtime }),
  };
}
