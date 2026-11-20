import { useState } from 'react';
import {
  checkAutoPlayForm,
  describeStop,
  MAX_AUTO_ROUNDS,
  type AutoPlayForm,
  type AutoPlaySettings,
} from '../game/autoPlay';
import type { AutoPlayStatus } from '../game/useAutoPlay';
import { formatSignedCents } from '../money';

interface AutoPlayPanelProps {
  /** Length of the chosen difficulty's ladder: the most pumps a balloon can take. */
  readonly maxPumps: number;
  /** Total of the bets in the bet panel, and whether they are all valid. */
  readonly roundBetCents: number;
  readonly betsValid: boolean;
  /** A round is in play that the player started by hand. */
  readonly roundActive: boolean;
  readonly status: AutoPlayStatus;
  readonly onStart: (settings: AutoPlaySettings) => void;
  readonly onStop: () => void;
}

const initialForm: AutoPlayForm = {
  rounds: '10',
  targetPumps: '3',
  stopOnProfit: '',
  stopOnLoss: '',
};

/** Auto-play: a number of rounds, a target pump count, and stop limits. */
export function AutoPlayPanel({
  maxPumps,
  roundBetCents,
  betsValid,
  roundActive,
  status,
  onStart,
  onStop,
}: AutoPlayPanelProps) {
  const [form, setForm] = useState<AutoPlayForm>(initialForm);
  const check = checkAutoPlayForm(form, maxPumps, roundBetCents);
  const { running, stopping, progress, settings, stopReason } = status;

  const field = (name: keyof AutoPlayForm, label: string, props: { prefix?: string }) => {
    const error = check.errors[name];
    return (
      <label className="auto-field">
        <span className="bet-label">{label}</span>
        <span className="bet-input">
          {props.prefix !== undefined && <span aria-hidden="true">{props.prefix}</span>}
          <input
            type="text"
            inputMode={props.prefix === undefined ? 'numeric' : 'decimal'}
            autoComplete="off"
            value={form[name]}
            disabled={running}
            aria-invalid={error !== null}
            placeholder={props.prefix === undefined ? undefined : 'off'}
            onChange={(event) => setForm({ ...form, [name]: event.target.value })}
          />
        </span>
        {error !== null && <span className="bet-note error">{error}</span>}
      </label>
    );
  };

  return (
    <section className="card panel" aria-label="Auto-play">
      <h2>Auto-play</h2>

      {running && settings ? (
        <>
          <p className="auto-progress" aria-live="polite">
            Round {Math.min(progress.roundsPlayed + 1, settings.rounds)} of {settings.rounds} ·
            net{' '}
            <strong className={progress.netCents > 0 ? 'win' : undefined}>
              {formatSignedCents(progress.netCents)}
            </strong>
          </p>
          <button
            type="button"
            className="btn btn-stop btn-wide"
            disabled={stopping}
            onClick={onStop}
          >
            {stopping ? 'Stopping…' : 'Stop auto-play'}
          </button>
          <p className="hint">
            <kbd>Esc</kbd> also stops it. Stopping mid-round leaves the balloons for you to finish.
          </p>
        </>
      ) : (
        <>
          <div className="auto-grid">
            {field('rounds', 'Rounds', {})}
            {field('targetPumps', 'Pumps per balloon', {})}
            {field('stopOnProfit', 'Stop at profit', { prefix: '$' })}
            {field('stopOnLoss', 'Stop at loss', { prefix: '$' })}
          </div>
          <p className="hint">
            Uses the bets above. Pumps each balloon that many times, then cashes it out; a balloon
            whose top is lower cashes out at its top. Buys no Patches. Never starts a round that
            could take you past the loss limit. Up to {MAX_AUTO_ROUNDS} rounds.
          </p>
          <button
            type="button"
            className="btn btn-wide"
            disabled={check.settings === null || !betsValid || roundActive}
            onClick={() => {
              if (check.settings) onStart(check.settings);
            }}
          >
            Start auto-play
          </button>
          {roundActive && <p className="hint">Finish the round in play first.</p>}
          {stopReason !== null && (
            <p className="auto-progress" role="status">
              {describeStop(stopReason, progress)} Net{' '}
              <strong className={progress.netCents > 0 ? 'win' : undefined}>
                {formatSignedCents(progress.netCents)}
              </strong>
              .
            </p>
          )}
        </>
      )}
    </section>
  );
}
