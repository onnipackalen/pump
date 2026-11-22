import { GAME_CONFIG } from '@pump/engine';
import { hashServerSeed, verifyRound } from '@pump/engine/fair';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RoundView, VerifiableRound } from '../src/api/contract';
import { formFrom, roundFrom, sameInputs, Workbench, type RoundForm } from '../src/components/VerifyPage';
import { DemoClient } from '../src/demo/DemoClient';
import {
  clientSeedFieldLabel,
  noRecordNote,
  nonceFieldLabel,
  recordClientSeedProblem,
  recordNonceProblem,
  recordProblems,
} from '../src/verify/copyCheck';
import { hashFieldLabel, hashSource, hashVerdict, recordHashProblem } from '../src/verify/hashCheck';
import type { ShownSeeds } from '../src/verify/shownHashes';
import { roundVerdict } from '../src/verify/verdict';

const SHOWN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const SUCCESS = 'This round checks out';

const key = (): string => crypto.randomUUID();

/** A finished round's record as the server sends it for checking. */
function record(serverSeedHash: string): VerifiableRound {
  return {
    id: 'round-1',
    difficultyId: 'easy',
    rtpBp: GAME_CONFIG.rtpBp,
    ladder: [101, 109],
    maxPayoutCents: 10_000_000,
    serverSeed: 'c'.repeat(64),
    serverSeedHash,
    clientSeed: 'record-seed',
    nonce: 7,
    finishedAt: '2026-11-20T00:00:00.000Z',
    balloons: [],
  };
}

/** Plays one round in the demo: a few pumps on each balloon, then cash out what is left. */
async function playRound(client: DemoClient): Promise<string> {
  let { round }: { round: RoundView } = await client.startRound(
    { difficultyId: 'easy', betsCents: [100, 250, 1000] },
    key(),
  );
  for (let step = 0; step < 40 && round.status === 'active'; step += 1) {
    const b = round.balloons.find((x) => x.status === 'active');
    if (!b) break;
    ({ round } =
      b.rung >= 2
        ? await client.cashOut(round.id, { balloonIndex: b.index, expectedDrawIndex: b.drawIndex }, key())
        : await client.pump(
            round.id,
            { balloonIndex: b.index, expectedDrawIndex: b.drawIndex, patch: false },
            key(),
          ));
  }
  return round.id;
}

/**
 * Rounds played in the demo with `clientSeed`, then revealed: their records,
 * oldest first. Each record's own seeds reproduce its outcomes.
 */
async function playedRecords(clientSeed: string, count: number): Promise<VerifiableRound[]> {
  const client = new DemoClient(GAME_CONFIG, 0);
  await client.setClientSeed(clientSeed, key());
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) ids.push(await playRound(client));
  await client.rotateSeed(key());
  return Promise.all(ids.map((id) => client.getVerifiableRound(id)));
}

/** What the browser saved before a round, from a record, with changes. */
function copyOf(r: VerifiableRound, change: Partial<ShownSeeds> = {}): ShownSeeds {
  return { serverSeedHash: r.serverSeedHash, clientSeed: r.clientSeed, nonce: r.nonce, ...change };
}

/** The page's verdict for a form, worked out the way the page does it. */
function verdictFor(r: VerifiableRound, shown: ShownSeeds | null, form: RoundForm) {
  const built = roundFrom(form, r);
  const own = roundFrom(formFrom(r, shown), r);
  if (!('round' in built)) throw new Error(`cannot check: ${built.errors.join(' ')}`);
  const result = verifyRound(built.round);
  return {
    result,
    verdict: roundVerdict({
      result,
      recordProblems: recordProblems(shown, r),
      screenProblems: [],
      inputsChanged: !sameInputs(own, built),
      anyReveal: result.balloons.some((b) => b.afterRound !== null),
    }),
  };
}

/** The page as it first shows a round. */
const page = (r: VerifiableRound, shown: ShownSeeds | null): string =>
  renderToStaticMarkup(<Workbench record={r} shown={shown} />);

