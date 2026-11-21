import type { GameConfig } from '@pump/engine';
import { useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import type { GameClient } from '../api/client';
import type { PublicWin, PublicWinsResponse } from '../api/contract';
import { formatCents, formatMultiplier, formatSignedCents } from '../money';
import { useWinsWaitForSheet } from './sheetFirst';
import { usePublicWins } from './usePublicWins';
import './public-wins.css';

/** The three lists the server sends, by their names in the answer. */
export type WinsList = 'recent' | 'biggest' | 'luckiest';

/** The tabs, in order: newest first, largest gain first, highest multiplier first. */
export const WINS_TABS: readonly { readonly list: WinsList; readonly label: string }[] = [
  { list: 'recent', label: 'Recent' },
  { list: 'biggest', label: 'Biggest' },
  { list: 'luckiest', label: 'Lucky' },
];

const timeOfDay = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface PublicWinsProps {
  readonly client: GameClient;
  readonly config: GameConfig;
  /** The newest round in the player's history: a change means a round of theirs ended. */
  readonly latestRoundId: string | null;
  /** False while another page (verify, stats) is showing: kept, but not on screen. */
  readonly shown: boolean;
}

/**
 * Everyone's wins, at the very end of the page: the latest, the largest
 * gains and the highest multipliers. Nothing at all while the server has
 * them switched off, or before it has said. When they are asked for is in
 * polling.ts; where they sit at each size is in public-wins.css.
 */
export function PublicWins({ client, config, latestRoundId, shown }: PublicWinsProps) {
  const { wins, sectionRef } = usePublicWins(client, latestRoundId);
  const [list, setList] = useState<WinsList>('recent');
  const waiting = useWinsWaitForSheet();
  if (wins === null) return null;
  return (
    <PublicWinsPanel
      wins={wins}
      config={config}
      list={list}
      onList={setList}
      hidden={!shown}
      waiting={waiting}
      sectionRef={sectionRef}
    />
  );
}

interface PanelProps {
  readonly wins: PublicWinsResponse;
  readonly config: GameConfig;
  readonly list: WinsList;
  readonly onList: (list: WinsList) => void;
  readonly hidden?: boolean;
  /** Upright phones: the sheet is down, so the wins wait off the page (sheetFirst.ts). */
  readonly waiting?: boolean;
  readonly sectionRef?: Ref<HTMLElement>;
}

/**
 * The panel itself: a heading, three tabs and one table. Nothing at all
 * while the server says the lists are off, whatever else the answer holds.
 *
 * Tabs as the ARIA pattern has them: one tab stop, the arrow keys (and Home,
 * End) move between the tabs. No live region: the lists change every few
 * seconds, and reading each change out would never stop.
 */
export function PublicWinsPanel({
  wins,
  config,
  list,
  onList,
  hidden,
  waiting,
  sectionRef,
}: PanelProps) {
  const id = useId();
  const headingId = `${id}-heading`;
  const panelId = `${id}-panel`;
  const tabId = (which: WinsList): string => `${id}-tab-${which}`;
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const rows = wins[list];
  const label = (difficultyId: string): string =>
    config.difficulties.find((d) => d.id === difficultyId)?.label ?? difficultyId;
  const listName = WINS_TABS.find((tab) => tab.list === list)?.label ?? '';

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const at = WINS_TABS.findIndex((tab) => tab.list === list);
    const last = WINS_TABS.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: at === last ? 0 : at + 1,
      ArrowLeft: at === 0 ? last : at - 1,
      Home: 0,
      End: last,
    };
    const to = moves[event.key];
    const next = to === undefined ? undefined : WINS_TABS[to];
    if (to === undefined || next === undefined) return;
    event.preventDefault();
    onList(next.list);
    tabs.current[to]?.focus();
  };

  if (!wins.enabled) return null;
  return (
    <section
      ref={sectionRef}
      className="public-wins"
      aria-labelledby={headingId}
      hidden={hidden}
      data-waiting={waiting ? '' : undefined}
    >
      <div className="pw-head">
        <h2 id={headingId} className="pw-title">
          Wins
        </h2>
        <div
          className="segmented pw-tabs"
          role="tablist"
          aria-labelledby={headingId}
          onKeyDown={onTabKey}
        >
          {WINS_TABS.map((tab, index) => (
            <button
              key={tab.list}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              id={tabId(tab.list)}
              type="button"
              role="tab"
              className="segment"
              aria-selected={tab.list === list}
              aria-controls={panelId}
              tabIndex={tab.list === list ? 0 : -1}
              onClick={() => onList(tab.list)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div id={panelId} role="tabpanel" aria-labelledby={tabId(list)} tabIndex={0}>
        {rows.length === 0 ? (
          <p className="hint">No wins yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="pw-table">
              <caption className="visually-hidden">{`${listName} wins`}</caption>
              <thead>
                <tr>
                  <th scope="col">Player</th>
                  <th scope="col">Difficulty</th>
                  <th scope="col" className="num" title="Bets plus Patches">
                    Bet
                  </th>
                  <th scope="col" className="num">
                    Multiplier
                  </th>
                  <th scope="col" className="num pw-payout">
                    Payout
                  </th>
                  <th scope="col" className="num">
                    Gain
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((win, index) => (
                  <WinRow
                    key={`${win.finishedAt}-${win.playerTag}-${String(index)}`}
                    win={win}
                    difficulty={label(win.difficultyId)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function WinRow({ win, difficulty }: { readonly win: PublicWin; readonly difficulty: string }) {
  return (
    <tr title={timeOfDay.format(new Date(win.finishedAt))}>
      <td className="pw-tag">{win.playerTag}</td>
      <td className="pw-difficulty" title={difficulty}>
        {difficulty}
      </td>
      <td className="num">{formatCents(win.wageredCents)}</td>
      <td className="num">{formatMultiplier(win.multiplierHundredths)}</td>
      <td className="num pw-payout">{formatCents(win.payoutCents)}</td>
      {/* Mint only for a real gain. The server sends only wins, so it always is. */}
      <td className={win.netCents > 0 ? 'num win' : 'num'}>{formatSignedCents(win.netCents)}</td>
    </tr>
  );
}
