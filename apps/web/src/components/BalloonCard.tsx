import type { CSSProperties } from 'react';
import type { BalloonView } from '../api/contract';
import { Balloon, balloonScale } from '../balloon/Balloon';
import type { Beat } from '../game/useGame';
import { multiplierAt } from '../game/rules';
import { formatCents, formatMultiplier } from '../money';

interface BalloonCardProps {
  readonly balloon: BalloonView;
  readonly ladder: readonly number[];
  readonly beat: Beat;
  /** The round has more than one balloon and the player may pick this one. */
  readonly selectable: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

function svgBeat(beat: Beat): 'press' | 'survive' | undefined {
  if (beat === 'press') return 'press';
  if (beat === 'survived' || beat === 'saved') return 'survive';
  return undefined;
}

/** The big line under a balloon: its multiplier, or how it ended. */
function mainText(balloon: BalloonView): string {
  if (balloon.status === 'popped') return 'Popped';
  if (balloon.status === 'refunded') return 'Refunded';
  if (balloon.multiplierHundredths === null) return '—';
  return formatMultiplier(balloon.multiplierHundredths);
}

/** The small line under it: the money that goes with the big line. */
function subText(balloon: BalloonView, beat: Beat): string {
  switch (balloon.status) {
    case 'popped':
      return formatCents(-(balloon.betCents + balloon.patchesCents));
    case 'refunded':
      return formatCents(balloon.betCents);
    case 'cashed':
      return `Paid ${formatCents(balloon.payoutCents)}`;
    case 'active':
      if (beat === 'saved') return 'Patch saved it';
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
  selectable,
  selected,
  onSelect,
}: BalloonCardProps) {
  const slot = balloon.index + 1;
  const topMultiplier = multiplierAt(ladder, balloon.topRung);
  const spent = balloon.betCents + balloon.patchesCents;
  // Only a real gain is celebrated: never a payout at or under what was spent.
  const won = balloon.status === 'cashed' && balloon.payoutCents > spent;

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
          beat={svgBeat(beat)}
          end={
            balloon.status === 'popped' ? 'popped' : balloon.status === 'cashed' ? 'cashed' : undefined
          }
        />
      </div>
      <SlotLabel main={mainText(balloon)} sub={subText(balloon, beat)} won={won} live />
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