describe('the verify page fills the round in from this browser’s copy', () => {
  it('takes the hash, client seed and nonce from the copy, not the server’s record', () => {
    const form = formFrom(record(OTHER), { serverSeedHash: SHOWN, clientSeed: 'player-seed', nonce: 3 });
    expect(form.serverSeedHash).toBe(SHOWN);
    expect(form.clientSeed).toBe('player-seed');
    expect(form.nonce).toBe('3');
  });

  it('takes the client seed and nonce from the record for an older copy with only the hash', () => {
    const form = formFrom(record(OTHER), { serverSeedHash: SHOWN, clientSeed: null, nonce: null });
    expect(form.serverSeedHash).toBe(SHOWN);
    expect(form.clientSeed).toBe('record-seed');
    expect(form.nonce).toBe('7');
  });

  it('takes all three from the record when this browser has no copy', () => {
    const form = formFrom(record(OTHER), null);
    expect([form.serverSeedHash, form.clientSeed, form.nonce]).toEqual([OTHER, 'record-seed', '7']);
  });

  it('says on each field where its value came from', () => {
    expect(hashFieldLabel(SHOWN)).toMatch(/saved by this browser/);
    expect(hashFieldLabel(null)).toMatch(/server’s record/);
    expect(clientSeedFieldLabel('player-seed')).toBe('Client seed (saved by this browser before the round)');
    expect(clientSeedFieldLabel(null)).toBe('Client seed (the server’s record)');
    expect(nonceFieldLabel(0)).toBe('Nonce (saved by this browser before the round)');
    expect(nonceFieldLabel(null)).toBe('Nonce (the server’s record)');

    const html = page(record(OTHER), { serverSeedHash: SHOWN, clientSeed: null, nonce: null });
    expect(html).toContain('Server seed hash (saved by this browser before the round)');
    expect(html).toContain('Client seed (the server’s record)');
    expect(html).toContain('Nonce (the server’s record)');
  });

  it('says what a hash match proves, by where the hash came from', () => {
    expect(hashSource(SHOWN, SHOWN, OTHER)).toBe('browser');
    expect(hashSource(` ${SHOWN} `, SHOWN, OTHER)).toBe('browser');
    expect(hashSource(OTHER, null, OTHER)).toBe('server');
    // Typed over by the player, even to the server's value.
    expect(hashSource(OTHER, SHOWN, OTHER)).toBe('typed');
    expect(hashSource('abc', null, OTHER)).toBe('typed');

    expect(hashVerdict('browser', true)).toMatch(/^✓.*this browser showed you before the round/);
    expect(hashVerdict('browser', false)).toMatch(/^✗/);
    expect(hashVerdict('server', true)).toMatch(/^✓.*server’s record/);
    expect(hashVerdict('server', false)).toMatch(/^✗/);
    expect(hashVerdict('typed', true)).toMatch(/^✓.*typed/);
  });
});

describe('a record that names other values than this browser saved', () => {
  it('gets a plain problem line naming both, and the innocent cause', () => {
    expect(recordHashProblem(SHOWN, OTHER)).toContain(SHOWN);
    expect(recordHashProblem(SHOWN, OTHER)).toContain(OTHER);

    const seed = recordClientSeedProblem('player-seed', 'server-picked');
    expect(seed).toContain('“server-picked”');
    expect(seed).toContain('“player-seed”');
    expect(seed).toMatch(/another tab or on another device just before the round/);

    const nonce = recordNonceProblem(4, 9);
    expect(nonce).toContain('nonce 9');
    expect(nonce).toContain('nonce 4');
    expect(nonce).toMatch(/another tab or on another device just before this round/);
  });

  it('gets none when they agree, or when this browser has no copy to compare', () => {
    expect(recordHashProblem(SHOWN, SHOWN)).toBeNull();
    expect(recordHashProblem(null, OTHER)).toBeNull();
    expect(recordClientSeedProblem('same', 'same')).toBeNull();
    expect(recordClientSeedProblem(null, 'server-picked')).toBeNull();
    expect(recordNonceProblem(0, 0)).toBeNull();
    expect(recordNonceProblem(null, 9)).toBeNull();

    expect(recordProblems(null, record(OTHER))).toEqual([]);
    expect(recordProblems(copyOf(record(OTHER)), record(OTHER))).toEqual([]);
    expect(recordProblems({ serverSeedHash: OTHER, clientSeed: null, nonce: null }, record(OTHER))).toEqual(
      [],
    );
  });

  it('gets one line for each value that differs', () => {
    const r = record(OTHER);
    const lines = recordProblems({ serverSeedHash: SHOWN, clientSeed: 'player-seed', nonce: 2 }, r);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(SHOWN);
    expect(lines[1]).toContain('player-seed');
    expect(lines[2]).toContain('nonce 2');
  });
});

describe('without a copy, the page says the values are the server’s own record', () => {
  it('names the hash, client seed and nonce when this browser saved nothing', () => {
    const note = noRecordNote(null);
    expect(note).toMatch(/no record of the hash, client seed and nonce/);
    expect(note).toMatch(/another device/);
    expect(note).toMatch(/cleared/);
    expect(note).toMatch(/server’s own record/);
    expect(note).toMatch(/can’t catch a server that changed them/);
  });

  it('names the client seed and nonce for an older copy that has only the hash', () => {
    const note = noRecordNote({ serverSeedHash: SHOWN, clientSeed: null, nonce: null });
    expect(note).toMatch(/saved the hash/);
    expect(note).toMatch(/client seed and nonce checked here are the server’s own record/);
    expect(note).toMatch(/can’t catch a server that changed them/);
  });

  it('says nothing when this browser has all three', () => {
    expect(noRecordNote({ serverSeedHash: SHOWN, clientSeed: 'mine', nonce: 0 })).toBeNull();
  });

  it('shows the note on the page', () => {
    expect(page(record(OTHER), null)).toContain('no record of the hash, client seed and nonce');
    expect(page(record(OTHER), copyOf(record(OTHER)))).not.toContain('no record of');
  });
});

