import type { CSSProperties } from 'react';
import type { BalloonView, PumpOutcome } from '../api/contract';
import { Balloon, balloonScale, type BalloonBeat } from '../balloon/Balloon';
import type { Beat } from '../game/useGame';
import { riskStep } from '../game/risk';
import { HoldButton } from './HoldButton';
import { multiplierAt } from '../game/rules';
import type { WinTier } from '../game/winTier';
import { formatCents, formatMultiplier } from '../money';

interface BalloonCardProps {
  readonly balloon: BalloonView;
  readonly ladder: readonly number[];
  readonly beat: Beat;
  /** Its last pump was bought with a Patch. */
  readonly patched: boolean;
  /** What its last pump did, kept until the next press. */
  readonly outcome: PumpOutcome | null;
  /** Its own cash-out ended the round in a win: it waits a moment before it floats away. */
  readonly held: boolean;
  /** A request for this balloon is on its way. */
  readonly pending: boolean;
  /** This round's win effects have already played: the art gets no win any more. */
  readonly winShown: boolean;
  /**
   * The round's win tier once it is over, or null. A round is one game, so
   * win effects are judged over all its balloons (UK RTS 14F).
   */
  readonly roundWin: WinTier | null;
  /** Auto-play is running: don't read every change out loud. */
  readonly quiet: boolean;
  /** The round has more than one balloon and the player may pick this one. */
  readonly selectable: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
  /** It can be pumped by hand now: the round is played by hand and this balloon is still in play. */
  readonly canPump: boolean;
  /** Picks this balloon and pumps it once (from the keyboard). */
  readonly onPump: () => void;
  /** Picks this balloon and pumps it, again and again while held. */
  readonly onPumpHold: () => void;
}

/**
 * The balloon art's data-beat for this balloon. A live result plays its
 * motion once. With no live result (say, a round restored after a refresh),
 * a finished balloon shows only its end picture, so a pop or cash-out never
 * plays twice.
 *
 * `pending`: this balloon's own request is still on its way. Answers can
 * arrive out of order: another balloon's answer may already show this one
 * as cashed out. Until its own answer arrives (and starts the motion), it is
 * still drawn in play, instead of vanishing and then floating away.
 */
export function balloonBeat(
  balloon: BalloonView,
  beat: Beat,
  pending = false,
): BalloonBeat | undefined {
  if (pending && beat === 'idle') return undefined;
  switch (beat) {
    case 'press':
      return 'press';
    case 'survived':
      return 'survive';
    case 'saved':
      // The Patch stopped a pop: same size, no grow.
      return 'blocked';
    case 'popped':
      return 'pop';
    case 'cashed':
    case 'top':
      // Set only once the server has confirmed the cash-out.
      return 'cashout';
    case 'idle':
      break;
  }
  if (balloon.status === 'popped') return 'popped';
  if (balloon.status === 'cashed') return 'cashed';
  return undefined;
}

/**
 * How much the balloon strains, 0 to 3. It comes only from the published
 * chance that its next pump pops, never from a draw: the same four steps
 * that colour the pop chance in the panel.
 */
export function balloonStrain(balloon: BalloonView): number | undefined {
  const next = balloon.next;
  if (balloon.status !== 'active' || !next) return undefined;
  return riskStep(next.popChance) - 1;
}

/**
 * The Patch sticker for a pump bought with a Patch: it goes on with the
 * press, then tears off if it stopped a pop (the pump would have popped
 * the balloon) or peels off if the pump survived anyway, the pump that
 * reached the top included.
 */
export function balloonPatch(beat: Beat, patched: boolean): 'on' | 'spent' | 'torn' | undefined {
  if (!patched) return undefined;
  switch (beat) {
    case 'press':
      return 'on';
    case 'saved':
      return 'torn';
    case 'survived':
    case 'top':
      return 'spent';
    default:
      return undefined;
  }
}

/** The big line under a balloon: its multiplier, or how it ended. */
function mainText(balloon: BalloonView): string {
  if (balloon.status === 'popped') return 'Popped';
  if (balloon.status === 'refunded') return 'Refunded';
  if (balloon.multiplierHundredths === null) return '—';
  return formatMultiplier(balloon.multiplierHundredths);
}

/**
 * The small line under it: the money that goes with the big line. A Patch is
 * also said in plain words: "Patch on" while that pump is on its way, then
 * what it did, which stays until the next press.
 */
export function subText(
  balloon: BalloonView,
  beat: Beat,
  patched: boolean,
  outcome: PumpOutcome | null,
): string {
  switch (balloon.status) {
    case 'popped':
      return formatCents(-(balloon.betCents + balloon.patchesCents));
    case 'refunded':
      return formatCents(balloon.betCents);
    case 'cashed':
      return `Paid ${formatCents(balloon.payoutCents)}`;
    case 'active':
      if (beat === 'press' && patched) return 'Patch on';
      // The pump would have popped the balloon; the Patch stopped it.
      if (outcome === 'saved') return 'Patch stopped a pop';
      if (outcome === 'survived' && patched) return 'Patch not needed';
      if (balloon.cashOutCents === null) return `Bet ${formatCents(balloon.betCents)}`;
      return formatCents(balloon.cashOutCents);
  }
}

