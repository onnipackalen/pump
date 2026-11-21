import type { CSSProperties } from 'react';
import type { BalloonView, PumpOutcome } from '../api/contract';
import { Balloon, balloonSize, type BalloonBeat } from '../balloon/Balloon';
import { afterRoundWords, twoLineChars, type AfterRoundWords } from '../game/afterRound';
import type { Beat } from '../game/useGame';
import { levelOf } from '../game/level';
import { balloonTension } from '../game/risk';
import { balloonSetUp, firstPump, useFirstLift, type SetUpFrom } from '../game/setUp';
import { HoldButton } from './HoldButton';
import { StepRow } from './StepRow';
import type { WinTier } from '../game/winTier';
import { formatCents, formatMultiplier } from '../money';
import { topRungForBet } from '../game/rules';

interface BalloonCardProps {
  readonly balloon: BalloonView;
  /**
   * The difficulty its pump shows: its round's. A round that is over gives
   * way to the next round's set-up once another one is picked (game/stage.ts).
   */
  readonly difficultyId: string;
  /** The RTP and ladder its round was played with (its own copies). */
  readonly rtpBp: number;
  readonly ladder: readonly number[];
  readonly beat: Beat;
  /** How the balloon in this slot of the round before ended (game/setUp.ts). */
  readonly setUp?: SetUpFrom | undefined;
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
  /** Auto-play's target pump count while it runs: its step is marked. */
  readonly target?: number | null;
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
 *
 * Where a slot has no room for the row of steps, a balloon in play also
 * says here the step its next pump goes for (`next`): inside its button,
 * or alone when it has none.
 */
function SlotAction({
  slot,
  show,
  after = null,
  next = null,
  onPump,
  onPumpHold,
}: {
  readonly slot: number;
  readonly show: boolean;
  readonly after?: AfterRoundWords | null;
  /**
   * The multiplier this balloon's next pump goes for, like "1.28×", while
   * it is in play. Shown only in a slot with no room for the row of steps
   * (two or three balloons on an upright phone, see steps.css).
   */
  readonly next?: string | null;
  readonly onPump: () => void;
  readonly onPumpHold: () => void;
}) {
  const nextLine = next === null ? null : `next ${next}`;
  const nextStyle =
    nextLine === null ? undefined : ({ '--next-chars': nextLine.length } as CSSProperties);
  return (
    <div className="slot-action">
      {!show && nextLine !== null && (
        // Hidden from screen readers: the card's own short line (StepRow)
        // already says the next step.
        <p className="slot-next" style={nextStyle} aria-hidden="true">
          {nextLine}
        </p>
      )}
      {!show && after !== null && (
        // Both wordings are written; the CSS shows the short one only in a
        // slot too narrow for the full one. The full one is the title.
        <p
          className="slot-after"
          style={
            {
              '--after-full-chars': twoLineChars(after.full),
              '--after-short-chars': twoLineChars(after.short),
            } as CSSProperties
          }
          title={after.full}
        >
          <span className="after-full">{after.full}</span>
          <span className="after-short">{after.short}</span>
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
          // The label replaces the button's text for a screen reader, so
          // it carries the next step too.
          aria-label={next === null ? `Pump balloon ${slot}` : `Pump balloon ${slot}, next ${next}`}
          title={`Pump balloon ${slot}. Hold to keep pumping.`}
        >
          Pump
          {nextLine !== null && (
            <span className="slot-next" style={nextStyle}>
              {nextLine}
            </span>
          )}
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
  difficultyId,
  rtpBp,
  ladder,
  beat,
  setUp,
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
  target = null,
}: BalloonCardProps) {
  const slot = balloon.index + 1;
  // Its first pump's lift, only when this screen sees that pump hold.
  const lifting = useFirstLift(balloon.rung, beat);
  // Only a real gain is celebrated, judged over the whole round: never a
  // round that paid back no more than its bets and Patches.
  const win = balloon.status === 'cashed' && roundWin !== null ? roundWin : undefined;
  // The art plays the win once; the label keeps its win colour.
  const artWin = winShown ? undefined : win;
  // Where it would have popped: only once the round is over and still.
  const after = afterRoundShown ? afterRoundWords(balloon) : null;
  const main = mainText(balloon);
  const sub = subText(balloon, beat, patched, outcome);

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
      <StepRow
        slot={slot}
        ladder={ladder}
        rung={balloon.rung}
        topRung={balloon.topRung}
        status={balloon.status}
        target={target}
        mainChars={main.length}
      />
      <div className="balloon-box">
        <Balloon
          slot={slot}
          level={levelOf(difficultyId)}
          scale={cardScale(balloon)}
          beat={balloonBeat(balloon, beat, pending)}
          setUp={balloonSetUp(balloon, setUp)}
          first={firstPump(balloon, lifting)}
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
      <SlotLabel main={main} sub={sub} won={win !== undefined} live={!quiet} />
      <SlotAction
        slot={slot}
        show={canPump}
        after={after}
        // The server's own number for the next pump; none once it is over.
        next={
          balloon.status === 'active' && balloon.next
            ? formatMultiplier(balloon.next.multiplierHundredths)
            : null
        }
        onPump={onPump}
        onPumpHold={onPumpHold}
      />
    </article>
  );
}

interface PreviewCardProps {
  readonly slot: number;
  /** The chosen difficulty: the pump shows it before the bet too. */
  readonly difficultyId: string;
  /** The bet typed for this balloon, or null while it is not a valid amount. */
  readonly betCents: number | null;
  /** The chosen difficulty's ladder: the steps this balloon would climb. */
  readonly ladder: readonly number[];
  /** The most one balloon can pay: it sets the top this bet can reach. */
  readonly maxPayoutCents: number;
  /** Auto-play's target pump count, on the Auto tab: its step is marked. */
  readonly target?: number | null;
}

/**
 * A balloon before the round starts, with the bet that will ride on it. The
 * steps above that bet's top are shown as out of reach before the round
 * starts (the payout cap); with no valid bet yet, the whole ladder shows.
 * The pump shows the chosen difficulty's colour.
 */
export function PreviewCard({
  slot,
  difficultyId,
  betCents,
  ladder,
  maxPayoutCents,
  target = null,
}: PreviewCardProps) {
  const main = betCents === null ? '—' : formatCents(betCents);
  const topRung =
    betCents === null ? ladder.length : topRungForBet(ladder, betCents, maxPayoutCents);
  return (
    <article className="slot" data-status="preview" aria-label={`Balloon ${slot}`}>
      <StepRow
        slot={slot}
        ladder={ladder}
        rung={0}
        topRung={topRung}
        status="preview"
        target={target}
        mainChars={main.length}
      />
      <div className="balloon-box">
        {/* Before any bet: the pump with its hose on the floor, no balloon.
             The balloon goes on when the bet is placed. */}
        <Balloon slot={slot} level={levelOf(difficultyId)} scale={0.45} idle />
      </div>
      <SlotLabel main={main} sub="" />
      <SlotAction slot={slot} show={false} onPump={() => undefined} onPumpHold={() => undefined} />
    </article>
  );
}
