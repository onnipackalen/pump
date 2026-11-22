import { GAME_CONFIG } from '@pump/engine';
import { hashServerSeed, verifyRound } from '@pump/engine/fair';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NetworkFailure } from '../src/api/client';
import type { ActionResult, RoundView, StartRoundRequest, VerifiableRound } from '../src/api/contract';
import {
  formFrom,
  roundFrom,
  roundToCheck,
  sameInputs,
  Workbench,
  type RoundForm,
} from '../src/components/VerifyPage';
import { DemoClient } from '../src/demo/DemoClient';
import { keepLostStartCopy, startRoundShown } from '../src/game/session';
import {
  clientSeedFieldLabel,
  noRecordNote,
  nonceFieldLabel,
  recordClientSeedProblem,
  recordFormProblem,
  recordIdProblem,
  recordNonceProblem,
  recordProblems,
  sameNonceProblem,
} from '../src/verify/copyCheck';
import { hashFieldLabel, hashSource, hashVerdict, recordHashProblem } from '../src/verify/hashCheck';
import {
  copiesWithSameNonce,
  rememberShown,
  shownFor,
  type HashStorage,
  type SeedsBeforeRound,
  type ShownSeeds,
} from '../src/verify/shownHashes';
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

/** localStorage as a Map. */
function memoryStorage(): HashStorage {
  const items = new Map<string, string>();
  return {
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => {
      items.set(k, v);
    },
  };
}

const BETS: StartRoundRequest = { difficultyId: 'easy', betsCents: [100, 250, 1000] };

/** Plays one round in the demo: a few pumps on each balloon, then cash out what is left. */
async function playRound(client: DemoClient): Promise<string> {
  const { round } = await client.startRound(BETS, key());
  return finishRound(client, round);
}

/** Plays a round in progress to its end: pumps to rung 2, then cash out. */
async function finishRound(client: DemoClient, started: RoundView): Promise<string> {
  let round = started;
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
function copyOf(r: VerifiableRound, change: Partial<SeedsBeforeRound> = {}): SeedsBeforeRound {
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
      recordProblems: recordProblems(r.id, shown, r),
      screenProblems: [],
      inputsChanged: !sameInputs(own, built),
      anyReveal: result.balloons.some((b) => b.afterRound !== null),
    }),
  };
}

/** The page as it first shows a round, asked for by its own id unless another is given. */
const page = (r: VerifiableRound, shown: ShownSeeds | null, roundId = r.id): string =>
  renderToStaticMarkup(<Workbench roundId={roundId} record={r} shown={shown} elsewhere={[]} />);

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

    expect(recordProblems('round-1', null, record(OTHER))).toEqual([]);
    expect(recordProblems('round-1', copyOf(record(OTHER)), record(OTHER))).toEqual([]);
    expect(
      recordProblems('round-1', { serverSeedHash: OTHER, clientSeed: null, nonce: null }, record(OTHER)),
    ).toEqual([]);
  });

  it('gets one line for each value that differs', () => {
    const r = record(OTHER);
    const lines = recordProblems('round-1', { serverSeedHash: SHOWN, clientSeed: 'player-seed', nonce: 2 }, r);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(SHOWN);
    expect(lines[1]).toContain('player-seed');
    expect(lines[2]).toContain('nonce 2');
  });
});

