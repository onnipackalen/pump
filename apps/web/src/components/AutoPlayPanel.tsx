import { useEffect, useRef, useState } from 'react';
import {
  checkAutoPlayForm,
  describeStop,
  type AutoPlayForm,
  type AutoPlaySettings,
} from '../game/autoPlay';
import type { AutoPlayStatus } from '../game/useAutoPlay';
import { formatSignedCents } from '../money';
import { GuardedButton } from './GuardedButton';

interface AutoPlayPanelProps {
  /** Length of the chosen difficulty's ladder: the most pumps a balloon can take. */
  readonly maxPumps: number;
  /** Total of the bets in the bet panel, and whether they are all valid. */
  readonly roundBetCents: number;
  readonly betsValid: boolean;
  /** A round is in play that the player started by hand. */
  readonly roundActive: boolean;
  /** A round the player started by hand is on its way to the server. */
  readonly starting: boolean;
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
  starting,
  status,
  onStart,
  onStop,
}: AutoPlayPanelProps) {
  const [form, setForm] = useState<AutoPlayForm>(initialForm);
  const check = checkAutoPlayForm(form, maxPumps, roundBetCents);
  const { running, stopping, progress, settings, stopReason } = status;
  const firstWrong = FIELDS.find((field) => check.errors[field.name] !== null);

  const panelRef = useRef<HTMLElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const wasRunning = useRef(running);

  // The Start and Stop buttons swap places, so focus would fall to the page.
  // Keep it in the panel: on Stop while running, on the result line after.
  // Only if focus was in the panel (or nowhere): never steal it from elsewhere.
  useEffect(() => {
    if (wasRunning.current === running) return;
    wasRunning.current = running;
    const active = document.activeElement;
    const focusWasHere =
      active === null || active === document.body || (panelRef.current?.contains(active) ?? false);
    if (!focusWasHere) return;
    if (running) stopRef.current?.focus();
    else statusRef.current?.focus();
  }, [running]);

  const net = (
    <strong className={progress.netCents > 0 ? 'win' : undefined}>
      {formatSignedCents(progress.netCents)}
    </strong>
  );
  const showsResult = !running && stopReason !== null;

  return (
    <section className="auto" aria-label="Auto-play" ref={panelRef}>
      {/* Each its own button (the keys), so each has its own guard,
          started when it appears. */}
      {running ? (
        <GuardedButton
          key="stop"
          ref={stopRef}
          type="button"
          className="btn btn-stop"
          aria-disabled={stopping}
          onClick={onStop}
          title="Stop auto-play (Esc)"
        >
          {stopping ? 'Stopping…' : 'Stop'}
        </GuardedButton>
      ) : (
        <GuardedButton
          key="start"
          type="button"
          className="btn btn-primary"
          disabled={check.settings === null || !betsValid || roundActive || starting}
          onClick={() => {
            if (check.settings) onStart(check.settings);
          }}
        >
          Start auto-play
        </GuardedButton>
      )}

      {/* One status line that stays on the page in both views, so screen
          readers announce changes to it, including why a run stopped.
          While running it sits under Stop (see .auto-progress in styles). */}
      <p
        className={showsResult ? 'auto-progress note auto-summary' : 'auto-progress'}
        data-running={running}
        role="status"
        tabIndex={-1}
        ref={statusRef}
      >
        {running && settings ? (
          <>
            Round {Math.min(progress.roundsPlayed + 1, settings.rounds)} of {settings.rounds} · net{' '}
            {net}
          </>
        ) : stopReason !== null ? (
          <>
            {describeStop(stopReason, progress)} Net {net}.
          </>
        ) : null}
      </p>

      {/* The fields come after the button and the result line: the same
          top-to-bottom order as the bet panel, most used first. */}
      {!running && (
        <>
          {firstWrong && (
            <p className="note error">
              {firstWrong.full}: {check.errors[firstWrong.name]}
            </p>
          )}
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
        </>
      )}
    </section>
  );
}
