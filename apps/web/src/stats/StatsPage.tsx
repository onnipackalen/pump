import type { GameConfig } from '@pump/engine';
import { useEffect, useState } from 'react';
import { ApiFailure, type GameClient } from '../api/client';
import type { BestWin, DifficultyStats, PlayerStats } from '../api/contract';
import { formatCents, formatMultiplier, formatSignedCents } from '../money';
import { ProfitChart } from './ProfitChart';
import './stats.css';

interface StatsPageProps {
  readonly client: GameClient;
  readonly config: GameConfig;
  /**
   * The newest finished round. When it changes (auto-play can keep playing
   * while this page is open) the stats are loaded again.
   */
  readonly latestRoundId: string | null;
  /** Opens a round on the verify page. */
  readonly onVerify: (roundId: string) => void;
  readonly onBack: () => void;
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly stats: PlayerStats };

/**
 * The player's stats: profit over time, best win, and rounds by difficulty.
 * Every figure comes from the server, which adds up the rounds it settled.
 */
export function StatsPage({ client, config, latestRoundId, onVerify, onBack }: StatsPageProps) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    client.getStats().then(
      (stats) => {
        if (current) setLoaded({ kind: 'ready', stats });
      },
      (error: unknown) => {
        if (!current) return;
        const message = error instanceof ApiFailure ? error.message : 'Could not load the stats.';
        setLoaded({ kind: 'failed', message });
      },
    );
    return () => {
      current = false;
    };
  }, [client, latestRoundId, attempt]);

  const label = (id: string): string =>
    config.difficulties.find((difficulty) => difficulty.id === id)?.label ?? id;

  return (
    <main className="stats" aria-labelledby="stats-title">
      <div className="stats-inner">
        <div className="stats-head">
          <h1 id="stats-title">Stats</h1>
          <button type="button" className="btn btn-small" onClick={onBack}>
            Back
          </button>
        </div>
        {loaded.kind === 'loading' && <p className="hint">Loading…</p>}
        {loaded.kind === 'failed' && (
          <div className="notice notice-error" role="status">
            <span>{loaded.message}</span>
            <button type="button" className="btn btn-small" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </div>
        )}
        {loaded.kind === 'ready' && (
          <StatsBody stats={loaded.stats} config={config} label={label} onVerify={onVerify} />
        )}
      </div>
    </main>
  );
}

interface StatsBodyProps {
  readonly stats: PlayerStats;
  readonly config: GameConfig;
  readonly label: (difficultyId: string) => string;
  readonly onVerify: (roundId: string) => void;
}

function StatsBody({ stats, config, label, onVerify }: StatsBodyProps) {
  if (stats.rounds === 0) {
    return (
      <section className="card panel">
        <p className="hint">No rounds yet.</p>
      </section>
    );
  }
  return (
    <>
      <dl className="stats-tiles">
        <div className="card">
          <dt>Net</dt>
          <dd className={stats.netCents > 0 ? 'win' : undefined}>
            {formatSignedCents(stats.netCents)}
          </dd>
        </div>
        <div className="card">
          <dt>Rounds</dt>
          <dd>{stats.rounds.toLocaleString('en-US')}</dd>
        </div>
        <div className="card">
          <dt>Wagered</dt>
          <dd>{formatCents(stats.wageredCents)}</dd>
        </div>
        <div className="card">
          <dt>Paid out</dt>
          <dd>{formatCents(stats.paidOutCents)}</dd>
        </div>
      </dl>

      <section className="card panel" aria-labelledby="stats-profit">
        <h2 id="stats-profit">Profit</h2>
        <ProfitChart profit={stats.profit} />
      </section>

      <section className="card panel" aria-labelledby="stats-best">
        <h2 id="stats-best">Best win</h2>
        {stats.bestWin === null ? (
          <p className="hint">None yet.</p>
        ) : (
          <BestWinLine win={stats.bestWin} label={label} onVerify={onVerify} />
        )}
      </section>

      <section className="card panel" aria-labelledby="stats-difficulty">
        <h2 id="stats-difficulty">By difficulty</h2>
        <DifficultyTable entries={withEveryDifficulty(stats.byDifficulty, config)} label={label} />
      </section>
    </>
  );
}

function BestWinLine({
  win,
  label,
  onVerify,
}: {
  readonly win: BestWin;
  readonly label: (difficultyId: string) => string;
  readonly onVerify: (roundId: string) => void;
}) {
  return (
    <div className="stats-best">
      <span className="stats-best-gain win">{formatSignedCents(win.netCents)}</span>
      <span className="stats-best-facts">
        <span>{label(win.difficultyId)}</span>
        <span>{formatMultiplier(win.multiplierHundredths)}</span>
        <span className="muted">
          {formatCents(win.wageredCents)} → {formatCents(win.payoutCents)}
        </span>
      </span>
      {win.seedRevealed ? (
        <button type="button" className="btn btn-small" onClick={() => onVerify(win.roundId)}>
          Verify
        </button>
      ) : (
        <span className="muted" title="Rotate your server seed to reveal it, then verify">
          After rotate
        </span>
      )}
    </div>
  );
}

/**
 * Every difficulty in the game, in the game's order, with 0 rounds for the
 * ones not played yet; then any the player played that the game no longer
 * has (the server already puts those last).
 */
function withEveryDifficulty(
  played: readonly DifficultyStats[],
  config: GameConfig,
): DifficultyStats[] {
  const inGame = config.difficulties.map(
    (difficulty) =>
      played.find((entry) => entry.difficultyId === difficulty.id) ?? {
        difficultyId: difficulty.id,
        rounds: 0,
        wageredCents: 0,
        paidOutCents: 0,
        netCents: 0,
      },
  );
  const gone = played.filter(
    (entry) => !config.difficulties.some((difficulty) => difficulty.id === entry.difficultyId),
  );
  return [...inGame, ...gone];
}

function DifficultyTable({
  entries,
  label,
}: {
  readonly entries: readonly DifficultyStats[];
  readonly label: (difficultyId: string) => string;
}) {
  const most = Math.max(1, ...entries.map((entry) => entry.rounds));
  return (
    <div className="table-scroll">
      <table className="stats-table">
        <thead>
          <tr>
            <th scope="col">Difficulty</th>
            <th scope="col">Rounds</th>
            <th scope="col" className="num">
              Wagered
            </th>
            <th scope="col" className="num">
              Net
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.difficultyId}>
              <td>{label(entry.difficultyId)}</td>
              <td>
                <span className="stats-rounds">
                  <span className="stats-track">
                    {entry.rounds > 0 && (
                      <span
                        className="stats-bar"
                        style={{ width: `max(2px, ${String((entry.rounds / most) * 100)}%)` }}
                      />
                    )}
                  </span>
                  <span className="stats-count">{entry.rounds.toLocaleString('en-US')}</span>
                </span>
              </td>
              <td className="num">{formatCents(entry.wageredCents)}</td>
              <td className={entry.netCents > 0 ? 'num win' : 'num muted'}>
                {entry.rounds === 0 ? '–' : formatSignedCents(entry.netCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
