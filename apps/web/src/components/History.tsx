import type { GameConfig } from '@pump/engine';
import type { RoundSummary } from '../api/contract';
import { formatCents, formatSignedCents } from '../money';

interface HistoryProps {
  readonly config: GameConfig;
  readonly rounds: readonly RoundSummary[];
  /** Opens a round on the verify page. */
  readonly onVerify: (roundId: string) => void;
}

const timeOfDay = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});

/** The last rounds, newest first. */
export function History({ config, rounds, onVerify }: HistoryProps) {
  const label = (id: string): string =>
    config.difficulties.find((d) => d.id === id)?.label ?? id;

  return (
    <section className="card panel history" aria-label="Last rounds">
      <h2>Last 10 rounds</h2>
      {rounds.length === 0 ? (
        <p className="hint">No rounds yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Difficulty</th>
                <th scope="col" className="num">
                  Balloons
                </th>
                <th scope="col" className="num">
                  Spent
                </th>
                <th scope="col" className="num">
                  Paid
                </th>
                <th scope="col" className="num">
                  Net
                </th>
                <th scope="col">
                  <span className="visually-hidden">Verify</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rounds.map((round) => {
                const spent = round.betCents + round.patchesCents;
                const net = round.payoutCents - spent;
                return (
                  <tr key={round.id}>
                    <td>{timeOfDay.format(new Date(round.finishedAt))}</td>
                    <td>{label(round.difficultyId)}</td>
                    <td className="num">{round.balloonCount}</td>
                    <td className="num">{formatCents(spent)}</td>
                    <td className="num">{formatCents(round.payoutCents)}</td>
                    <td className={net > 0 ? 'num win' : 'num muted'}>{formatSignedCents(net)}</td>
                    <td>
                      {round.seedRevealed ? (
                        <button type="button" className="btn btn-small" onClick={() => onVerify(round.id)}>
                          Verify
                        </button>
                      ) : (
                        <span className="muted" title="Rotate your server seed to reveal it, then verify">
                          After rotate
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
