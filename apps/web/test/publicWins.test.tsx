import { GAME_CONFIG, type GameConfig } from '@pump/engine';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PublicWin, PublicWinsResponse, SessionView } from '../src/api/contract';
import { HttpClient } from '../src/api/httpClient';
import {
  canToggle,
  LOAD_FAILED,
  privateWinsStep,
  PrivateWinsView,
  SAVE_FAILED,
  START_PRIVATE_WINS,
  type PrivateWinsEvent,
  type PrivateWinsState,
} from '../src/components/PrivateWinsRow';
import { DemoClient } from '../src/demo/DemoClient';
import {
  answered,
  failed,
  MIN_GAP_MS,
  nextFetchIn,
  POLL_MS,
  RECHECK_MS,
  seen,
  sent,
  START_WATCH,
  tabShown,
  wanted,
  type WinsWatch,
} from '../src/wins/polling';
import { PublicWins, PublicWinsPanel, WINS_TABS, type WinsList } from '../src/wins/PublicWins';
import { SHEET_SLACK_PX, winsMayJoin } from '../src/wins/sheetFirst';
import { configWith, surestStart } from './fixtures';

const key = (): string => crypto.randomUUID();

function win(overrides: Partial<PublicWin> = {}): PublicWin {
  return {
    playerTag: 'a1b2c3',
    difficultyId: GAME_CONFIG.difficulties[0]?.id ?? 'easy',
    wageredCents: 100,
    payoutCents: 250,
    netCents: 150,
    multiplierHundredths: 250,
    finishedAt: '2026-11-21T10:00:00.000Z',
    ...overrides,
  };
}

const NONE: PublicWinsResponse = { enabled: true, recent: [], biggest: [], luckiest: [] };

// ------------------------------------------------------------------ Clients

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly key: string | null;
  readonly contentType: string | null;
  readonly body: string | null;
}

/** A fetch that answers like the server and records every request. */
function fakeServer(answers: Record<string, unknown>): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const session: SessionView = {
    wallet: { balanceCents: 1_000_000 },
    fairness: { serverSeedHash: 'e'.repeat(64), clientSeed: 'mine', nextNonce: 0 },
    activeRound: null,
  };
  const send: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    sent.push({
      url,
      method: init?.method ?? 'GET',
      key: headers.get('idempotency-key'),
      contentType: headers.get('content-type'),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const value = url === '/api/session' ? session : answers[url];
    return Promise.resolve(
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch: send, sent };
}

describe('HttpClient: public wins and settings', () => {
  it('asks for the wins at once, without loading a session or sending a key', async () => {
    const lists: PublicWinsResponse = { ...NONE, recent: [win()] };
    const server = fakeServer({ '/api/wins': lists });
    const answer = await new HttpClient(server.fetch).getPublicWins();
    expect(answer).toEqual(lists);
    expect(server.sent).toEqual([
      { url: '/api/wins', method: 'GET', key: null, contentType: null, body: null },
    ]);
  });

  it('reads the settings as the player: the session first', async () => {
    const server = fakeServer({ '/api/settings': { winsPrivate: true } });
    expect(await new HttpClient(server.fetch).getSettings()).toEqual({ winsPrivate: true });
    expect(server.sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /api/session',
      'GET /api/settings',
    ]);
    expect(server.sent[1]?.key).toBeNull();
  });

  it('saves the settings with PUT, a JSON body of winsPrivate only and the Idempotency-Key', async () => {
    const server = fakeServer({ '/api/settings': { winsPrivate: true } });
    // Anything beyond the contract's one field is not sent.
    const extra = { winsPrivate: true, sneaky: 1 } as { winsPrivate: boolean };
    const saved = await new HttpClient(server.fetch).setSettings(extra, 'key-123');
    expect(saved).toEqual({ winsPrivate: true });
    expect(server.sent[1]).toEqual({
      url: '/api/settings',
      method: 'PUT',
      key: 'key-123',
      contentType: 'application/json',
      body: '{"winsPrivate":true}',
    });
  });
});

/**
 * The difficulty the demo wins are played on: one whose first pump survives
 * at least half the time (Easy, as shipped), so 50 tries miss a win with a
 * chance of at most 1 in 2^50, whatever difficulty the config puts first.
 */
