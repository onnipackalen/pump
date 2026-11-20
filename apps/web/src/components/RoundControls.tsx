import type { BalloonView, Fraction } from '../api/contract';
import { formatCents, formatChance, formatMultiplier } from '../money';

interface RoundControlsProps {
  /** The balloon the buttons act on, or null if the picked one is over. */
  readonly balloon: BalloonView | null;
  /** The round has more than one balloon, so the panel names the picked one. */
  readonly multi: boolean;
  /** A request for this balloon is on its way. */
  readonly pending: boolean;
  readonly onPump: () => void;
  readonly onPatchPump: () => void;
  readonly onCashOut: () => void;
}

/**
 * Which of the four risk colours a pop chance gets: under 25%, under 40%,
 * under 60%, and above. The same steps on every difficulty. It reads the
 * chance the player is shown, in whole numbers, never a draw.
 */
function riskStep({ num, den }: Fraction): 1 | 2 | 3 | 4 {
  if (num * 100 < den * 25) return 1;
  if (num * 100 < den * 40) return 2;
  if (num * 100 < den * 60) return 3;
  return 4;
}

/**
 * The control panel during a round: the next pump's numbers for the picked
 * balloon, and its three buttons. One set of buttons for the whole round,
 * so they stay large and in the same place however many balloons there are.
 */
export function RoundControls({
  balloon,
  multi,
  pending,
  onPump,
  onPatchPump,
  onCashOut,
}: RoundControlsProps) {
  const next = balloon?.next ?? null;
  const patchPrice = next?.patchPriceCents ?? null;
  const cashOut = balloon?.cashOutCents ?? null;
  const off = balloon === null || pending;

  return (
    <section className="round" aria-label="Round controls">
      {multi && (
        <p className="round-target" aria-live="polite">
          {balloon ? (
            <>
              <span className="dot" data-slot={balloon.index + 1} aria-hidden="true" />
              Balloon {balloon.index + 1}
            </>
          ) : (
            <span className="muted">Pick a balloon</span>
          )}
        </p>
      )}

      <dl className="readouts">
        <div>
          <dt title="The chance that the next pump pops this balloon">Pop chance</dt>
          <dd data-risk={next ? riskStep(next.popChance) : undefined}>
            {next ? formatChance(next.popChance) : '—'}
          </dd>
        </div>
        <div>
          <dt title="The multiplier after the next pump, if it survives">Next</dt>
          <dd>{next ? formatMultiplier(next.multiplierHundredths) : '—'}</dd>
        </div>
        <div>
          <dt title="This balloon's bet plus any Patches bought for it">Total bet</dt>
          <dd>{balloon ? formatCents(balloon.betCents + balloon.patchesCents) : '—'}</dd>
        </div>
        <div>
          <dt title="Pumps survived, out of the most this bet can reach">Rung</dt>
          <dd>{balloon ? `${balloon.rung}/${balloon.topRung}` : '—'}</dd>
        </div>
      </dl>

      <div className="round-actions">
        <button
          type="button"
          className="btn btn-outline btn-two"
          disabled={off || cashOut === null}
          onClick={onCashOut}
          title="Cash out (C)"
        >
          <span>Cash out</span>
          <strong>{cashOut === null ? '—' : formatCents(cashOut)}</strong>
        </button>
        <button
          type="button"
          className="btn btn-two"
          disabled={off || patchPrice === null}
          onClick={onPatchPump}
          title="Buy a Patch for this pump, then pump (P). If it would pop, the Patch is used up and the balloon stays."
        >
          <span>Patch + Pump</span>
          <strong>{patchPrice === null ? '—' : formatCents(patchPrice)}</strong>
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={off}
          onClick={onPump}
          title="Pump (Space)"
        >
          Pump
        </button>
      </div>
    </section>
  );
}
