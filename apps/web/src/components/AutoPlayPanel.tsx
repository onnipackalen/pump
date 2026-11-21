import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { BalloonView, RoundView } from '../api/contract';
import {
  checkAutoPlayForm,
  describeHeld,
  describeStop,
  handCashOutsFor,
  pumpReach,
  totalBetCents,
  type AutoPlayField,
  type AutoPlayForm,
  type AutoPlaySettings,
  type BetChangeKind,
  type BetLimits,
} from '../game/autoPlay';
import type { AutoPlayStatus } from '../game/useAutoPlay';
import { formatCents, formatSignedCents } from '../money';
import { GuardedButton } from './GuardedButton';

interface AutoPlayPanelProps {
  /** The chosen difficulty's ladder: its length is the most pumps a balloon can take. */
  readonly ladder: readonly number[];
  /**
   * The highest rung the entered bets can reach, as the bet panel's info
   * line shows it (shownTopRung). The max payout can hold it below the
   * ladder's top; a balloon there cashes out by itself.
   */
  readonly topRung: number;
  /** The chosen difficulty's name, for screen readers ("on Easy"). */
  readonly difficultyLabel: string;
  /** Total of the bets in the bet panel, and whether they are all valid. */
  readonly roundBetCents: number;
  readonly betsValid: boolean;
  /** The bet limits, for saying where a changed bet was held. */
  readonly limits: BetLimits;
  /**
   * Whether this market lets auto-play change the bets (market.ts). Off: no
   * On win or On loss settings, and every round uses the bets entered.
   */
  readonly betSizing: boolean;
  /** A round is in play that the player started by hand. */
  readonly roundActive: boolean;
  /** A round the player started by hand is on its way to the server. */
  readonly starting: boolean;
  readonly status: AutoPlayStatus;
  /**
   * The round on screen while auto-play runs, for the Cash out buttons. They
   * stay between rounds (greyed), so the panel doesn't jump every round.
   */
  readonly round: RoundView | null;
  readonly onStart: (settings: AutoPlaySettings) => void;
  readonly onStop: () => void;
  /** The player's own Cash out for these balloons, while auto-play runs. */
  readonly onCashOut: (balloonIndexes: readonly number[]) => void;
}

const initialForm: AutoPlayForm = {
  rounds: '10',
  targetPumps: '3',
  stopOnProfit: '',
  stopOnLoss: '',
  // The bets stay as entered unless the player chooses otherwise. No
  // percent is filled in for them: the game never suggests one.
  onWin: 'reset',
  onWinPercent: '',
  onLoss: 'reset',
  onLossPercent: '',
};

