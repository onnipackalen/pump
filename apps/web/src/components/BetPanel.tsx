import type { GameConfig } from '@pump/engine';
import type { BetCheck, BetSetup } from '../game/betSetup';
import { withBalloonCount } from '../game/betSetup';
import { multiplierAt, popChance, topRungForBet } from '../game/rules';
import {
  centsToInput,
  formatCents,
  formatChance,
  formatMultiplier,
  parseDollarsToCents,
} from '../money';

interface BetPanelProps {
  readonly config: GameConfig;
  readonly setup: BetSetup;
  readonly check: BetCheck;
  readonly disabled: boolean;
  readonly starting: boolean;
  readonly onChange: (setup: BetSetup) => void;
  readonly onStart: () => void;
}

/** Halves or doubles a typed bet, kept inside the limits. */
function scaleBet(text: string, factor: 0.5 | 2, min: number, max: number): string {
  const cents = parseDollarsToCents(text);
  if (cents === null) return text;
  const scaled = factor === 2 ? cents * 2 : (cents - (cents % 2)) / 2;
  return centsToInput(Math.min(max, Math.max(min, scaled)));
}

/** Choose a difficulty, 1 to 3 balloons and a bet on each, then start. */
export function BetPanel({
  config,
  setup,
  check,
  disabled,
  starting,
  onChange,
  onStart,
}: BetPanelProps) {
  const { limits } = config;
  const difficulty =
    config.difficulties.find((d) => d.id === setup.difficultyId) ?? config.difficulties[0];
  if (!difficulty) return null;
  const ladder = difficulty.ladder;
  const fullTop = multiplierAt(ladder, ladder.length);
  const counts = Array.from({ length: limits.maxBalloons }, (_, i) => i + 1);

  const setBet = (index: number, text: string): void => {
    onChange({ ...setup, bets: setup.bets.map((bet, i) => (i === index ? text : bet)) });
  };

  return (
    <section className="card panel" aria-label="Bet">
      <h2>Difficulty</h2>
      <div className="segmented" role="radiogroup" aria-label="Difficulty">
        {config.difficulties.map((d) => (
          <button
            key={d.id}
            type="button"
            role="radio"
            aria-checked={d.id === difficulty.id}
            className="segment"
            disabled={disabled}
            onClick={() => onChange({ ...setup, difficultyId: d.id })}
          >
            {d.label}
          </button>
        ))}
      </div>
      <p className="hint">
        {ladder.length} pumps to the top of {formatMultiplier(fullTop)}. The first pump pops{' '}
        {formatChance(popChance(config.rtpBp, ladder, 1))} of the time; each pump after is riskier.
      </p>

      <h2>Balloons</h2>
      <div className="segmented" role="radiogroup" aria-label="Number of balloons">
        {counts.map((count) => (
          <button
            key={count}
            type="button"
            role="radio"
            aria-checked={count === setup.bets.length}
            className="segment"
            disabled={disabled}
            onClick={() => onChange(withBalloonCount(setup, count))}
          >
            {count}
          </button>
        ))}
      </div>

      <h2>Bets</h2>
      <ul className="bets">
        {setup.bets.map((text, index) => {
          const error = check.errors[index] ?? null;
          const cents = error === null ? parseDollarsToCents(text) : null;
          const top = cents === null ? null : topRungForBet(ladder, cents, limits.maxPayoutCents);
          return (
            <li key={index}>
              <label className="bet-row">
                <span className="bet-label">Balloon {index + 1}</span>
                <span className="bet-input">
                  <span aria-hidden="true">$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={text}
                    disabled={disabled}
                    aria-invalid={error !== null}
                    onChange={(event) => setBet(index, event.target.value)}
                  />
                </span>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={disabled}
                  onClick={() =>
                    setBet(index, scaleBet(text, 0.5, limits.minBetCents, limits.maxBetCents))
                  }
                >
                  ½
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={disabled}
                  onClick={() =>
                    setBet(index, scaleBet(text, 2, limits.minBetCents, limits.maxBetCents))
                  }
                >
                  2×
                </button>
              </label>
              {error !== null ? (
                <p className="bet-note error">{error}</p>
              ) : top !== null && top < ladder.length ? (
                <p className="bet-note warn">
                  Capped: this bet tops out at rung {top} of {ladder.length} (
                  {formatMultiplier(multiplierAt(ladder, top))}), because one balloon pays at most{' '}
                  {formatCents(limits.maxPayoutCents)}.
                </p>
              ) : (
                <p className="bet-note">Can reach the top: {formatMultiplier(fullTop)}</p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="total-row">
        <span>Total bet</span>
        <strong>{formatCents(check.totalCents)}</strong>
      </div>
      {check.problem !== null && <p className="bet-note error">{check.problem}</p>}

      <button
        type="button"
        className="btn btn-pump btn-wide"
        disabled={disabled || starting || check.betsCents === null}
        onClick={onStart}
      >
        {starting ? 'Starting…' : 'Start round'}
      </button>
    </section>
  );
}
