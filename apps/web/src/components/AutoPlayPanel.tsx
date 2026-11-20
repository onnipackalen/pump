import { useEffect, useRef, useState } from 'react';
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

/** Auto-play: a number of rounds, a target pump count, and stop limits. */
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
            aria-invalid={error !== null}
            placeholder={props.prefix === undefined ? undefined : 'off'}
            onChange={(event) => setForm({ ...form, [name]: event.target.value })}
          />
        </span>
        {error !== null && <span className="bet-note error">{error}</span>}
      </label>
    );
  };

  const net = (
    <strong className={progress.netCents > 0 ? 'win' : undefined}>
      {formatSignedCents(progress.netCents)}
    </strong>
  );

  return (
    <section className="card panel" aria-label="Auto-play" ref={panelRef}>
      <h2>Auto-play</h2>

      {running ? (
        <>
          <button
            ref={stopRef}
            type="button"
            className="btn btn-stop btn-wide"
            aria-disabled={stopping}
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
            disabled={check.settings === null || !betsValid || roundActive || starting}
            onClick={() => {
              if (check.settings) onStart(check.settings);
            }}
          >
            Start auto-play
          </button>
          {roundActive && <p className="hint">Finish the round in play first.</p>}
        </>
      )}

      {/* One status line that stays on the page in both views, so screen
          readers announce changes to it, including why a run stopped. */}
      <p className="auto-progress" role="status" tabIndex={-1} ref={statusRef}>
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
    </section>
  );
}