describe('without a copy, the page says the values are the server’s own record', () => {
  it('names the hash, client seed and nonce when this browser saved nothing', () => {
    const note = noRecordNote(null);
    expect(note).toMatch(/no copy of the hash, client seed and nonce/);
    expect(note).toMatch(/server’s own record/);
    expect(note).toMatch(/can’t catch a server that changed them/);
  });

  it('puts each cause as something that can happen, not as what did', () => {
    const note = noRecordNote(null) ?? '';
    expect(note).toMatch(/That happens if the round was played on another device or in another browser/);
    expect(note).toMatch(/cleared or could not be saved/);
    expect(note).toMatch(/connection was lost as the round started/);
    expect(note).toMatch(/older than the last 500 rounds this browser keeps/);
    // A copy is this browser's; "record" is only ever the server's.
    expect(note).not.toMatch(/no record of/);
  });

  it('names a server that gave the round another id as a cause, and says when the note is a warning sign', () => {
    const note = noRecordNote(null) ?? '';
    expect(note).toMatch(/server gave the round another id in its answers while you played it/);
    expect(note).toMatch(
      /If you played this round in this browser not long ago, and none of the other causes fits, take this note as a warning sign/,
    );
  });

  it('names the client seed and nonce for an older copy that has only the hash', () => {
    const note = noRecordNote({ serverSeedHash: SHOWN, clientSeed: null, nonce: null });
    expect(note).toMatch(/has a copy of the hash/);
    expect(note).toMatch(/older version of the game started this round/);
    expect(note).toMatch(/client seed and nonce checked here are the server’s own record/);
    expect(note).toMatch(/can’t catch a server that changed them/);
  });

  it('says nothing when this browser has all three', () => {
    expect(noRecordNote({ serverSeedHash: SHOWN, clientSeed: 'mine', nonce: 0 })).toBeNull();
  });

  it('shows the note on the page', () => {
    expect(page(record(OTHER), null)).toContain('no copy of the hash, client seed and nonce');
    expect(page(record(OTHER), copyOf(record(OTHER)))).not.toContain('no copy of');
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
    expect(typed.verdict.headline).toMatch(/Press “Reset the inputs”/);
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

describe('the record is checked against this browser’s copy of the round asked for', () => {
  /** Rounds the server played with its own client seed, while the screen showed the player's: their records and the copies this browser saved. */
  async function riggedRounds(count: number): Promise<{ records: VerifiableRound[]; storage: HashStorage }> {
    const records = await playedRecords('server-picked', count);
    const storage = memoryStorage();
    for (const r of [...records].reverse()) rememberShown(r.id, copyOf(r, { clientSeed: 'player-seed' }), storage);
    return { records, storage };
  }

  it('a record sent back under another id never checks out', async () => {
    const { records, storage } = await riggedRounds(1);
    const [r] = records;
    if (!r) throw new Error('a round expected');
    // The server answers the request for round r with r's record, which adds
    // up on its own, under an id this browser has no copy for.
    const renamed: VerifiableRound = { ...r, id: `${r.id}x` };
    expect(verifyRound(renamed).ok).toBe(true);
    expect(shownFor(renamed.id, storage)).toBeNull();

    const toCheck = roundToCheck(r.id, renamed, storage);
    expect(toCheck.shown?.clientSeed).toBe('player-seed');
    const html = renderToStaticMarkup(<Workbench {...toCheck} />);
    expect(html).not.toContain(SUCCESS);
    expect(html).toContain('data-verdict="mismatch"');
    expect(html).toContain(`asked the server for round ${r.id}, but the server sent the record of round ${r.id}x`);
    expect(html).toContain('“server-picked”');
    // Not told it has no copy: it has one.
    expect(html).not.toContain('no copy of');
  });

  it('a record under another id never checks out even when the seeds agree', async () => {
    const [r] = await playedRecords('player-seed', 1);
    if (!r) throw new Error('a round expected');
    const storage = memoryStorage();
    rememberShown(r.id, copyOf(r), storage);
    const html = renderToStaticMarkup(<Workbench {...roundToCheck(r.id, { ...r, id: 'another-id' }, storage)} />);
    expect(html).not.toContain(SUCCESS);
    expect(recordIdProblem(r.id, r.id)).toBeNull();
    expect(recordIdProblem(r.id, 'another-id')).toContain('another-id');
  });

  it('another round’s record, sent for this one, never checks out', async () => {
    // Two honest rounds, both with a copy that agrees with their own record.
    const [a, b] = await playedRecords('player-seed', 2);
    if (!a || !b) throw new Error('two rounds expected');
    const storage = memoryStorage();
    rememberShown(a.id, copyOf(a), storage);
    rememberShown(b.id, copyOf(b), storage);
    expect(page(b, copyOf(b))).toContain(SUCCESS);

    // Asked for a, the server sends b's record, as it is or with a's id.
    for (const sent of [b, { ...b, id: a.id }]) {
      const toCheck = roundToCheck(a.id, sent, storage);
      expect(toCheck.shown).toEqual(copyOf(a));
      const html = renderToStaticMarkup(<Workbench {...toCheck} />);
      expect(html).not.toContain(SUCCESS);
      expect(html).toContain('nonce 1, but this browser saved nonce 0');
    }
  });
});

/**
 * The start as a dishonest server treats it: it skips the check of the seeds
 * the screen showed (expectedSeeds), so it can play on seeds of its own.
 */
const unchecked = (request: StartRoundRequest): StartRoundRequest => ({
  difficultyId: request.difficultyId,
  betsCents: request.betsCents,
});

/**
 * A server that plays the round on a client seed of its own, then loses
 * every answer to the start (both tries), so the browser never sees the
 * round's id from the start itself.
 */
class RigsAndLosesStart extends DemoClient {
  private rigged = false;
  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    if (!this.rigged) {
      this.rigged = true;
      await super.setClientSeed('server-picked', key());
    }
    await super.startRound(unchecked(request), k);
    throw new NetworkFailure('The game server did not answer properly (502).');
  }
}

describe('a round whose start answer was lost is still checked against what was shown', () => {
  it('does not check out when the server played it on a client seed of its own', async () => {
    const client = new RigsAndLosesStart(GAME_CONFIG, 0);
    await client.setClientSeed('player-seed', key());
    const { fairness } = await client.getSession();
    const storage = memoryStorage();
    await expect(startRoundShown(client, BETS, fairness, storage)).rejects.toBeInstanceOf(NetworkFailure);

    // The screen loads the whole state again and plays the round it finds.
    const { activeRound } = await client.getSession();
    if (!activeRound) throw new Error('the start was applied');
    keepLostStartCopy(activeRound, storage);
    const id = await finishRound(client, activeRound);
    await client.rotateSeed(key());
    const r = await client.getVerifiableRound(id);
    expect(r.clientSeed).toBe('server-picked');
    expect(verifyRound(r).ok).toBe(true);

    const html = renderToStaticMarkup(<Workbench {...roundToCheck(id, r, storage)} />);
    expect(html).not.toContain(SUCCESS);
    expect(html).toContain('value="player-seed"');
    expect(html).toContain('“server-picked”');
  });
});

/**
 * A server that plays the round on a client seed it picked, and answers the
 * start under another id (`idFor`), saying the round uses the player's seed.
 * Its history and its record name the round's real id.
 */
class AnswersUnderAnotherId extends DemoClient {
  constructor(private readonly idFor: (realId: string) => string) {
    super(GAME_CONFIG, 0);
  }

  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    await super.setClientSeed('server-picked', key());
    const answer = await super.startRound(unchecked(request), k);
    return { ...answer, round: { ...answer.round, id: this.idFor(answer.round.id), clientSeed: 'player-seed' } };
  }
}

/** Plays one round through the game's own start (startRoundShown) on `client`, then reveals the seed. */
async function playThroughStart(
  client: DemoClient,
  storage: HashStorage,
): Promise<{ startId: string; record: VerifiableRound }> {
  await client.setClientSeed('player-seed', key());
  const { fairness } = await client.getSession();
  const { round: started } = await startRoundShown(client, BETS, fairness, storage);
  const { activeRound } = await client.getSession();
  if (!activeRound) throw new Error('the start was applied');
  const id = await finishRound(client, activeRound);
  await client.rotateSeed(key());
  // Found by id, not taken as the first: two rounds that end in the same
  // millisecond can come back in either order.
  const listed = (await client.getHistory(10)).find((r) => r.id === id);
  if (listed === undefined) throw new Error('the history lists the round by its real id');
  return { startId: started.id, record: await client.getVerifiableRound(id) };
}

describe('a server that answers the start under another id', () => {
  it('does not check out: the copy saved under the other id is found by its hash and nonce', async () => {
    const storage = memoryStorage();
    const { startId, record: r } = await playThroughStart(
      new AnswersUnderAnotherId((id) => `alias-${id}`),
      storage,
    );
    // The record adds up on its own, and this browser has no copy under its id.
    expect(r.clientSeed).toBe('server-picked');
    expect(verifyRound(r).ok).toBe(true);
    expect(shownFor(r.id, storage)).toBeNull();
    expect(copiesWithSameNonce(r.serverSeedHash, r.nonce, r.id, storage)).toEqual([
      [startId, r.serverSeedHash, 'player-seed', r.nonce],
    ]);

    const html = renderToStaticMarkup(<Workbench {...roundToCheck(r.id, r, storage)} />);
    expect(html).not.toContain(SUCCESS);
    expect(html).toContain('data-verdict="mismatch"');
    expect(html).toContain('“server-picked”');
    expect(html).toContain('“player-seed”');
    expect(html).toContain(`when it started round ${startId}`);
    // The fields are still the record's, and say so; the no-copy note warns.
    expect(html).toContain('Client seed (the server’s record)');
    expect(html).toContain('take this note as a warning sign');
  });

  it('does not check out when the server answers every start under one id, so the copies share it', async () => {
    const storage = memoryStorage();
    const client = new AnswersUnderAnotherId(() => 'same-alias');
    const { record: first } = await playThroughStart(client, storage);
    // The next start on the new seed, answered under the same id.
    const { record: second } = await playThroughStart(client, storage);
    for (const r of [first, second]) {
      expect(verifyRound(r).ok).toBe(true);
      const html = renderToStaticMarkup(<Workbench {...roundToCheck(r.id, r, storage)} />);
      expect(html).not.toContain(SUCCESS);
      expect(html).toContain('when it started round same-alias');
    }
  });

  it('does not check out when the start answer’s id is too long to keep', async () => {
    const storage = memoryStorage();
    const { startId, record: r } = await playThroughStart(
      new AnswersUnderAnotherId((id) => `${id}${'z'.repeat(130)}`),
      storage,
    );
    expect(startId.length).toBeGreaterThan(128);
    expect(shownFor(startId, storage)).toBeNull();
    const [copy] = copiesWithSameNonce(r.serverSeedHash, r.nonce, r.id, storage);
    expect(copy?.[0]).toBe(`?${startId}`.slice(0, 128));
    expect(copy?.[2]).toBe('player-seed');

    const html = renderToStaticMarkup(<Workbench {...roundToCheck(r.id, r, storage)} />);
    expect(html).not.toContain(SUCCESS);
    expect(html).toContain('data-verdict="mismatch"');
    expect(html).toContain('“player-seed”');
  });

  it('an honest round with no copy under its id, but a stand-in with its hash, nonce and client seed, still checks out', async () => {
    // Its start answer was lost, and the round was over before the next load.
    const [r] = await playedRecords('player-seed', 1);
    if (!r) throw new Error('a round expected');
    const storage = memoryStorage();
    rememberShown(`?start:${String(r.nonce)}:${r.serverSeedHash}`, copyOf(r), storage);
    const toCheck = roundToCheck(r.id, r, storage);
    expect(toCheck.elsewhere).toHaveLength(1);
    expect(recordProblems(r.id, toCheck.shown, r, toCheck.elsewhere)).toEqual([]);
    const html = renderToStaticMarkup(<Workbench {...toCheck} />);
    expect(html).toContain(SUCCESS);
    expect(html).toContain('no copy of the hash, client seed and nonce');
  });

  it('a copy with its hash and nonce under another round’s id never checks out, even with the same client seed', async () => {
    const [r] = await playedRecords('player-seed', 1);
    if (!r) throw new Error('a round expected');
    const storage = memoryStorage();
    rememberShown('another-round', copyOf(r), storage);
    const toCheck = roundToCheck(r.id, r, storage);
    const problems = recordProblems(r.id, toCheck.shown, r, toCheck.elsewhere);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('when it started round another-round');
    expect(problems[0]).toContain('used the rolls of round another-round again');
    const html = renderToStaticMarkup(<Workbench {...toCheck} />);
    expect(html).not.toContain(SUCCESS);
    expect(html).toContain('data-verdict="mismatch"');
  });

  it('with a full copy under the round’s id, copies under other ids are not looked at', async () => {
    // Two tabs showed nonce 0; the other one started its round first, so
    // this tab's copy (another-round) says nonce 0 for a round that used 1.
    const [r] = await playedRecords('player-seed', 1);
    if (!r) throw new Error('a round expected');
    const storage = memoryStorage();
    rememberShown('another-round', copyOf(r, { clientSeed: 'old-seed' }), storage);
    rememberShown(r.id, copyOf(r), storage);
    const toCheck = roundToCheck(r.id, r, storage);
    expect(toCheck.elsewhere).toEqual([]);
    expect(renderToStaticMarkup(<Workbench {...toCheck} />)).toContain(SUCCESS);
  });

  it('an older copy with only the hash still gets the copies with the same hash and nonce looked at', async () => {
    const [r] = await playedRecords('server-picked', 1);
    if (!r) throw new Error('a round expected');
    const storage = memoryStorage();
    storage.setItem('pump.shownSeedHashes', JSON.stringify([[r.id, r.serverSeedHash]]));
    rememberShown('alias-round', copyOf(r, { clientSeed: 'player-seed' }), storage);
    const html = renderToStaticMarkup(<Workbench {...roundToCheck(r.id, r, storage)} />);
    expect(html).not.toContain(SUCCESS);
    expect(html).toContain('when it started round alias-round');
  });

  it('the problem line names both client seeds, the other round, and the innocent cause', () => {
    const r = record(SHOWN);
    const line = sameNonceProblem(['alias-1', SHOWN, 'player-seed', 7], r);
    expect(line).toContain('“record-seed” with nonce 7');
    expect(line).toContain('“player-seed”');
    expect(line).toContain('when it started round alias-1');
    expect(line).toMatch(/One server seed and nonce belong to one round only/);
    expect(line).toMatch(/another tab or on another device just before round alias-1 started/);
    // A stand-in that names the record's client seed is that round's own copy.
    expect(sameNonceProblem([`?start:7:${SHOWN}`, SHOWN, 'record-seed', 7], r)).toBeNull();
    // Under another round's id it is a problem whatever the client seed.
    expect(sameNonceProblem(['alias-1', SHOWN, 'record-seed', 7], r)).toContain(
      'One server seed and nonce belong to one round only',
    );
    expect(recordProblems('round-1', null, r, [['alias-1', SHOWN, 'player-seed', 7]])).toHaveLength(1);
  });

  // The record as it arrives over the wire, with one field rewritten. The
  // form tidies these (it trims the hash and reads the nonce from text), so
  // the draws still add up; only the exact-form check stops them.
  const rewritten = (r: VerifiableRound, field: string, value: unknown): VerifiableRound =>
    JSON.parse(JSON.stringify({ ...r, [field]: value })) as VerifiableRound;

  // The last part says whether the lookup by hash and nonce misses the
  // record: it does for the hash and nonce, not for the client seed.
  it.each([
    ['the nonce sent as text', (r: VerifiableRound) => rewritten(r, 'nonce', String(r.nonce)), true],
    ['a space after the hash', (r: VerifiableRound) => rewritten(r, 'serverSeedHash', `${r.serverSeedHash} `), true],
    ['a space before the hash', (r: VerifiableRound) => rewritten(r, 'serverSeedHash', ` ${r.serverSeedHash}`), true],
    ['the hash in capitals', (r: VerifiableRound) => rewritten(r, 'serverSeedHash', r.serverSeedHash.toUpperCase()), true],
    ['a space after the client seed', (r: VerifiableRound) => rewritten(r, 'clientSeed', `${r.clientSeed} `), false],
  ])('does not check out when the record sends %s', async (_, reshape, lookupMisses) => {
    const storage = memoryStorage();
    const { record: played } = await playThroughStart(
      new AnswersUnderAnotherId((id) => `alias-${id}`),
      storage,
    );
    const r = reshape(played);
    // The lookup compares exact values, so it misses a reshaped hash or nonce.
    expect(roundToCheck(r.id, r, storage).elsewhere.length === 0).toBe(lookupMisses);
    const problems = recordProblems(r.id, null, r);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('in a form this game never sends');

    const html = renderToStaticMarkup(<Workbench {...roundToCheck(r.id, r, storage)} />);
    expect(html).not.toContain(SUCCESS);
    expect(html).toContain('data-verdict="mismatch"');
    expect(html).toContain('in a form this game never sends');
  });

  it('a record in the exact form a real server sends has no form problem (no false alarms)', async () => {
    const records = await playedRecords('player-seed', 3);
    for (const r of records) {
      expect(recordFormProblem(r)).toBeNull();
      // Through JSON, as it arrives.
      expect(recordFormProblem(JSON.parse(JSON.stringify(r)) as VerifiableRound)).toBeNull();
      expect(renderToStaticMarkup(<Workbench {...roundToCheck(r.id, r, memoryStorage())} />)).toContain(SUCCESS);
    }
  });
});