describe('the attack: a server that plays with values of its own and names them in its record', () => {
  it('an honest round, with this browser’s copy matching, checks out (the control)', async () => {
    const [r] = await playedRecords('player-seed', 1);
    if (!r) throw new Error('a round expected');
    expect(verifyRound(r).ok).toBe(true);
    const html = page(r, copyOf(r));
    expect(html).toContain(SUCCESS);
    expect(html).toContain('data-verdict="match"');
  });

  it('a record with another client seed does not check out, though its own seeds add up', async () => {
    // The server ignored the player's seed and played with one it picked.
    const [r] = await playedRecords('server-picked', 1);
    if (!r) throw new Error('a round expected');
    expect(verifyRound(r).ok).toBe(true);
    const shown = copyOf(r, { clientSeed: 'player-seed' });

    // As the page first shows it: the player's seed is filled in, and the
    // record is named as the problem.
    const html = page(r, shown);
    expect(html).not.toContain(SUCCESS);
    expect(html).toContain('data-verdict="mismatch"');
    expect(html).toContain('value="player-seed"');
    expect(html).toContain('“server-picked”');

    // Even with the record's own seed typed back in, which makes every
    // draw add up, it never checks out.
    const typedBack = verdictFor(r, shown, { ...formFrom(r, shown), clientSeed: 'server-picked' });
    expect(typedBack.result.ok).toBe(true);
    expect(typedBack.verdict.ok).toBe(false);
    expect(typedBack.verdict.headline).not.toContain(SUCCESS);
    expect(typedBack.verdict.problems.join(' ')).toContain('“player-seed”');
  });

  it('a record with another nonce of the same server seed does not check out, though it adds up', async () => {
    // Two rounds on one seed: the server says the second used nonce 1, but
    // this browser showed nonce 0 before it.
    const [, r] = await playedRecords('player-seed', 2);
    if (!r) throw new Error('a round expected');
    expect(r.nonce).toBe(1);
    expect(verifyRound(r).ok).toBe(true);
    const shown = copyOf(r, { nonce: 0 });

    const html = page(r, shown);
    expect(html).not.toContain(SUCCESS);
    expect(html).toContain('data-verdict="mismatch"');
    expect(html).toContain('nonce 1, but this browser saved nonce 0');

    const typedBack = verdictFor(r, shown, { ...formFrom(r, shown), nonce: '1' });
    expect(typedBack.result.ok).toBe(true);
    expect(typedBack.verdict.ok).toBe(false);
    expect(typedBack.verdict.headline).not.toContain(SUCCESS);
  });

  it('a record with another hash does not check out either (as before)', async () => {
    const [r] = await playedRecords('player-seed', 1);
    if (!r) throw new Error('a round expected');
    const shown = copyOf(r, { serverSeedHash: SHOWN });
    const html = page(r, shown);
    expect(html).not.toContain(SUCCESS);
    expect(html).toContain(`value="${SHOWN}"`);

    const typedBack = verdictFor(r, shown, { ...formFrom(r, shown), serverSeedHash: r.serverSeedHash });
    expect(typedBack.result.ok).toBe(true);
    expect(typedBack.verdict.ok).toBe(false);
  });

  it('typing in the revealed seed’s own hash, over the copy, never makes it check out', async () => {
    // The record names the hash this browser saved, but reveals a server
    // seed with another hash. The page shows that seed's hash; pasting it
    // into the field makes the seed check pass, but the round is not the
    // one that was shown.
    const [played] = await playedRecords('player-seed', 1);
    if (!played) throw new Error('a round expected');
    const r: VerifiableRound = { ...played, serverSeedHash: SHOWN };
    const shown = copyOf(r);
    expect(page(r, shown)).not.toContain(SUCCESS);

    const typed = verdictFor(r, shown, { ...formFrom(r, shown), serverSeedHash: hashServerSeed(r.serverSeed) });
    expect(typed.result.ok).toBe(true);
    expect(typed.verdict.ok).toBe(false);
    expect(typed.verdict.tone).toBe('cannot-check');
    expect(typed.verdict.headline).toMatch(/Reset to the recorded round/);
  });

  it('spacing typed around a value is not a change', async () => {
    const [r] = await playedRecords('player-seed', 1);
    if (!r) throw new Error('a round expected');
    const shown = copyOf(r);
    const form = formFrom(r, shown);
    const spaced = verdictFor(r, shown, { ...form, clientSeed: ` ${form.clientSeed} `, nonce: ` ${form.nonce}` });
    expect(spaced.verdict.ok).toBe(true);
    expect(spaced.verdict.headline).toContain(SUCCESS);
  });

  it('with only the server’s record to go on, the record is checked against itself, and the page says so', async () => {
    const [r] = await playedRecords('server-picked', 1);
    if (!r) throw new Error('a round expected');
    for (const shown of [null, { serverSeedHash: r.serverSeedHash, clientSeed: null, nonce: null }]) {
      const html = page(r, shown);
      expect(html).toContain(SUCCESS);
      expect(html).toContain('can’t catch a server that changed them');
      expect(html).toContain('Client seed (the server’s record)');
    }
  });
});
