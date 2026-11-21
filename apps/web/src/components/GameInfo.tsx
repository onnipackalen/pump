import type { GameConfig } from '@pump/engine';
import { MAX_AUTO_ROUNDS } from '../game/autoPlay';
import { formatCents, formatChance } from '../money';

interface GameInfoProps {
  readonly config: GameConfig;
  /** Whether this market offers auto-play. */
  readonly autoPlay: boolean;
  /** Whether auto-play may change the bets after a win or a loss here. */
  readonly autoBetSizing: boolean;
}

/**
 * The rules, limits and keys, in settings. This is where the sentences
 * live, so the game screen needs none. Every number is read from config.
 */
export function GameInfo({ config, autoPlay, autoBetSizing }: GameInfoProps) {
  const { limits } = config;
  return (
    <details className="card panel info">
      <summary>Game info</summary>

      <dl className="facts">
        <dt>Return to player</dt>
        <dd>{formatChance({ num: config.rtpBp, den: 10_000 })}</dd>
        <dt>Bet per balloon</dt>
        <dd>
          {formatCents(limits.minBetCents)} to {formatCents(limits.maxBetCents)}
        </dd>
        <dt>Balloons per round</dt>
        <dd>1 to {limits.maxBalloons}</dd>
        <dt>Max payout per balloon</dt>
        <dd>{formatCents(limits.maxPayoutCents)}</dd>
      </dl>

      <ul className="rules">
        <li>Each pump raises the multiplier or pops the balloon. A pop loses that bet.</li>
        <li>The pop chance of the next pump is always shown, and it rises with every pump.</li>
        <li>Cash out any time after the first pump.</li>
        <li>
          A Patch covers one pump. If that pump would pop, the balloon stays. The Patch is used up
          either way.
        </li>
        <li>
          A Patch is paid on top of the bet, so the bet limits above do not cap it. Its price rises
          with every pump and late on can be many times the bet. The price is on the button before
          you buy.
        </li>
        <li>
          A bet that could pay more than the max payout has a lower top. The top is shown before
          you bet, and reaching it cashes out by itself.
        </li>
        {autoPlay && (
          <li>
            Auto-play uses your bets, pumps each balloon the set number of times, then cashes it
            out. You can still cash out a balloon yourself while it runs. It buys no Patches and
            never starts a round that could take you past your loss limit. Up to {MAX_AUTO_ROUNDS}{' '}
            rounds. Stopping mid-round leaves the balloons for you to finish.
          </li>
        )}
        {autoPlay && autoBetSizing && (
          <li>
            After a round that pays more than it cost, auto-play does what On win says; after any
            other round, what On loss says. Reset goes back to the bets you entered. Increase
            raises every bet by that percent, rounded down to the cent and kept between{' '}
            {formatCents(limits.minBetCents)} and {formatCents(limits.maxBetCents)}. The next
            round&apos;s bets count toward your loss limit before it starts.
          </li>
        )}
      </ul>

      <ul className="rules keys">
        <li>
          <kbd>Space</kbd> pump · <kbd>Shift</kbd>+<kbd>P</kbd> patch + pump · <kbd>C</kbd> cash
          out ·{' '}
          <kbd>A</kbd> pump all
        </li>
        <li>Hold Space, A or a Pump button to keep pumping</li>
        <li>
          <kbd>1</kbd>–<kbd>3</kbd> pick a balloon · <kbd>Enter</kbd> bet · <kbd>M</kbd> sound
          {autoPlay && (
            <>
              {' '}
              · <kbd>Esc</kbd> stop auto-play
            </>
          )}
        </li>
      </ul>
    </details>
  );
}
