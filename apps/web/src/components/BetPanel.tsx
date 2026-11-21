import type { GameConfig } from '@pump/engine';
import type { MouseEvent } from 'react';
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
  /** Whether to show the Bet button. Auto-play has its own start button. */
  readonly showBet: boolean;
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

/**
 * The top rung the info line shows: the highest any of the entered bets can
 * reach. A bet that could pay more than the max payout tops out lower (its
 * box says so), so with one such bet the line shows that lower top, not the
 * ladder's. Bets not typed in right yet are left out; with none, the
 * ladder's own top.
 */
export function shownTopRung(
  ladder: readonly number[],
  betsCents: readonly (number | null)[],
  maxPayoutCents: number,
): number {
  let top = 0;
  for (const bet of betsCents) {
    if (bet !== null && bet > 0) top = Math.max(top, topRungForBet(ladder, bet, maxPayoutCents));
  }
  return top === 0 ? ladder.length : top;
}

/**
 * The bets as typed, in cents, one per balloon; null for one not typed in
 * right yet. What shownTopRung reads, here and in the auto-play panel.
 */
export function typedBetCents(setup: BetSetup, check: BetCheck): (number | null)[] {
  return setup.bets.map((text, i) =>
    (check.errors[i] ?? null) === null ? parseDollarsToCents(text) : null,
  );
}

/**
 * A mouse press on a small button must not take focus, as on HoldButton:
 * then Enter still means "bet" (App's Enter needs nothing focused), instead
 * of pressing ½ or 2× again.
 */
const keepFocus = (event: MouseEvent<HTMLButtonElement>): void => event.preventDefault();

/** Choose a difficulty, 1 to 3 balloons and a bet on each, then bet. */
export function BetPanel({
  config,
  setup,
  check,
  disabled,
  starting,
  showBet,
  onChange,
  onStart,
}: BetPanelProps) {
  const { limits } = config;
  const difficulty =
    config.difficulties.find((d) => d.id === setup.difficultyId) ?? config.difficulties[0];
  if (!difficulty) return null;
  const ladder = difficulty.ladder;
  // The info line's top: the one the entered bets can reach (shownTopRung).
  const topRung = shownTopRung(ladder, typedBetCents(setup, check), limits.maxPayoutCents);
  const topCapped = topRung < ladder.length;
  const counts = Array.from({ length: limits.maxBalloons }, (_, i) => i + 1);
  const many = setup.bets.length > 1;

  const setBet = (index: number, text: string): void => {
    onChange({ ...setup, bets: setup.bets.map((bet, i) => (i === index ? text : bet)) });
  };

  return (
    <section className="bet" aria-label="Bet">
      {/* Top to bottom, the order runs from what is pressed every round to
          what is seldom changed: Bet, the amounts, the number of balloons,
          the difficulty. On an upright screen the top of this panel is on
          screen and the rest is a scroll away (see styles.css). */}
      {showBet && (
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled || starting || check.betsCents === null}
          onClick={onStart}
          title="Bet (Enter)"
        >
          {starting ? 'Starting…' : `Bet ${formatCents(check.totalCents)}`}
        </button>
      )}

      {check.problem !== null && <p className="note error">{check.problem}</p>}

      <ul className="bets">
        {setup.bets.map((text, index) => {
          const error = check.errors[index] ?? null;
          const cents = error === null ? parseDollarsToCents(text) : null;
          const top = cents === null ? null : topRungForBet(ladder, cents, limits.maxPayoutCents);
          const capped = top !== null && top < ladder.length;
          return (
            <li key={index}>
              <div className="bet-row">
                <label className="field field-money">
                  {many && <span className="dot" data-slot={index + 1} aria-hidden="true" />}
                  <span className="field-label">{many ? `Bet ${index + 1}` : 'Bet'}</span>
                  <span className="muted" aria-hidden="true">
                    $
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={text}
                    disabled={disabled}
                    aria-invalid={error !== null}
                    aria-describedby={capped ? `bet-cap-${index}` : undefined}
                    onChange={(event) => setBet(index, event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn"
                  aria-label={`Halve bet ${index + 1}`}
                  disabled={disabled}
                  onMouseDown={keepFocus}
                  onClick={() =>
                    setBet(index, scaleBet(text, 0.5, limits.minBetCents, limits.maxBetCents))
                  }
                >
                  ½
                </button>
                <button
                  type="button"
                  className="btn"
                  aria-label={`Double bet ${index + 1}`}
                  disabled={disabled}
                  onMouseDown={keepFocus}
                  onClick={() =>
                    setBet(index, scaleBet(text, 2, limits.minBetCents, limits.maxBetCents))
                  }
                >
                  2×
                </button>
              </div>
              {capped && (
                // The payout cap is shown before the round starts, never hidden.
                // It sits under the box, not in it: in the box it squeezed the
                // input on a narrow card until a $1,000 bet read as "$ 100".
                <p
                  className="note cap"
                  id={`bet-cap-${index}`}
                  title={`At this bet the balloon tops out at rung ${top} of ${ladder.length}, because one balloon pays at most ${formatCents(limits.maxPayoutCents)}.`}
                >
                  Top {formatMultiplier(multiplierAt(ladder, top))}
                </p>
              )}
              {error !== null && <p className="note error">{error}</p>}
            </li>
          );
        })}
      </ul>

      <div className="row">
        <span className="field-label" id="balloon-count-label">
          Balloons
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="balloon-count-label">
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
      </div>

      <p
        className="note bet-info"
        title={
          topCapped
            ? `At ${many ? 'these bets' : 'this bet'} the top is rung ${topRung} of ${ladder.length}, because one balloon pays at most ${formatCents(limits.maxPayoutCents)}.`
            : undefined
        }
      >
        {topRung} pumps · top {formatMultiplier(multiplierAt(ladder, topRung))} · first pop{' '}
        {formatChance(popChance(config.rtpBp, ladder, 1))}
      </p>
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
    </section>
  );
}
