import { useState } from 'react';
import {
  checkAutoPlayForm,
  describeStop,
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

interface FieldSpec {
  readonly name: keyof AutoPlayForm;
  /** Short, shown inside the box. */
  readonly label: string;
  /** Full, for the tooltip, the error line and screen readers. */
  readonly full: string;
  readonly money: boolean;
}

const FIELDS: readonly FieldSpec[] = [
  { name: 'rounds', label: 'Rounds', full: 'Rounds', money: false },
  { name: 'targetPumps', label: 'Pumps', full: 'Pumps per balloon', money: false },
  { name: 'stopOnProfit', label: 'Stop profit', full: 'Stop at profit', money: true },
  { name: 'stopOnLoss', label: 'Stop loss', full: 'Stop at loss', money: true },
];

/**
 * Auto-play: a number of rounds, a target pump count, and stop limits.
 * It uses the bets in the bet panel above it. While it runs, this shows
 * only the progress and the Stop button. The rules are spelled out in
 * settings, under Game info.
 */
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
  const firstWrong = FIELDS.find((field) => check.errors[field.name] !== null);

  if (running && settings) {
    return (
      <section className="auto" aria-label="Auto-play">
        <p className="auto-progress" aria-live="polite">
          Round {Math.min(progress.roundsPlayed + 1, settings.rounds)} of {settings.rounds} · net{' '}
          <strong className={progress.netCents > 0 ? 'win' : undefined}>
            {formatSignedCents(progress.netCents)}
          </strong>
        </p>
        <button
          type="button"
          className="btn btn-stop"
          disabled={stopping}
          onClick={onStop}
          title="Stop auto-play (Esc)"
        >
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      </section>
    );
  }

  return (
    <section className="auto" aria-label="Auto-play">
      <div className="auto-grid">
        {FIELDS.map((field) => (
          <label key={field.name} className="field" title={field.full}>
            <span className="field-label">{field.label}</span>
            <input
              type="text"
              inputMode={field.money ? 'decimal' : 'numeric'}
              autoComplete="off"
              aria-label={field.full}
              value={form[field.name]}
              aria-invalid={check.errors[field.name] !== null}
              placeholder={field.money ? 'off' : undefined}
              onChange={(event) => setForm({ ...form, [field.name]: event.target.value })}
            />
          </label>
        ))}
      </div>
      {firstWrong && (
        <p className="note error">
          {firstWrong.full}: {check.errors[firstWrong.name]}
        </p>
      )}
      <button
        type="button"
        className="btn btn-primary"
        disabled={check.settings === null || !betsValid || roundActive}
        onClick={() => {
          if (check.settings) onStart(check.settings);
        }}
      >
        Start auto-play
      </button>
      {stopReason !== null && (
        <p className="note auto-summary" role="status">
          {describeStop(stopReason, progress)} Net{' '}
          <strong className={progress.netCents > 0 ? 'win' : undefined}>
            {formatSignedCents(progress.netCents)}
          </strong>
          .
        </p>
      )}
    </section>
  );
}
