import type { BalloonView } from '../api/contract';
import { riskStep } from '../game/risk';
import { formatCents, formatChance, formatMultiplier } from '../money';

interface RoundControlsProps {
  /** The balloon the buttons act on, or null if the picked one is over. */
  readonly balloon: BalloonView | null;
  /**
   * The round has more than one balloon. Each has its own Pump button under
   * it, so the big button here pumps them all.
   */
  readonly multi: boolean;
  /** A request for this balloon is on its way. */
  readonly pending: boolean;
  readonly onPump: () => void;
  readonly onPatchPump: () => void;
  readonly onCashOut: () => void;
  /** How many balloons are still in play with no request on its way. */
  readonly pumpableCount: number;
  /** Pumps every balloon still in play, each as its own pump. */
  readonly onPumpAll: () => void;
}

/**
 * The control panel during a round: the next pump's numbers for the picked
 * balloon, its Cash out and Patch + Pump, and one big button. One set of
 * buttons for the whole round, so they stay large and in the same place
 * however many balloons there are. The picked balloon is marked on the
 * stage (a soft beam and a bar), not named here.
 *
 * Each balloon has its own Pump button under it (BalloonCard). So with one
 * balloon the big button is Pump, and with two or three it is Pump all.
 */
export function RoundControls({
  balloon,
  multi,
  pending,
  onPump,
  onPatchPump,
  onCashOut,
  pumpableCount,
  onPumpAll,
}: RoundControlsProps) {
  const next = balloon?.next ?? null;
  const patchPrice = next?.patchPriceCents ?? null;
  const cashOut = balloon?.cashOutCents ?? null;
  const off = balloon === null || pending;

  return (
    <section className="round" aria-label="Round controls">
      {/* No name on screen; a screen reader still hears which balloon these are. */}
      <dl
        className="readouts"
        aria-label={balloon ? `Balloon ${balloon.index + 1}` : 'No balloon picked'}
      >
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
        {multi ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={pumpableCount === 0}
            onClick={onPumpAll}
            title="Pump every balloon still in play (A)"
          >
            Pump all
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={off}
            onClick={onPump}
            title="Pump (Space)"
          >
            Pump
          </button>
        )}
      </div>
    </section>
  );
}
