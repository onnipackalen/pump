import { GAME_CONFIG } from '@pump/engine';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoundSummary } from '../src/api/contract';
import { RoundPicker, VerifyPage, type OlderRounds } from '../src/components/VerifyPage';
import { DemoClient } from '../src/demo/DemoClient';
import { HISTORY_SIZE } from '../src/game/session';
import {
  askForOlder,
  fitsOnTop,
  lastListed,
  laterMayHide,
  listedRounds,
  loadOlderPage,
  mayHaveOlder,
  OLDER_FAILED,
  OLDER_PAGE_SIZE,
  olderUnknownAfter,
  roundListStep,
  startRoundList,
  withSeedsKnown,
  type HistoryPages,
  type RoundListEvent,
  type RoundListState,
} from '../src/verify/roundList';

// The verify page lists the game's newest rounds, and loads older ones a
// page at a time with "Older rounds", so every finished round can be found
// and checked. These tests drive the list's own rule and the steps the page
// runs (roundList.ts: a press runs loadOlderPage, and a full list asks
// askForOlder) against the in-browser demo, which pages exactly like the
// server. The button itself is drawn with renderToStaticMarkup: there is no
// DOM here to click it in.
//
// The demo stamps its rounds with the clock, so the clock is faked: most
// tests move it on a second before each round, as real play does, and one
// keeps it still, so every round finishes in the same millisecond.

const key = (): string => crypto.randomUUID();
const DIFFICULTY = GAME_CONFIG.difficulties[0]?.id ?? 'easy';
const BET = GAME_CONFIG.limits.minBetCents;
const TODAY = new Date('2026-11-21T12:00:00.000Z').toDateString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-21T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

async function newDemo(): Promise<DemoClient> {
  const client = new DemoClient(GAME_CONFIG, 0);
  await client.setClientSeed('test-seed', key());
  return client;
}

/**
 * Plays `count` rounds of one balloon: one pump, then a cash-out if it is
 * still in play. The clock moves on `stepMs` before each round.
 */
async function play(client: DemoClient, count: number, stepMs = 1000): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) {
    vi.setSystemTime(Date.now() + stepMs);
    const { round: started } = await client.startRound({ difficultyId: DIFFICULTY, betsCents: [BET] }, key());
    const { round } = await client.pump(started.id, { balloonIndex: 0, expectedDrawIndex: 0, patch: false }, key());
    const balloon = round.balloons[0];
    if (round.status === 'active' && balloon) {
      await client.cashOut(round.id, { balloonIndex: 0, expectedDrawIndex: balloon.drawIndex }, key());
    }
    ids.push(started.id);
  }
  return ids;
}

/** Every finished round in the list's order, read straight from the client. */
async function everyRound(client: DemoClient): Promise<RoundSummary[]> {
  const all: RoundSummary[] = [];
  let before: string | null = null;
  for (;;) {
    const page = await client.getHistoryPage(50, before);
    all.push(...page.rounds);
    const last = page.rounds.at(-1);
    if (!page.more || last === undefined) return all;
    before = last.id;
  }
}

/** A list run as the page runs it: every event goes through the list's rule. */
function liveList(start: RoundListState) {
  let state = start;
  return {
    get state() {
      return state;
    },
    dispatch: (event: RoundListEvent): void => {
      state = roundListStep(state, event);
    },
  };
}

/** One press of "Older rounds": the step the button runs, loadOlderPage, with its answer taken in. */
async function pressOlder(client: HistoryPages, state: RoundListState): Promise<RoundListState> {
  if (lastListed(state) === null) throw new Error('nothing listed');
  const list = liveList(state);
  await loadOlderPage(client, state, list.dispatch);
  return list.state;
}

/** Presses "Older rounds" until the button goes. Returns the list and how many presses it took. */
async function pressUntilDone(client: DemoClient, start: RoundListState) {
  let state = start;
  let presses = 0;
  while (mayHaveOlder(state, HISTORY_SIZE)) {
    state = await pressOlder(client, state);
    presses += 1;
    if (presses > 100) throw new Error('the button never goes');
  }
  return { state, presses };
}

function ids(rounds: readonly RoundSummary[]): string[] {
  return rounds.map((r) => r.id);
}

