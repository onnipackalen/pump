import type { CSSProperties } from 'react';
import type { BalloonView, PumpOutcome } from '../api/contract';
import { Balloon, balloonSize, type BalloonBeat } from '../balloon/Balloon';
import { afterRoundLine, twoLineChars } from '../game/afterRound';
import type { Beat } from '../game/useGame';
import { balloonTension } from '../game/risk';
import { HoldButton } from './HoldButton';
import type { WinTier } from '../game/winTier';
import { formatCents, formatMultiplier } from '../money';

interface BalloonCardProps {
  readonly balloon: BalloonView;
  /** The RTP and ladder its round was played with (its own copies). */
  readonly rtpBp: number;
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
  /**
   * It shows its own Pump button: the round is played by hand, and this
   * balloon and at least one other are still in play (see showOwnPump).
   */
  readonly canPump: boolean;
  /** Picks this balloon and pumps it once (from the keyboard). */
  readonly onPump: () => void;
  /** Picks this balloon and pumps it, again and again while held. */
  readonly onPumpHold: () => void;
  /**
   * The round is over and every balloon's motion has finished: a balloon
   * cashed out below its top rung may now say where it would have popped.
   */
  readonly afterRoundShown: boolean;
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

/**
 * How big the card draws a balloon: by how far up its own ladder it is,
 * pumps survived out of the pumps this bet can reach (see balloonSize).
 * The card picks its size here and nowhere else, so a test can check the
 * very rule the screen uses.
 */
export function cardScale(balloon: BalloonView): number {
  return balloonSize(balloon.rung, balloon.topRung);
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
 * is always there, even with no button in it (with one balloon in play there
 * is only the panel's big Pump), so a balloon never changes size when its
 * button comes or goes. Once the round is over, a balloon cashed out below
 * its top rung uses the empty row to say, small and grey, where it would
 * have popped (`after`). The two never meet: the button is only for a
 * balloon in play, the line only for one that cashed out.
 */
function SlotAction({
  slot,
  show,
  after = null,
  onPump,
  onPumpHold,
}: {
  readonly slot: number;
  readonly show: boolean;
  readonly after?: string | null;
  readonly onPump: () => void;
  readonly onPumpHold: () => void;
}) {
  return (
    <div className="slot-action">
      {!show && after !== null && (
        <p
          className="slot-after"
          style={{ '--after-chars': twoLineChars(after) } as CSSProperties}
          title={after}
        >
          {after}
        </p>
      )}
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
 * One balloon in a round: its picture, two lines of numbers and, while two
 * or more balloons are in play, its own Pump button. Cash out and Patch + Pump
 * are in the control panel (RoundControls), which acts on the balloon the
 * player picked; pumping a balloon from its own button picks it too.
 */
export function BalloonCard({
  balloon,
  rtpBp,
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
  afterRoundShown,
}: BalloonCardProps) {
  const slot = balloon.index + 1;
  // Only a real gain is celebrated, judged over the whole round: never a
  // round that paid back no more than its bets and Patches.
  const win = balloon.status === 'cashed' && roundWin !== null ? roundWin : undefined;
  // The art plays the win once; the label keeps its win colour.
  const artWin = winShown ? undefined : win;
  // Where it would have popped: only once the round is over and still.
  const after = afterRoundShown ? afterRoundLine(balloon) : null;

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
          scale={cardScale(balloon)}
          beat={balloonBeat(balloon, beat, pending)}
          // How tense its next pump is within this balloon's own range of
          // pop chances; the game's press length reads the same number.
          strain={balloonTension({ rtpBp, ladder }, balloon)}
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
      <SlotAction
        slot={slot}
        show={canPump}
        after={after}
        onPump={onPump}
        onPumpHold={onPumpHold}
      />
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