const SURE = surestStart(GAME_CONFIG.rtpBp);
const SURE_CONFIG = configWith(SURE);

/** Plays one-balloon rounds in the demo (one pump, then cash out) until each bet has won once. */
async function playWins(client: DemoClient, betsCents: readonly number[]): Promise<void> {
  for (const betCents of betsCents) {
    for (let tries = 0; tries < 50; tries += 1) {
      const { round } = await client.startRound(
        { difficultyId: SURE.id, betsCents: [betCents] },
        key(),
      );
      const pumped = await client.pump(
        round.id,
        { balloonIndex: 0, expectedDrawIndex: 0, patch: false },
        key(),
      );
      if (pumped.outcome === 'popped') continue;
      if (pumped.round.status === 'active') {
        await client.cashOut(round.id, { balloonIndex: 0, expectedDrawIndex: 1 }, key());
      }
      break;
    }
  }
}

describe('DemoClient: public wins and settings', () => {
  it('lists the demo player’s own wins in the three orders, all under one tag', async () => {
    const client = new DemoClient(SURE_CONFIG, 0);
    await client.setClientSeed('demo-seed', key());
    expect(await client.getPublicWins()).toEqual(NONE);

    await playWins(client, [100, 1000, 300]);
    const wins = await client.getPublicWins();
    expect(wins.enabled).toBe(true);
    expect(wins.recent.map((w) => w.wageredCents)).toEqual([300, 1000, 100]);
    expect(wins.biggest.map((w) => w.wageredCents)).toEqual([1000, 300, 100]);
    expect(new Set(wins.recent.map((w) => w.playerTag)).size).toBe(1);
    expect(wins.recent[0]?.playerTag).toMatch(/^[0-9a-f]{6}$/);
    for (const w of wins.recent) {
      // Integer cents, a real gain, and the multiplier the balloon cashed out at.
      expect(Number.isSafeInteger(w.payoutCents)).toBe(true);
      expect(w.netCents).toBe(w.payoutCents - w.wageredCents);
      expect(w.netCents).toBeGreaterThan(0);
      expect(w.difficultyId).toBe(SURE.id);
      expect(w.multiplierHundredths).toBe(SURE.ladder[0]);
    }
    expect(wins.luckiest).toHaveLength(3);
  });

  it('keeps the wins out of the lists while private, past ones too, and back when not', async () => {
    const client = new DemoClient(SURE_CONFIG, 0);
    await client.setClientSeed('demo-seed', key());
    await playWins(client, [100]);
    expect(await client.getSettings()).toEqual({ winsPrivate: false });

    const saveKey = key();
    expect(await client.setSettings({ winsPrivate: true }, saveKey)).toEqual({ winsPrivate: true });
    expect(await client.getPublicWins()).toEqual(NONE);
    // A repeat of the same key is the same action: it changes nothing again.
    await client.setSettings({ winsPrivate: false }, key());
    expect(await client.setSettings({ winsPrivate: true }, saveKey)).toEqual({ winsPrivate: true });
    expect(await client.getSettings()).toEqual({ winsPrivate: false });
    expect((await client.getPublicWins()).recent).toHaveLength(1);
  });
});

// -------------------------------------------------------------------- Panel

function panel(wins: PublicWinsResponse, list: WinsList = 'recent', config: GameConfig = GAME_CONFIG): string {
  return renderToStaticMarkup(
    <PublicWinsPanel wins={wins} config={config} list={list} onList={() => undefined} />,
  );
}

