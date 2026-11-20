import type { BalloonView } from '../api/contract';
import { Balloon, balloonScale } from '../balloon/Balloon';
import type { Beat } from '../game/useGame';
import { multiplierAt } from '../game/rules';
import { formatCents, formatChance, formatMultiplier, formatSignedCents } from '../money';

interface BalloonCardProps {
  readonly balloon: BalloonView;
  readonly ladder: readonly number[];
  readonly beat: Beat;
  readonly pending: boolean;
  /** Buttons are off while auto-play is running. */
  readonly locked: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onPump: () => void;
  readonly onPatchPump: () => void;
  readonly onCashOut: () => void;
}

function svgBeat(beat: Beat): 'press' | 'survive' | undefined {
  if (beat === 'press') return 'press';
  if (beat === 'survived' || beat === 'saved') return 'survive';
  return undefined;
}

function statusText(balloon: BalloonView, beat: Beat): string {
  if (beat === 'press') return 'Pumping…';
  if (balloon.status === 'popped') return 'Popped';
  if (balloon.status === 'refunded') return 'Refunded';
  if (balloon.status === 'cashed') {
    return beat === 'top' ? 'Top reached: cashed out' : 'Cashed out';
  }
  if (beat === 'saved') return 'The Patch saved it';
  if (balloon.rung === 0) return 'Pump to start';
  return 'Pump again or cash out';
}

/** One balloon in a round: its picture, its numbers and its buttons. */
export function BalloonCard({
  balloon,
  ladder,
  beat,
  pending,
  locked,
  selected,
  onSelect,
  onPump,
  onPatchPump,
  onCashOut,
}: BalloonCardProps) {
  const slot = balloon.index + 1;
  const isActive = balloon.status === 'active';
  const topMultiplier = multiplierAt(ladder, balloon.topRung);
  const capped = balloon.topRung < ladder.length;
  const next = balloon.next;
  const patchPrice = next?.patchPriceCents ?? null;
  const spent = balloon.betCents + balloon.patchesCents;
  // Only a real gain is celebrated: never a payout at or under what was spent.
  const won = balloon.status === 'cashed' && balloon.payoutCents > spent;
  const busy = pending || locked;

  return (
    <article
      className="card balloon-card"
      data-selected={selected && isActive}
      data-status={balloon.status}
      onClick={onSelect}
      aria-label={`Balloon ${slot}`}
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

      {/* Quiet during auto-play, which changes it several times a second. */}
      <p className="balloon-status" aria-live={locked ? 'off' : 'polite'}>
        {statusText(balloon, beat)}
      </p>

      {isActive ? (
        <dl className="stats">
          <div>
            <dt>Multiplier</dt>
            <dd className="big">
              {balloon.multiplierHundredths === null
                ? '—'
                : formatMultiplier(balloon.multiplierHundredths)}
            </dd>
          </div>
          <div>
            <dt>Cash out</dt>
            <dd className="big">
              {balloon.cashOutCents === null ? '—' : formatCents(balloon.cashOutCents)}
            </dd>
          </div>
          <div>
            <dt title="The chance that the next pump pops this balloon">Pop chance</dt>
            <dd className="risk">{next ? formatChance(next.popChance) : '—'}</dd>
          </div>
          <div>
            <dt>Patch</dt>
            <dd>{patchPrice === null ? 'after pump 1' : formatCents(patchPrice)}</dd>
          </div>
          <div className="wide">
            <dt>Rung</dt>
            <dd>
              {balloon.rung} of {balloon.topRung}
              {next ? ` · next ${formatMultiplier(next.multiplierHundredths)}` : ''}
              {capped ? ' · capped' : ''}
            </dd>
          </div>
        </dl>
      ) : (
        <dl className="stats">
          <div>
            <dt>Bet</dt>
            <dd>{formatCents(balloon.betCents)}</dd>
          </div>
          <div>
            <dt>Paid</dt>
            <dd className={won ? 'big win' : 'big'}>{formatCents(balloon.payoutCents)}</dd>
          </div>
          {balloon.patchesCents > 0 && (
            <div>
              <dt>Patches</dt>
              <dd>{formatCents(balloon.patchesCents)}</dd>
            </div>
          )}
          <div>
            <dt>Net</dt>
            <dd className={won ? 'win' : 'muted'}>
              {formatSignedCents(balloon.payoutCents - spent)}
            </dd>
          </div>
        </dl>
      )}

      {isActive && (
        <div className="actions">
          <button type="button" className="btn btn-pump" disabled={busy} onClick={onPump}>
            Pump
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || patchPrice === null}
            onClick={onPatchPump}
            title="Buy a Patch for this pump, then pump. If it would pop, the Patch is used up and the balloon stays."
          >
            Patch + Pump{patchPrice === null ? '' : ` ${formatCents(patchPrice)}`}
          </button>
          <button
            type="button"
            className="btn btn-cash"
            disabled={busy || balloon.cashOutCents === null}
            onClick={onCashOut}
          >
            Cash out{balloon.cashOutCents === null ? '' : ` ${formatCents(balloon.cashOutCents)}`}
          </button>
        </div>
      )}
    </article>
  );
}

interface PreviewCardProps {
  readonly slot: number;
}

/** A balloon before the round starts. */
export function PreviewCard({ slot }: PreviewCardProps) {
  return (
    <article className="card balloon-card" data-status="preview" aria-label={`Balloon ${slot}`}>
      <div className="balloon-box">
        <Balloon slot={slot} scale={0.45} />
      </div>
      <p className="balloon-status">Set a bet and start</p>
    </article>
  );
}
