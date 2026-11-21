import type { BalloonView } from '../api/contract';
import { riskStep } from '../game/risk';
import { formatCents, formatChance, formatMultiplier } from '../money';
import { HoldButton } from './HoldButton';

/** A small piece of tape with stitches: the same patch the balloon wears. */
function PatchIcon() {
  return (
    <svg className="patch-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <g transform="rotate(-18 8 8)">
        <rect x="1.5" y="4.5" width="13" height="7" rx="1.6" fill="currentColor" />
        <rect
          x="3.2"
          y="6.1"
          width="9.6"
          height="3.8"
          rx="0.8"
          fill="none"
          stroke="#8a8f9a"
          strokeWidth="0.9"
          strokeDasharray="1.5 1.2"
        />
      </g>
    </svg>
  );
}

interface RoundControlsProps {
  /** The balloon the buttons act on, or null if the picked one is over. */
  readonly balloon: BalloonView | null;
  /**
   * The round has more than one balloon. Each has its own Pump button under
   * it, so the big button here pumps them all.
   */
  readonly multi: boolean;
  /**
   * A request for this balloon is on its way, or the controls just moved to
   * it from a balloon that ended: Cash out and Patch + Pump wait.
   */
  readonly pending: boolean;
  /** Pumps the picked balloon once (from the keyboard). */
  readonly onPump: () => void;
  /** Pumps the picked balloon, again and again while held. */
  readonly onPumpHold: () => void;
  readonly onPatchPump: () => void;
  readonly onCashOut: () => void;
  /** How many balloons are still in play. */
  readonly liveCount: number;
  /** Pumps every balloon still in play once, each as its own pump. */
  readonly onPumpAll: () => void;
  /** The same, again and again while held. */
  readonly onPumpAllHold: () => void;
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
 * Either one keeps pumping while it is held down.
 */
export function RoundControls({
  balloon,
  multi,
  pending,
  onPump,
  onPumpHold,
  onPatchPump,
  onCashOut,
  liveCount,
  onPumpAll,
  onPumpAllHold,
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
        {/* A filled panel with the tape icon, so it can't be taken for Cash
            out (a plain outline) or Pump (solid pearl). */}
        <button
          type="button"
          className="btn btn-two btn-patch"
          disabled={off || patchPrice === null}
          onClick={onPatchPump}
          title="Buy a Patch for this pump, then pump (P). If it would pop, the Patch is used up and the balloon stays."
        >
          <span className="patch-name">
            <PatchIcon />
            Patch + Pump
          </span>
          <strong>{patchPrice === null ? '—' : formatCents(patchPrice)}</strong>
        </button>
        {/* Never greyed out while a pump is on its way, so a hold doesn't
            flash; a press that comes too soon is ignored by the game. */}
        {multi ? (
          <HoldButton
            className="btn btn-primary"
            disabled={liveCount === 0}
            onHoldStart={onPumpAllHold}
            onPress={onPumpAll}
            title="Pump every balloon still in play (A). Hold to keep pumping."
          >
            Pump all
          </HoldButton>
        ) : (
          <HoldButton
            className="btn btn-primary"
            disabled={balloon === null}
            onHoldStart={onPumpHold}
            onPress={onPump}
            title="Pump (Space). Hold to keep pumping."
          >
            Pump
          </HoldButton>
        )}
      </div>
    </section>
  );
}