/** The text of each body row's cells. */
function rows(html: string): string[][] {
  const body = /<tbody>(.*)<\/tbody>/.exec(html)?.[1] ?? '';
  return [...body.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((row) =>
    [...(row[1] ?? '').matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((cell) => cell[1] ?? ''),
  );
}

describe('Public wins panel', () => {
  const lists: PublicWinsResponse = {
    enabled: true,
    recent: [
      win({ playerTag: '00aa11', wageredCents: 1000, payoutCents: 1101, netCents: 101, multiplierHundredths: 110 }),
      win({ playerTag: 'ffee99', difficultyId: 'custom-x', wageredCents: 123_456, payoutCents: 9_999_999, netCents: 9_876_543, multiplierHundredths: 500_000 }),
    ],
    biggest: [win({ playerTag: 'b1661e' })],
    luckiest: [],
  };

  it('shows one row per win, money in whole cents and the difficulty’s name', () => {
    const label = GAME_CONFIG.difficulties[0]?.label ?? '';
    expect(rows(panel(lists))).toEqual([
      ['00aa11', label, '$10.00', '1.10×', '$11.01', '+$1.01'],
      // An id the config does not know is shown as it is.
      ['ffee99', 'custom-x', '$1,234.56', '5,000.00×', '$99,999.99', '+$98,765.43'],
    ]);
  });

  it('colours the gain mint, and nothing else', () => {
    const html = panel(lists);
    expect(html.match(/class="num win"/g)).toHaveLength(2);
    expect(html.match(/class="[^"]*\bwin\b[^"]*"/g)).toHaveLength(2);
  });

  it('has a heading, column headers and a caption naming the list', () => {
    const html = panel(lists, 'recent');
    expect(html).toMatch(/<section[^>]*aria-labelledby="([^"]+)"[^>]*>.*<h2 id="\1"[^>]*>Wins<\/h2>/);
    for (const name of ['Player', 'Difficulty', 'Bet', 'Payout', 'Gain']) {
      expect(html).toMatch(new RegExp(`<th scope="col"[^>]*>${name}</th>`));
    }
    // A round's best balloon: Bet times it is not the payout with two or three.
    expect(html).toContain(
      '<th scope="col" class="num" title="The best balloon&#x27;s multiplier"><span aria-hidden="true">Best ×</span><span class="visually-hidden">Best multiplier</span></th>',
    );
    expect(html).not.toContain('>Multiplier<');
    expect(html).toContain('<caption class="visually-hidden">Recent wins</caption>');
    // No live region: the lists change every few seconds.
    expect(html).not.toContain('aria-live');
    expect(html).not.toContain('role="status"');
  });

  it('has three tabs, one selected and one tab stop, that control the list', () => {
    const html = panel(lists, 'biggest');
    expect(html).toContain('role="tablist"');
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)];
    expect(tabs.map((t) => t[1])).toEqual(WINS_TABS.map((t) => t.label));
    expect(WINS_TABS.map((t) => t.label)).toEqual(['Recent', 'Biggest', 'Lucky']);
    const selected = tabs.filter((t) => t[0].includes('aria-selected="true"'));
    expect(selected.map((t) => t[1])).toEqual(['Biggest']);
    expect(tabs.filter((t) => t[0].includes('tabindex="0"'))).toHaveLength(1);
    const panelId = /role="tabpanel"/.test(html) ? /<div id="([^"]+)" role="tabpanel"/.exec(html)?.[1] : null;
    expect(panelId).toBeTruthy();
    for (const tab of tabs) expect(tab[0]).toContain(`aria-controls="${panelId ?? ''}"`);
    expect(rows(html).map((r) => r[0])).toEqual(['b1661e']);
  });

  it('says so when a list is empty', () => {
    const html = panel(lists, 'luckiest');
    expect(html).toContain('No wins yet.');
    expect(html).not.toContain('<table');
  });

  it('shows nothing at all before the server has answered', () => {
    const html = renderToStaticMarkup(
      <PublicWins client={new DemoClient(GAME_CONFIG, 0)} config={GAME_CONFIG} latestRoundId={null} shown />,
    );
    expect(html).toBe('');
  });

  it('shows nothing at all while the server says off, whatever the lists hold', () => {
    const off: PublicWinsResponse = { enabled: false, recent: [win()], biggest: [win()], luckiest: [win()] };
    for (const which of WINS_TABS) expect(panel(off, which.list)).toBe('');
    expect(panel({ ...off, enabled: true })).not.toBe('');
  });

  it('waits off the page while an upright sheet is down, and only then', () => {
    const at = (waiting: boolean): string =>
      renderToStaticMarkup(
        <PublicWinsPanel wins={lists} config={GAME_CONFIG} list="recent" onList={() => undefined} waiting={waiting} />,
      );
    expect(at(true)).toMatch(/^<section[^>]* data-waiting=""/);
    expect(at(false)).not.toContain('data-waiting');
  });

  it('cuts a long difficulty name in its cell and keeps it whole in the title', () => {
    const html = panel({ ...NONE, recent: [win({ difficultyId: 'some-future-difficulty' })] });
    expect(html).toContain('<td class="pw-difficulty" title="some-future-difficulty">some-future-difficulty</td>');
  });

  it('is kept but hidden while another page shows', () => {
    const html = renderToStaticMarkup(
      <PublicWinsPanel wins={lists} config={GAME_CONFIG} list="recent" onList={() => undefined} hidden />,
    );
    expect(html).toMatch(/^<section[^>]* hidden=""/);
  });
});