/**
 * The two lines under a balloon. They shrink to fit their slot, so a long
 * amount on a narrow phone never spills into the next balloon: the CSS
 * divides the slot's width by the number of characters.
 */
function SlotLabel({
  main,
  sub,
  won = false,
  live = false,
}: {
  readonly main: string;
  readonly sub: string;
  readonly won?: boolean;
  readonly live?: boolean;
}) {
  const style = { '--main-chars': main.length, '--sub-chars': sub.length } as CSSProperties;
  return (
    <p className="slot-label" style={style} aria-live={live ? 'polite' : undefined}>
      <span className="slot-main">{main}</span>
      <span className={won ? 'slot-sub win' : 'slot-sub'}>{sub}</span>
    </p>
  );
}

/**
 * The row under a balloon's numbers that holds its own Pump button. The row
 * is always there, even with no button in it, so a balloon never changes
 * size when its button comes or goes.
 */
function SlotAction({
  slot,
  show,
  onPump,
  onPumpHold,
}: {
  readonly slot: number;
  readonly show: boolean;
  readonly onPump: () => void;
  readonly onPumpHold: () => void;
}) {
  return (
    <div className="slot-action">
      {show && (
        <HoldButton
          className="btn slot-pump"
          // Never greyed out while a pump is on its way: during a hold it
          // would flash on every pump, and the balloon's press already shows
          // it. A press that comes too soon is ignored by the game.
          onHoldStart={onPumpHold}
          onPress={onPump}
          aria-label={`Pump balloon ${slot}`}
          title={`Pump balloon ${slot}. Hold to keep pumping.`}
        >
          Pump
        </HoldButton>
      )}
    </div>
  );
}

/**
 * One balloon in a round: its picture, two lines of numbers and its own
 * Pump button. Cash out and Patch + Pump are in the control panel
 * (RoundControls), which acts on the balloon the player picked; pumping a
 * balloon from its own button picks it too.
 */
export function BalloonCard({
  balloon,
  ladder,
  beat,
  patched,
  outcome,
  held,
  pending,
  winShown,
  roundWin,
  quiet,
  selectable,
  selected,
  onSelect,
  canPump,
  onPump,
  onPumpHold,
}: BalloonCardProps) {
  const slot = balloon.index + 1;
  const topMultiplier = multiplierAt(ladder, balloon.topRung);
  // Only a real gain is celebrated, judged over the whole round: never a
  // round that paid back no more than its bets and Patches.
  const win = balloon.status === 'cashed' && roundWin !== null ? roundWin : undefined;
  // The art plays the win once; the label keeps its win colour.
  const artWin = winShown ? undefined : win;

  return (
    <article
      className="slot"
      data-selectable={selectable}
      data-selected={selected}
      data-status={balloon.status}
      onClick={selectable ? onSelect : undefined}
      aria-label={`Balloon ${slot}`}
      aria-current={selected ? 'true' : undefined}
    >
      <div className="balloon-box">
        <Balloon
          slot={slot}
          scale={balloonScale(balloon.multiplierHundredths, topMultiplier)}
          beat={balloonBeat(balloon, beat, pending)}
          strain={balloonStrain(balloon)}
          patch={balloonPatch(beat, patched)}
          win={artWin}
          top={balloon.rung === balloon.topRung}
          hold={held}
          // The pump that reached the top: the handle comes back up as the
          // balloon grows to full size and is let go.
          stroke={beat === 'top' ? 'up' : undefined}
          value={
            balloon.multiplierHundredths === null ? '' : formatMultiplier(balloon.multiplierHundredths)
          }
        />
      </div>
      <SlotLabel
        main={mainText(balloon)}
        sub={subText(balloon, beat, patched, outcome)}
        won={win !== undefined}
        live={!quiet}
      />
      <SlotAction slot={slot} show={canPump} onPump={onPump} onPumpHold={onPumpHold} />
    </article>
  );
}

interface PreviewCardProps {
  readonly slot: number;
  /** The bet typed for this balloon, or null while it is not a valid amount. */
  readonly betCents: number | null;
}

/** A balloon before the round starts, with the bet that will ride on it. */
export function PreviewCard({ slot, betCents }: PreviewCardProps) {
  return (
    <article className="slot" data-status="preview" aria-label={`Balloon ${slot}`}>
      <div className="balloon-box">
        <Balloon slot={slot} scale={0.45} />
      </div>
      <SlotLabel main={betCents === null ? '—' : formatCents(betCents)} sub="" />
      <SlotAction slot={slot} show={false} onPump={() => undefined} onPumpHold={() => undefined} />
    </article>
  );
}