/**
 * The list's promise: it is the start of the full list, each round once,
 * and the button shows whenever rounds are missing below.
 */
function expectStartOf(state: RoundListState, all: readonly RoundSummary[]): void {
  const listed = ids(listedRounds(state));
  expect(listed).toEqual(ids(all).slice(0, listed.length));
  if (listed.length < all.length) expect(mayHaveOlder(state, HISTORY_SIZE)).toBe(true);
}

function picker(state: RoundListState, revealedHashes: readonly string[] = []): string {
  const older: OlderRounds = {
    shown: mayHaveOlder(state, HISTORY_SIZE),
    loading: state.loadingAfter !== null,
    failure: state.failure,
  };
  return renderToStaticMarkup(
    <RoundPicker
      config={GAME_CONFIG}
      rounds={withSeedsKnown(listedRounds(state), revealedHashes)}
      current={null}
      today={TODAY}
      older={older}
      onCheck={() => undefined}
      onOlder={() => undefined}
    />,
  );
}

const count = (html: string, text: string): number => html.split(text).length - 1;

describe('the verify page’s list of rounds', () => {
  it('reaches a round older than the game’s list with the "Older rounds" step, each round once and in order', async () => {
    const client = await newDemo();
    const early = await play(client, 30);
    await client.rotateSeed(key());
    await play(client, 17);
    const truth = await everyRound(client);
    expect(truth).toHaveLength(47);

    const newest = await client.getHistory(HISTORY_SIZE);
    const start = startRoundList(newest);
    expect(ids(listedRounds(start))).toEqual(ids(truth).slice(0, HISTORY_SIZE));
    // The very first round is not in the game's list.
    expect(ids(newest)).not.toContain(early[0]);
    const before = picker(start);
    expect(before).toContain('Older rounds');
    for (const round of newest) expect(before).toContain(round.id);

    const { state, presses } = await pressUntilDone(client, start);
    expect(presses).toBe(Math.ceil((47 - HISTORY_SIZE) / OLDER_PAGE_SIZE));
    const listed = listedRounds(state);
    expect(ids(listed)).toEqual(ids(truth));
    expect(new Set(ids(listed)).size).toBe(listed.length);
    expect(ids(listed)).toContain(early[0]);

    // Every round shows its id, and every round on the rotated seed can be
    // checked; the button is gone.
    const after = picker(state);
    expect(after).not.toContain('Older rounds');
    for (const round of truth) expect(after).toContain(`title="${round.id}"`);
    expect(count(after, '>Check</button>')).toBe(30);
    expect(count(after, 'Seed in use')).toBe(17);
  });

  it('has no button when every round the player has fits in the game’s list', async () => {
    const client = await newDemo();
    await play(client, 4);
    const state = startRoundList(await client.getHistory(HISTORY_SIZE));
    expect(mayHaveOlder(state, HISTORY_SIZE)).toBe(false);
    expect(picker(state)).not.toContain('Older rounds');
    expect(picker(startRoundList([]))).toContain('No finished rounds yet.');
  });

  it('stays right while rounds are played and the seed is rotated with the page open', async () => {
    const client = await newDemo();
    await play(client, 25);
    let { state } = await pressUntilDone(client, startRoundList(await client.getHistory(HISTORY_SIZE)));
    expect(ids(listedRounds(state))).toEqual(ids(await everyRound(client)));

    // Rounds end one by one, and the game loads its list after each.
    for (let n = 0; n < 4; n += 1) {
      await play(client, 1);
      state = roundListStep(state, { type: 'newest', rounds: await client.getHistory(HISTORY_SIZE) });
      expect(ids(listedRounds(state))).toEqual(ids(await everyRound(client)));
    }
    // Nothing older was asked for, and none is missing: still no button.
    expect(mayHaveOlder(state, HISTORY_SIZE)).toBe(false);
    expect(picker(state)).toContain('Seed in use');

    // The seed is rotated. The game's list comes back with the new seed
    // states, and the older rounds on that seed follow it.
    const rotated = await client.rotateSeed(key());
    state = roundListStep(state, { type: 'newest', rounds: await client.getHistory(HISTORY_SIZE) });
    const html = picker(state);
    expect(html).not.toContain('Seed in use');
    expect(count(html, '>Check</button>')).toBe(29);

    // The same if the game's list did not come back: the rotation alone says so.
    const stale = startRoundList(listedRounds(state).map((r) => ({ ...r, seedRevealed: false })));
    expect(picker(stale)).toContain('Seed in use');
    expect(picker(stale, [rotated.revealed.serverSeedHash])).not.toContain('Seed in use');

    // A round played on the new seed is in use, and is listed once.
    await play(client, 1);
    state = roundListStep(state, { type: 'newest', rounds: await client.getHistory(HISTORY_SIZE) });
    const listed = listedRounds(state);
    expect(ids(listed)).toEqual(ids(await everyRound(client)));
    expect(withSeedsKnown(listed, [rotated.revealed.serverSeedHash]).filter((r) => !r.seedRevealed)).toHaveLength(1);
  });

  it('starts again from the game’s list when it no longer joins up, and drops the page on its way', async () => {
    const client = await newDemo();
    await play(client, 30);
    let state = await pressOlder(client, startRoundList(await client.getHistory(HISTORY_SIZE)));
    expect(listedRounds(state)).toHaveLength(HISTORY_SIZE + OLDER_PAGE_SIZE);

    // A press goes out, then more rounds end than the game's list holds
    // before the list is loaded again: rounds may be missing in between.
    const before = lastListed(state) ?? '';
    state = roundListStep(state, { type: 'asked', before });
    const lateAnswer = await client.getHistoryPage(OLDER_PAGE_SIZE, before);
    await play(client, HISTORY_SIZE + 1);
    const newest = await client.getHistory(HISTORY_SIZE);
    expect(fitsOnTop(newest, listedRounds(state))).toBe(false);
    state = roundListStep(state, { type: 'newest', rounds: newest });
    expect(ids(listedRounds(state))).toEqual(ids(newest));
    expect(mayHaveOlder(state, HISTORY_SIZE)).toBe(true);

    // The answer to the press from before is dropped: it would not join up.
    const after = roundListStep(state, { type: 'answered', before, page: lateAnswer });
    expect(after).toBe(state);

    // Pressing again reaches every round, each once.
    const done = await pressUntilDone(client, state);
    expect(ids(listedRounds(done.state))).toEqual(ids(await everyRound(client)));
  });

  it('keeps its promise when every round finishes in the same millisecond', async () => {
    const client = await newDemo();
    // The clock stands still: every round ties on finish and start time,
    // so the order is by id alone, and a new round can land anywhere in it.
    await play(client, 25, 0);
    let { state } = await pressUntilDone(client, startRoundList(await client.getHistory(HISTORY_SIZE)));
    expect(ids(listedRounds(state))).toEqual(ids(await everyRound(client)));
    for (let n = 0; n < 8; n += 1) {
      await play(client, 1, 0);
      if (n === 4) await client.rotateSeed(key());
      state = roundListStep(state, { type: 'newest', rounds: await client.getHistory(HISTORY_SIZE) });
      const all = await everyRound(client);
      expectStartOf(state, all);
      // Pressing on reaches every round, each once.
      ({ state } = await pressUntilDone(client, state));
      expect(ids(listedRounds(state))).toEqual(ids(all));
    }
  });

  it('shows a failed page and lets the player try again', async () => {
    const client = await newDemo();
    await play(client, 12);
    const start = startRoundList(await client.getHistory(HISTORY_SIZE));
    const before = lastListed(start) ?? '';
    const failed = roundListStep(roundListStep(start, { type: 'asked', before }), { type: 'failed', before });
    expect(failed.failure).toBe(OLDER_FAILED);
    expect(failed.loadingAfter).toBeNull();
    const html = picker(failed);
    expect(html).toContain(OLDER_FAILED);
    expect(html).toContain('Older rounds');
    const retried = await pressOlder(client, failed);
    expect(retried.failure).toBeNull();
    expect(ids(listedRounds(retried))).toEqual(ids(await everyRound(client)));
  });

  it('never lists a round twice, even if a page repeats one', async () => {
    const client = await newDemo();
    await play(client, 12);
    const start = startRoundList(await client.getHistory(HISTORY_SIZE));
    const before = lastListed(start) ?? '';
    const page = await client.getHistoryPage(OLDER_PAGE_SIZE, before);
    const repeated = { rounds: [...start.newest.slice(-2), ...page.rounds, ...page.rounds], more: false };
    const state = roundListStep(roundListStep(start, { type: 'asked', before }), {
      type: 'answered',
      before,
      page: repeated,
    });
    expect(ids(listedRounds(state))).toEqual(ids(await everyRound(client)));
  });

  it('asks once while a page is on its way, never lists a round twice, and shows a failure', async () => {
    const client = await newDemo();
    await play(client, 40);
    const truth = await everyRound(client);
    const start = startRoundList(await client.getHistory(HISTORY_SIZE));
    let asked = 0;
    const counting: HistoryPages = {
      getHistoryPage: (limit, before) => {
        asked += 1;
        return client.getHistoryPage(limit, before);
      },
    };
    const list = liveList(start);
    const first = loadOlderPage(counting, list.state, list.dispatch);
    // The list knows at once that a page is on its way (the button shows
    // "Loading…"): another press now asks nothing.
    const second = loadOlderPage(counting, list.state, list.dispatch);
    // A press that still sees the list from before does ask again, but only
    // one answer is taken in.
    const stale = loadOlderPage(counting, start, list.dispatch);
    await Promise.all([first, second, stale]);
    expect(asked).toBe(2);
    expect(ids(listedRounds(list.state))).toEqual(ids(truth).slice(0, HISTORY_SIZE + OLDER_PAGE_SIZE));

    const broken: HistoryPages = { getHistoryPage: () => Promise.reject(new Error('offline')) };
    const failed = liveList(list.state);
    await loadOlderPage(broken, failed.state, failed.dispatch);
    expect(failed.state.failure).toBe(OLDER_FAILED);
    expect(failed.state.loadingAfter).toBeNull();
    expect(mayHaveOlder(failed.state, HISTORY_SIZE)).toBe(true);
  });

  it.each([
    [HISTORY_SIZE, false],
    [HISTORY_SIZE + 1, true],
  ])('with %i rounds, a full list asks the server first, so the button shows only if older rounds remain', async (played, more) => {
    const client = await newDemo();
    await play(client, played);
    const list = liveList(startRoundList(await client.getHistory(HISTORY_SIZE)));
    // Before the answer the button shows: older rounds may remain.
    expect(mayHaveOlder(list.state, HISTORY_SIZE)).toBe(true);
    const after = olderUnknownAfter(list.state, HISTORY_SIZE);
    expect(after).toBe(lastListed(list.state));
    await askForOlder(client, after ?? '', list.dispatch);
    expect(list.state.more).toBe(more);
    expect(mayHaveOlder(list.state, HISTORY_SIZE)).toBe(more);
    expect(picker(list.state).includes('Older rounds')).toBe(more);
    // Once it is known, the page does not ask again.
    expect(olderUnknownAfter(list.state, HISTORY_SIZE)).toBeNull();
  });

  it('asks nothing for a short list, keeps the button if the question fails, and drops a stale answer', async () => {
    const client = await newDemo();
    await play(client, 4);
    expect(olderUnknownAfter(startRoundList(await client.getHistory(HISTORY_SIZE)), HISTORY_SIZE)).toBeNull();
    expect(olderUnknownAfter(startRoundList([]), HISTORY_SIZE)).toBeNull();

    await play(client, 30);
    const list = liveList(startRoundList(await client.getHistory(HISTORY_SIZE)));
    const after = olderUnknownAfter(list.state, HISTORY_SIZE) ?? '';
    const broken: HistoryPages = { getHistoryPage: () => Promise.reject(new Error('offline')) };
    await askForOlder(broken, after, list.dispatch);
    expect(list.state.more).toBeNull();
    expect(mayHaveOlder(list.state, HISTORY_SIZE)).toBe(true);
    expect(list.state.failure).toBeNull();

    // An answer about a round that is no longer the last one listed, or
    // that comes after a page has already said, changes nothing.
    const paged = await pressOlder(client, list.state);
    expect(roundListStep(paged, { type: 'checked', after, more: false })).toBe(paged);
    const restarted = startRoundList((await client.getHistory(HISTORY_SIZE)).slice(0, 9));
    expect(roundListStep(restarted, { type: 'checked', after: 'not-the-last', more: false })).toBe(restarted);
  });

  it('draws the whole page with the button and the ids from the game’s list', async () => {
    const client = await newDemo();
    await play(client, 11);
    const rounds = await client.getHistory(HISTORY_SIZE);
    const html = renderToStaticMarkup(
      <VerifyPage
        client={client}
        config={GAME_CONFIG}
        rounds={rounds}
        revealedSeedHashes={[]}
        initialRoundId={null}
        canRotate
        onRotate={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(html).toContain('Older rounds');
    for (const round of rounds) expect(html).toContain(round.id);
    expect(html).toContain('Rotate server seed');
  });
});

describe('when a new list of newest rounds joins up with the one shown', () => {
  // Rounds named a, b, c, ...: a later letter finished a second later.
  const r = (id: string): RoundSummary => ({
    id,
    difficultyId: DIFFICULTY,
    balloonCount: 1,
    betCents: BET,
    patchesCents: 0,
    payoutCents: 0,
    refundedCents: 0,
    serverSeedHash: 'a'.repeat(64),
    nonce: 0,
    finishedAt: `2026-11-21T10:00:${String(id.charCodeAt(0) - 96).padStart(2, '0')}.000Z`,
    seedRevealed: false,
  });
  const list = (...names: string[]): RoundSummary[] => names.map(r);

  it.each([
    ['the same list', list('c', 'b', 'a'), list('c', 'b', 'a'), true],
    ['newer rounds on top', list('e', 'd', 'c'), list('c', 'b', 'a'), true],
    ['one newer round, a short list', list('d', 'c', 'b', 'a'), list('c', 'b', 'a'), true],
    ['nothing shown yet', list('b', 'a'), [], true],
    ['no round in common', list('f', 'e', 'd'), list('c', 'b', 'a'), false],
    ['another order', list('d', 'b', 'c'), list('c', 'b', 'a'), false],
    ['a round missing in between', list('d', 'c', 'a'), list('c', 'b', 'a'), false],
    ['longer than the list below', list('d', 'c', 'b', 'a', 'z'), list('c', 'b', 'a'), false],
    ['an empty new list', [], list('c', 'b', 'a'), false],
  ])('%s', (_label, top, listed, fits) => {
    expect(fitsOnTop(top, listed)).toBe(fits);
  });

  it('sees when a later round could be out of sight: only on a tie with the newest round listed', () => {
    expect(laterMayHide(list('e', 'd', 'c'), list('d', 'c', 'b'))).toBe(false);
    // The game's list ends on the newest round listed: a round that ended
    // in that same millisecond could sort below it.
    expect(laterMayHide(list('f', 'e', 'd'), list('d', 'c', 'b'))).toBe(true);
    const tied = list('d', 'c', 'b').map((round) => ({ ...round, finishedAt: '2026-11-21T10:00:09.000Z' }));
    expect(laterMayHide(tied, tied)).toBe(true);
    expect(laterMayHide([], list('a'))).toBe(false);
  });

  it('keeps the older rounds under the new ones, each once, and starts again when it must', () => {
    let state = startRoundList(list('d', 'c', 'b'));
    state = roundListStep(state, { type: 'asked', before: 'b' });
    state = roundListStep(state, { type: 'answered', before: 'b', page: { rounds: list('a'), more: false } });
    expect(ids(listedRounds(state))).toEqual(['d', 'c', 'b', 'a']);
    state = roundListStep(state, { type: 'newest', rounds: list('e', 'd', 'c') });
    expect(ids(listedRounds(state))).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(state.more).toBe(false);
    // No round in common: start again, and older rounds may be there.
    state = roundListStep(state, { type: 'newest', rounds: list('h', 'g', 'f') });
    expect(ids(listedRounds(state))).toEqual(['h', 'g', 'f']);
    expect(state.more).toBeNull();
    expect(mayHaveOlder(state, 3)).toBe(true);
    state = roundListStep(state, { type: 'newest', rounds: list('i', 'h', 'g') });
    expect(ids(listedRounds(state))).toEqual(['i', 'h', 'g', 'f']);
  });
});