interface FieldSpec {
  readonly name: 'rounds' | 'targetPumps' | 'stopOnProfit' | 'stopOnLoss';
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

interface SizingSpec {
  readonly kind: 'onWin' | 'onLoss';
  readonly percent: 'onWinPercent' | 'onLossPercent';
  readonly label: string;
}

const SIZING: readonly SizingSpec[] = [
  { kind: 'onWin', percent: 'onWinPercent', label: 'On win' },
  { kind: 'onLoss', percent: 'onLossPercent', label: 'On loss' },
];

/** Every field that can be wrong, in screen order, with its name for the error line. */
const ERROR_NAMES: readonly (readonly [AutoPlayField, string])[] = [
  ...FIELDS.map((field) => [field.name, field.full] as const),
  ['onWinPercent', 'On win'],
  ['onLossPercent', 'On loss'],
];

/**
 * Auto-play: a number of rounds, a target pump count, stop limits, and what
 * happens to the bets after a win or a loss. It starts from the bets in the
 * bet panel below it. While it runs, this shows the progress with the
 * round's bet, Stop, and Cash out for the balloons in play. The rules are
 * spelled out in settings, under Game info.
 */
export function AutoPlayPanel({
  ladder,
  topRung,
  difficultyLabel,
  roundBetCents,
  betsValid,
  limits,
  betSizing,
  roundActive,
  starting,
  status,
  round,
  onStart,
  onStop,
  onCashOut,
}: AutoPlayPanelProps) {
  const [form, setForm] = useState<AutoPlayForm>(initialForm);
  const check = checkAutoPlayForm(form, ladder.length, roundBetCents, betSizing);
  const { running, stopping, progress, settings, stopReason, bets } = status;
  const firstWrong = ERROR_NAMES.find(([name]) => check.errors[name] !== null);
  // What the pump count reaches, shown under the Pumps box (pumpReach).
  const reach =
    check.errors.targetPumps === null
      ? pumpReach(ladder, Number(form.targetPumps), topRung, difficultyLabel)
      : null;

  const panelRef = useRef<HTMLElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const percentRefs = useRef<Partial<Record<SizingSpec['kind'], HTMLInputElement | null>>>({});
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

  const chooseChange = (spec: SizingSpec, kind: BetChangeKind): void => {
    // The percent box appears with "Increase": type straight into it. It is
    // drawn at once (flushSync), so it can take focus before the next key.
    flushSync(() => setForm({ ...form, [spec.kind]: kind }));
    if (kind === 'increase') percentRefs.current[spec.kind]?.focus();
  };

  const net = (
    <strong className={progress.netCents > 0 ? 'win' : undefined}>
      {formatSignedCents(progress.netCents)}
    </strong>
  );
  const showsResult = !running && stopReason !== null;
  const roundBets = bets === null ? null : totalBetCents(bets);
  const held = running && bets !== null ? describeHeld(bets, limits) : null;

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
            Round {Math.min(progress.roundsPlayed + 1, settings.rounds)} of {settings.rounds}
            {roundBets !== null && (
              <>
                {' · '}
                <span
                  title={
                    bets && bets.betsCents.length > 1
                      ? `Bets this round: ${bets.betsCents.map((b) => formatCents(b)).join(', ')}`
                      : 'Bet this round'
                  }
                >
                  bet {formatCents(roundBets)}
                </span>
              </>
            )}
            {' · '}net {net}
            {held !== null && <span className="auto-held">{held}</span>}
          </>
        ) : stopReason !== null ? (
          <>
            {describeStop(stopReason, progress, roundBets ?? roundBetCents)} Net {net}.
          </>
        ) : null}
      </p>

      {running && round && (
        <HandCashOuts
          round={round}
          asked={handCashOutsFor(status.handCashOuts, round.id)}
          onCashOut={onCashOut}
        />
      )}

      {/* The fields come after the button and the result line: the same
          top-to-bottom order as the bet panel, most used first. */}
      {!running && (
        <>
          {firstWrong && (
            <p className="note error">
              {firstWrong[1]}: {check.errors[firstWrong[0]]}
            </p>
          )}
          <div className="auto-grid">
            {FIELDS.map((field) => {
              const pumps = field.name === 'targetPumps';
              const box = (
                <label
                  key={field.name}
                  className="field"
                  title={pumps && reach !== null ? `${field.full}: ${reach.full}` : field.full}
                >
                  <span className="field-label">{field.label}</span>
                  <input
                    type="text"
                    inputMode={field.money ? 'decimal' : 'numeric'}
                    autoComplete="off"
                    aria-label={field.full}
                    aria-describedby={pumps && reach !== null ? 'auto-reach' : undefined}
                    value={form[field.name]}
                    aria-invalid={check.errors[field.name] !== null}
                    placeholder={field.money ? 'off' : undefined}
                    onChange={(event) => setForm({ ...form, [field.name]: event.target.value })}
                  />
                </label>
              );
              if (!pumps) return box;
              // Under the box, not in it, so the typed count always has room.
              // The line keeps its place while the count is being retyped.
              return (
                <div key={field.name} className="field-cell">
                  {box}
                  <span
                    className="field-reach"
                    id="auto-reach"
                    data-top={reach?.toppedOut ?? false}
                    title={reach?.full}
                  >
                    <span aria-hidden="true">{reach?.short}</span>
                    {/* Screen readers get it in full. */}
                    {reach !== null && <span className="visually-hidden">{reach.full}</span>}
                  </span>
                </div>
              );
            })}
          </div>
          {betSizing && (
            <div className="auto-sizing">
              {SIZING.map((spec) => {
                const increase = form[spec.kind] === 'increase';
                return (
                  <div key={spec.kind} className="auto-sizing-row" role="group" aria-label={spec.label}>
                    <span className="field-label" aria-hidden="true">
                      {spec.label}
                    </span>
                    <div
                      className="segmented"
                      role="radiogroup"
                      aria-label={`${spec.label}: the bets`}
                    >
                      {(['reset', 'increase'] as const).map((kind) => (
                        <button
                          key={kind}
                          type="button"
                          role="radio"
                          aria-checked={form[spec.kind] === kind}
                          className="segment"
                          title={
                            kind === 'reset'
                              ? `${spec.label}, go back to the bets you entered`
                              : `${spec.label}, raise every bet by a percent, rounded down to the cent`
                          }
                          onClick={() => chooseChange(spec, kind)}
                        >
                          {kind === 'reset' ? 'Reset' : 'Increase'}
                        </button>
                      ))}
                    </div>
                    <label className="field field-pct" data-off={!increase}>
                      <input
                        ref={(el) => {
                          percentRefs.current[spec.kind] = el;
                        }}
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        aria-label={`${spec.label}: increase every bet by this percent`}
                        value={form[spec.percent]}
                        disabled={!increase}
                        aria-invalid={check.errors[spec.percent] !== null}
                        onChange={(event) =>
                          setForm({ ...form, [spec.percent]: event.target.value })
                        }
                      />
                      <span className="muted" aria-hidden="true">
                        %
                      </span>
                    </label>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The player's own Cash out while auto-play runs. With one balloon, one
 * button. With two or three, one per balloon (with its colour dot) and Cash
 * out all, in fixed places, so nothing moves under a finger as balloons end.
 *
 * A press doesn't go to the server here: auto-play sends it as that
 * balloon's next step, right after any pump already on its way (and only if
 * that pump holds). So the buttons show no amount: auto-play keeps a pump on
 * its way almost all the time, and an amount would mostly be one step behind
 * what the press pays (or show money a pop then takes). They say "after
 * pump", steadily, never flickering with each pump. Once pressed, a button
 * says "queued" until the balloon is out.
 */
function HandCashOuts({
  round,
  asked,
  onCashOut,
}: {
  readonly round: RoundView;
  readonly asked: ReadonlySet<number>;
  readonly onCashOut: (balloonIndexes: readonly number[]) => void;
}) {
  const multi = round.balloons.length > 1;
  const open = (b: BalloonView): boolean =>
    b.status === 'active' && b.cashOutCents !== null && !asked.has(b.index);
  const cashable = round.balloons.filter(open);
  const queued = round.balloons.filter((b) => b.status === 'active' && asked.has(b.index));
  const text = (b: BalloonView): string =>
    b.status !== 'active' || b.cashOutCents === null
      ? '—'
      : asked.has(b.index)
        ? 'queued'
        : 'after pump';
  const hint = 'Cashes out right after any pump on its way, if that pump holds.';

  return (
    <div className="auto-cash" data-count={round.balloons.length}>
      {round.balloons.map((b) => (
        <button
          key={b.index}
          type="button"
          className="btn btn-outline btn-two"
          disabled={!open(b)}
          onClick={() => onCashOut([b.index])}
          title={multi ? `Cash out balloon ${b.index + 1}. ${hint}` : `Cash out. ${hint}`}
          aria-label={
            open(b)
              ? `Cash out${multi ? ` balloon ${b.index + 1}` : ''} after the pump on its way`
              : undefined
          }
        >
          <span className="btn-name">
            {multi && <span className="dot" data-slot={b.index + 1} aria-hidden="true" />}
            Cash out
          </span>
          <strong>{text(b)}</strong>
        </button>
      ))}
      {multi && (
        <button
          type="button"
          className="btn btn-outline btn-two"
          disabled={cashable.length === 0}
          onClick={() => onCashOut(cashable.map((b) => b.index))}
          title={`Cash out every balloon in play that has been pumped. ${hint}`}
        >
          <span>Cash out all</span>
          <strong>
            {cashable.length > 0 ? 'after pump' : queued.length > 0 ? 'queued' : '—'}
          </strong>
        </button>
      )}
    </div>
  );
}
