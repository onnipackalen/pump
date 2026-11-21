import type { BalloonView } from '../api/contract';
import { nextPumpGainCents } from '../game/patchGain';
import { riskStep } from '../game/risk';
import type { CSSProperties } from 'react';
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
  /** Every balloon in the round, ended ones included. */
  readonly balloons: readonly BalloonView[];
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
  /** Cashes out every balloon still in play that has been pumped. */
  readonly onCashOutAll: () => void;
  /** How many balloons are still in play. */
  readonly liveCount: number;
  /** Pumps every balloon still in play once, each as its own pump. */
  readonly onPumpAll: () => void;
  /** The same, again and again while held. */
  readonly onPumpAllHold: () => void;
}

/** The picked balloon's colour, as on the bet panel: names it without words. */
function SlotDot({ balloon }: { readonly balloon: BalloonView | null }) {
  if (balloon === null) return null;
  return <span className="dot" data-slot={balloon.index + 1} aria-hidden="true" />;
}

/**
 * The control panel during a round: the next pump's numbers for the picked
 * balloon, its Cash out and Patch + Pump, and one big button. One set of
 * buttons for the whole round, so they stay large and in the same place
 * however many balloons there are.
 *
 * With two or three balloons, Cash out and Patch + Pump carry the picked
 * balloon's colour dot (it is also marked on the stage by a soft beam and a
 * bar), and Cash out all sits beside the big button. Which buttons exist is
 * fixed for the whole round, so nothing moves under a finger when a balloon
 * ends; only labels change.
 *
 * Each balloon has its own Pump button under it (BalloonCard). So the big
 * button pumps every balloon still in play: Pump all while two or more are,
 * Pump once only one is left. It keeps pumping while it is held down.
 */
export function RoundControls({
  balloon,
  multi,
  pending,
  onPump,
  onPumpHold,
  onPatchPump,
  onCashOut,
  onCashOutAll,
  balloons,
  liveCount,
  onPumpAll,
  onPumpAllHold,
}: RoundControlsProps) {
  const next = balloon?.next ?? null;
  const patchPrice = next?.patchPriceCents ?? null;
  const cashOut = balloon?.cashOutCents ?? null;
  const off = balloon === null || pending;
  // Money in the whole round: every balloon's bet plus its Patches.
  const totalBetCents = balloons.reduce((sum, b) => sum + b.betCents + b.patchesCents, 0);
  // Cash out all takes every balloon in play that has a cash-out value.
  const cashable = balloons.filter((b) => b.status === 'active' && b.cashOutCents !== null);
  const cashAllCents = cashable.reduce((sum, b) => sum + (b.cashOutCents ?? 0), 0);
  const name = balloon && multi ? `balloon ${balloon.index + 1}` : null;
  // What the next pump adds if it holds, shown beside the Patch price so the
  // two can be weighed. Early pumps on a low-risk ladder price the Patch at
  // about the whole gain, and the player should be able to see that.
  const gain = balloon && patchPrice !== null ? nextPumpGainCents(balloon) : null;
  const priceText = patchPrice === null ? '—' : formatCents(patchPrice);
  const gainText = gain === null ? null : `for +${formatCents(gain)}`;
  // Each amount shrinks to fit the button by its length (see .patch-price).
  const chars = (text: string): CSSProperties => ({ '--chars': text.length }) as CSSProperties;
  const patchHint =
    patchPrice !== null && gain !== null && cashOut !== null
      ? `Costs ${formatCents(patchPrice)}. If the pump holds, ${name ?? 'the balloon'} goes from ${formatCents(cashOut)} to ${formatCents(cashOut + gain)}. If it would pop, the Patch keeps it at ${formatCents(cashOut)}. (Shift+P)`
      : `Buy a Patch for the next pump${name ? ` of ${name}` : ''}, then pump (Shift+P). If it would pop, the Patch is used up and the balloon stays.`;

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
          <dt title="Every balloon's bet in this round, plus any Patches bought">Total bet</dt>
          <dd>{formatCents(totalBetCents)}</dd>
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
          title={name ? `Cash out ${name} (C)` : 'Cash out (C)'}
          aria-label={name && cashOut !== null ? `Cash out ${name}, ${formatCents(cashOut)}` : undefined}
        >
          <span className="btn-name">
            {multi && <SlotDot balloon={balloon} />}
            Cash out
          </span>
          <strong>{cashOut === null ? '—' : formatCents(cashOut)}</strong>
        </button>
        {/* A filled panel with the tape icon, so it can't be taken for Cash
            out (a plain outline) or Pump (solid pearl). */}
        <button
          type="button"
          className="btn btn-two btn-patch"
          disabled={off || patchPrice === null}
          onClick={onPatchPump}
          title={patchHint}
          aria-label={
            patchPrice !== null
              ? `Patch + Pump${name ? ` ${name}` : ''}, ${formatCents(patchPrice)}${
                  gain === null ? '' : `; the pump adds ${formatCents(gain)} if it holds`
                }`
              : undefined
          }
        >
          <span className="btn-name">
            {multi && <SlotDot balloon={balloon} />}
            <PatchIcon />
            Patch + Pump
          </span>
          <strong className="patch-price" style={chars(priceText)}>
            {priceText}
          </strong>
          {/* Always there, so the button keeps one height all round. */}
          <span className="patch-gain" style={chars(gainText ?? '')}>
            {gainText ?? '\u00a0'}
          </span>
        </button>
        {/* Never greyed out while a pump is on its way, so a hold doesn't
            flash; a press that comes too soon is ignored by the game. */}
        {multi ? (
          <div className="round-all">
            <button
              type="button"
              className="btn btn-outline btn-two"
              disabled={cashable.length === 0}
              onClick={onCashOutAll}
              title="Cash out every balloon still in play that has been pumped"
            >
              <span>Cash out all</span>
              <strong>{cashable.length === 0 ? '—' : formatCents(cashAllCents)}</strong>
            </button>
            <HoldButton
              className="btn btn-primary"
              disabled={liveCount === 0}
              onHoldStart={onPumpAllHold}
              onPress={onPumpAll}
              title={
                liveCount > 1
                  ? 'Pump every balloon still in play (A). Hold to keep pumping.'
                  : 'Pump the balloon still in play (A). Hold to keep pumping.'
              }
            >
              {liveCount > 1 ? 'Pump all' : 'Pump'}
            </HoldButton>
          </div>
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