// ------------------------------------------------------------- Polling rule

const T = 1_000_000;

function watch(overrides: Partial<WinsWatch> = {}): WinsWatch {
  return { ...START_WATCH, ...overrides };
}

describe('When the wins are asked for', () => {
  it('asks once at page load, even off screen, to learn whether they are on', () => {
    expect(nextFetchIn(watch(), T)).toBe(0);
    expect(nextFetchIn(watch({ tabVisible: false }), T)).toBeNull();
  });

  it('never asks again once the server said off', () => {
    const off = answered(sent(watch({ onScreen: true, wantSoon: true }), T), false);
    for (const later of [T, T + MIN_GAP_MS, T + 3_600_000]) expect(nextFetchIn(off, later)).toBeNull();
    expect(nextFetchIn(wanted(tabShown(seen(off, true), true)), T + 60_000)).toBeNull();
  });

  it('asks again only while on screen and the tab is in front', () => {
    const on = answered(sent(watch(), T), true);
    expect(nextFetchIn(on, T + 60_000)).toBeNull();
    const shown = seen(on, true);
    expect(nextFetchIn({ ...shown, tabVisible: false }, T + 60_000)).toBeNull();
  });

  it('refreshes every ten seconds on screen, five after something new is wanted', () => {
    const on = { ...answered(sent(watch({ onScreen: true }), T), true) };
    expect(nextFetchIn(on, T + 1_000)).toBe(POLL_MS - 1_000);
    expect(nextFetchIn(wanted(on), T + 1_000)).toBe(MIN_GAP_MS - 1_000);
    expect(nextFetchIn(wanted(on), T + 8_000)).toBe(0);
    expect(POLL_MS).toBe(10_000);
    expect(MIN_GAP_MS).toBe(5_000);
  });

  it('wants fresh lists soon when they come on screen or the tab comes back, not when they leave', () => {
    const on = answered(sent(watch(), T), true);
    expect(seen(on, true).wantSoon).toBe(true);
    expect(seen({ ...on, onScreen: true }, false).wantSoon).toBe(false);
    expect(tabShown({ ...on, tabVisible: false }, true).wantSoon).toBe(true);
    expect(tabShown(on, false).wantSoon).toBe(false);
    // The same value twice changes nothing.
    const same = seen(on, false);
    expect(same).toBe(on);
  });

  it('never sends while one is on its way, and clears the wish when one goes', () => {
    const going = sent(wanted(watch({ onScreen: true, enabled: true, lastSentAt: T - 60_000 })), T);
    expect(going.wantSoon).toBe(false);
    expect(nextFetchIn(going, T + 60_000)).toBeNull();
  });

  it('after a failed first request, tries again a minute later', () => {
    const lost = failed(sent(watch(), T));
    expect(lost.enabled).toBeNull();
    expect(nextFetchIn(lost, T + 1_000)).toBe(RECHECK_MS - 1_000);
    // A failure later on keeps the lists and the ordinary rule.
    const later = failed(sent(answered(sent(watch({ onScreen: true }), T), true), T + 10_000));
    expect(later.enabled).toBe(true);
    expect(nextFetchIn(later, T + 10_000)).toBe(POLL_MS);
  });

  it('counts a request sent at 0 on the page’s clock (performance.now() starts near 0)', () => {
    const first = answered(sent(watch({ onScreen: true }), 0), true);
    expect(first.lastSentAt).toBe(0);
    expect(nextFetchIn(first, 1_000)).toBe(POLL_MS - 1_000);
    expect(nextFetchIn(wanted(first), 1_000)).toBe(MIN_GAP_MS - 1_000);
  });

  it('over a minute on screen with a round ending every few seconds, never two within five seconds', () => {
    let w = watch({ onScreen: true });
    const sentAt: number[] = [];
    for (let now = T; now <= T + 60_000; now += 100) {
      // A round of the player's ends every 3 seconds.
      if ((now - T) % 3_000 === 0 && now > T) w = wanted(w);
      const delay = nextFetchIn(w, now);
      if (delay === 0) {
        w = sent(w, now);
        sentAt.push(now - T);
        // The answer comes 100 ms later (the next step).
      } else if (w.inFlight) {
        w = answered(w, true);
      }
    }
    const gaps = sentAt.slice(1).map((at, i) => at - (sentAt[i] ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(MIN_GAP_MS);
    expect(sentAt.length).toBe(13);
  });
});

// --------------------------------------------------------- Sheet, then wins

describe('Upright phones: the wins join the page only with the sheet up', () => {
  // 390x844: the sheet's bottom is 979 from the page's top, so sheet up is 135.
  const screenHeight = 844;
  const at = (scrollTop: number): boolean =>
    winsMayJoin({ scrollTop, sheetBottom: 979 - scrollTop, screenHeight });

  it('waits while the page rests at the top (sheet down)', () => {
    expect(at(0)).toBe(false);
    expect(at(SHEET_SLACK_PX)).toBe(false);
  });

  it('joins once it rests with the sheet up, and stays at the table', () => {
    expect(at(135)).toBe(true);
    expect(at(543)).toBe(true);
    // A phone's browser bars can leave sheet up a little off; it still counts.
    expect(winsMayJoin({ scrollTop: 120, sheetBottom: 900, screenHeight })).toBe(true);
  });

  it('joins at the top too when the whole sheet already fits (a tall tablet)', () => {
    expect(winsMayJoin({ scrollTop: 0, sheetBottom: 1366, screenHeight: 1366 })).toBe(true);
    expect(winsMayJoin({ scrollTop: 0, sheetBottom: 1366 + SHEET_SLACK_PX + 1, screenHeight: 1366 })).toBe(false);
  });
});

// ------------------------------------------------------------- Settings row

function state(overrides: Partial<PrivateWinsState> = {}): PrivateWinsState {
  return { ...START_PRIVATE_WINS, ...overrides };
}

function row(s: PrivateWinsState): string {
  return renderToStaticMarkup(<PrivateWinsView state={s} onToggle={() => undefined} />);
}

/** Runs events through the row's rule. */
function run(events: readonly PrivateWinsEvent[], from: PrivateWinsState = START_PRIVATE_WINS): PrivateWinsState {
  return events.reduce(privateWinsStep, from);
}

describe('"Keep my wins private" settings row', () => {
  it('is a labelled switch that shows the server’s value', () => {
    const off = row(state({ winsPrivate: false }));
    expect(off).toMatch(/<span id="([^"]+)">Keep my wins private<\/span><button[^>]*role="switch"[^>]*aria-labelledby="\1"/);
    expect(off).toContain('aria-checked="false"');
    expect(off).toMatch(/>Off<\/button>/);
    const on = row(state({ winsPrivate: true }));
    expect(on).toContain('aria-checked="true"');
    expect(on).toMatch(/>On<\/button>/);
    expect(on).not.toContain('disabled');
    expect(on).toContain('aria-busy="false"');
  });

  it('is no switch at all before the value is known, so it never says off for an unknown value', () => {
    for (const s of [state({ reading: 1 }), state({ failure: LOAD_FAILED })]) {
      const html = row(s);
      expect(html).not.toContain('role="switch"');
      expect(html).not.toContain('aria-checked');
      expect(html).toContain('disabled=""');
      expect(html).toMatch(/<span id="([^"]+)">Keep my wins private<\/span><button[^>]*aria-labelledby="\1"/);
    }
  });

  it('says it is busy only while a request is on its way', () => {
    const loading = row(state({ reading: 1 }));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toMatch(/>…<\/button>/);
    const saving = row(state({ winsPrivate: true, saving: true }));
    expect(saving).toContain('aria-busy="true"');
    expect(saving).toContain('disabled=""');
    // The read failed: nothing is loading any more.
    const lost = row(state({ failure: LOAD_FAILED }));
    expect(lost).toContain('aria-busy="false"');
    expect(lost).not.toMatch(/>…<\/button>/);
  });

  it('shows a failure plainly', () => {
    expect(row(state({ winsPrivate: false, failure: SAVE_FAILED }))).toContain(
      `role="alert">${SAVE_FAILED}</p>`,
    );
    expect(row(state({ failure: LOAD_FAILED }))).toContain(LOAD_FAILED);
    expect(row(state({ winsPrivate: false }))).not.toContain('role="alert"');
  });
});

