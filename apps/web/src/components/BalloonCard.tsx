import type { CSSProperties } from 'react';
import type { BalloonView } from '../api/contract';
import { Balloon, balloonScale, type BalloonBeat } from '../balloon/Balloon';
import type { Beat } from '../game/useGame';
import { multiplierAt } from '../game/rules';
import type { WinTier } from '../game/winTier';
import { formatCents, formatMultiplier } from '../money';

interface BalloonCardProps {
  readonly balloon: BalloonView;
  readonly ladder: readonly number[];
  readonly beat: Beat;
  /** Its last pump was bought with a Patch. */
  readonly patched: boolean;
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
}

/**
 * The balloon art's data-beat for this balloon. A live result plays its
 * motion once. With no live result (say, a round restored after a refresh),
 * a finished balloon shows only its end picture, so a pop or cash-out never
 * plays twice.
 */
export function balloonBeat(balloon: BalloonView, beat: Beat): BalloonBeat | undefined {
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

/** The big line under a balloon: its multiplier, or how it ended. */
function mainText(balloon: BalloonView): string {
  if (balloon.status === 'popped') return 'Popped';
  if (balloon.status === 'refunded') return 'Refunded';
  if (balloon.multiplierHundredths === null) return '—';
  return formatMultiplier(balloon.multiplierHundredths);
}

/**
 * The small line under it: the money that goes with the big line. A Patch is
 * shown as plain words, not an animation: "Patch on" while that pump is on
 * its way, then what it did.
 */
function subText(balloon: BalloonView, beat: Beat, patched: boolean): string {
  switch (balloon.status) {
    case 'popped':
      return formatCents(-(balloon.betCents + balloon.patchesCents));
    case 'refunded':
      return formatCents(balloon.betCents);
    case 'cashed':
      return `Paid ${formatCents(balloon.payoutCents)}`;
    case 'active':
      if (beat === 'press' && patched) return 'Patch on';
      if (beat === 'saved') return 'Patch used';
      if (beat === 'survived' && patched) return 'Patch not needed';
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
 * One balloon in a round: its picture and two lines of numbers. Its
 * buttons are in the control panel (RoundControls), which acts on the
 * balloon the player picked.
 */
export function BalloonCard({
  balloon,
  ladder,
  beat,
  patched,
  roundWin,
  quiet,
  selectable,
  selected,
  onSelect,
}: BalloonCardProps) {
  const slot = balloon.index + 1;
  const topMultiplier = multiplierAt(ladder, balloon.topRung);
  // Only a real gain is celebrated, judged over the whole round: never a
  // round that paid back no more than its bets and Patches.
  const win = balloon.status === 'cashed' && roundWin !== null ? roundWin : undefined;

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
          beat={balloonBeat(balloon, beat)}
          win={win}
          value={
            balloon.multiplierHundredths === null ? '' : formatMultiplier(balloon.multiplierHundredths)
          }
        />
      </div>
      <SlotLabel
        main={mainText(balloon)}
        sub={subText(balloon, beat, patched)}
        won={win !== undefined}
        live={!quiet}
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
    </article>
  );
}
