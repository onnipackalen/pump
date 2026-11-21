import { GAME_CONFIG, type GameConfig } from '@pump/engine';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PublicWin, PublicWinsResponse, SessionView } from '../src/api/contract';
import { HttpClient } from '../src/api/httpClient';
import {
  LOAD_FAILED,
  PrivateWinsView,
  SAVE_FAILED,
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

/** Plays one-balloon rounds in the demo (one pump, then cash out) until `count` are won. */
async function playWins(client: DemoClient, betsCents: readonly number[]): Promise<void> {
  for (const betCents of betsCents) {
    for (let tries = 0; tries < 50; tries += 1) {
      const { round } = await client.startRound(
        { difficultyId: GAME_CONFIG.difficulties[0]?.id ?? 'easy', betsCents: [betCents] },
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
    const client = new DemoClient(GAME_CONFIG, 0);
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
      const ladder = GAME_CONFIG.difficulties[0]?.ladder ?? [];
      expect(w.multiplierHundredths).toBe(ladder[0]);
    }
    expect(wins.luckiest).toHaveLength(3);
  });

  it('keeps the wins out of the lists while private, past ones too, and back when not', async () => {
    const client = new DemoClient(GAME_CONFIG, 0);
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
    for (const name of ['Player', 'Difficulty', 'Bet', 'Multiplier', 'Payout', 'Gain']) {
      expect(html).toMatch(new RegExp(`<th scope="col"[^>]*>${name}</th>`));
    }
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

  it('shows nothing at all before the server has answered (and so while it says off)', () => {
    const html = renderToStaticMarkup(
      <PublicWins client={new DemoClient(GAME_CONFIG, 0)} config={GAME_CONFIG} latestRoundId={null} shown />,
    );
    expect(html).toBe('');
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

// ------------------------------------------------------------- Settings row

function row(state: PrivateWinsState): string {
  return renderToStaticMarkup(<PrivateWinsView state={state} onToggle={() => undefined} />);
}

describe('"Keep my wins private" settings row', () => {
  it('is a labelled switch that shows the server’s value', () => {
    const off = row({ winsPrivate: false, saving: false, failure: null });
    expect(off).toMatch(/<span id="([^"]+)">Keep my wins private<\/span><button[^>]*role="switch"[^>]*aria-labelledby="\1"/);
    expect(off).toContain('aria-checked="false"');
    expect(off).toMatch(/>Off<\/button>/);
    const on = row({ winsPrivate: true, saving: false, failure: null });
    expect(on).toContain('aria-checked="true"');
    expect(on).toMatch(/>On<\/button>/);
    expect(on).not.toContain('disabled');
  });

  it('cannot be pressed before the value is known or while saving', () => {
    for (const state of [
      { winsPrivate: null, saving: false, failure: null },
      { winsPrivate: true, saving: true, failure: null },
    ]) {
      const html = row(state);
      expect(html).toContain('disabled=""');
      expect(html).toContain('aria-busy="true"');
    }
    expect(row({ winsPrivate: null, saving: false, failure: null })).toMatch(/>…<\/button>/);
  });

  it('shows a failure plainly', () => {
    expect(row({ winsPrivate: false, saving: false, failure: SAVE_FAILED })).toContain(
      `role="alert">${SAVE_FAILED}</p>`,
    );
    expect(row({ winsPrivate: null, saving: false, failure: LOAD_FAILED })).toContain(LOAD_FAILED);
    expect(row({ winsPrivate: false, saving: false, failure: null })).not.toContain('role="alert"');
  });
});