describe('"Keep my wins private": the row’s rule', () => {
  const read = (winsPrivate: boolean, savesWhenSent = 0): PrivateWinsEvent => ({
    type: 'read-answered',
    winsPrivate,
    savesWhenSent,
  });

  it('shows the value read, and nothing before it', () => {
    const sentOnly = run([{ type: 'read-sent' }]);
    expect(sentOnly.winsPrivate).toBeNull();
    expect(canToggle(sentOnly)).toBe(false);
    const known = run([{ type: 'read-sent' }, read(true)]);
    expect(known).toMatchObject({ winsPrivate: true, reading: 0, failure: null });
    expect(canToggle(known)).toBe(true);
  });

  it('a failed first read says so and stops loading; a failed later read keeps the value', () => {
    expect(run([{ type: 'read-sent' }, { type: 'read-failed' }])).toMatchObject({
      winsPrivate: null,
      reading: 0,
      failure: LOAD_FAILED,
    });
    const later = run([{ type: 'read-sent' }, read(false), { type: 'read-sent' }, { type: 'read-failed' }]);
    expect(later).toMatchObject({ winsPrivate: false, reading: 0, failure: null });
  });

  it('does not show a press until the server has answered it', () => {
    const known = run([{ type: 'read-sent' }, read(false)]);
    const pressed = privateWinsStep(known, { type: 'save-sent' });
    expect(pressed).toMatchObject({ winsPrivate: false, saving: true });
    expect(canToggle(pressed)).toBe(false);
    expect(privateWinsStep(pressed, { type: 'save-answered', winsPrivate: true })).toMatchObject({
      winsPrivate: true,
      saving: false,
      failure: null,
    });
  });

  it('a failed save keeps the value the server last sent', () => {
    const failedSave = run([{ type: 'read-sent' }, read(false), { type: 'save-sent' }, { type: 'save-failed' }]);
    expect(failedSave).toMatchObject({ winsPrivate: false, saving: false, failure: SAVE_FAILED });
    expect(canToggle(failedSave)).toBe(true);
  });

  it('drops a read sent before a save: it may carry the value from before', () => {
    const known = run([{ type: 'read-sent' }, read(false)]);
    // The menu reopens (a read goes, tagged 0 saves), then the player presses at once.
    const readGoes = privateWinsStep(known, { type: 'read-sent' });
    const saved = run([{ type: 'save-sent' }, { type: 'save-answered', winsPrivate: true }], readGoes);
    // The old read comes back last, with the value from before the save.
    const late = privateWinsStep(saved, read(false, readGoes.saves));
    expect(late).toMatchObject({ winsPrivate: true, reading: 0 });
    // A read sent after the save counts.
    expect(privateWinsStep(late, read(false, late.saves)).winsPrivate).toBe(false);
  });

  it('only ever shows a value the server sent, over any run of events', () => {
    // Every event in turn, from every reachable state a few steps deep.
    const events = (s: PrivateWinsState): PrivateWinsEvent[] => [
      { type: 'read-sent' },
      read(true, s.saves),
      read(false, s.saves),
      read(true, s.saves - 1),
      { type: 'read-failed' },
      { type: 'save-sent' },
      { type: 'save-answered', winsPrivate: true },
      { type: 'save-answered', winsPrivate: false },
      { type: 'save-failed' },
    ];
    let paths: { s: PrivateWinsState; lastSent: boolean | null }[] = [{ s: START_PRIVATE_WINS, lastSent: null }];
    for (let depth = 0; depth < 5; depth += 1) {
      paths = paths.flatMap(({ s, lastSent }) =>
        events(s).map((e) => {
          const next = privateWinsStep(s, e);
          const accepted =
            e.type === 'save-answered' || (e.type === 'read-answered' && e.savesWhenSent === s.saves);
          const sentValue = accepted && 'winsPrivate' in e ? e.winsPrivate : lastSent;
          expect(next.winsPrivate).toBe(sentValue);
          return { s: next, lastSent: sentValue };
        }),
      );
    }
    expect(paths.length).toBe(9 ** 5);
  });
});
