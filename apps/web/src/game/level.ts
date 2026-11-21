import { GAME_CONFIG, type Difficulty } from '@pump/engine';
import type { RoundView } from '../api/contract';
import type { BalloonLevel } from '../balloon/Balloon';

/**
 * Each difficulty's own colour. It shows as rings round the foot of every
 * pump (balloon art) and as a small dot on that difficulty's button in the
 * bet panel, so the player learns which colour is which and can tell the
 * level of a round at a glance.
 *
 * Display only: nothing here touches the math, and the engine never sees
 * it. Keyed by the difficulty's id in the engine config. A difficulty with
 * no colour here still draws, in LEVEL_FALLBACK, so adding a difficulty
 * needs no change here.
 *
 * The four stay clear of every colour that already means something on the
 * screen: the mint of a real win, the grey of a pop, the orange of a
 * warning, red, and the three balloon colours (pearl, azure, violet), which
 * tell balloons 1, 2 and 3 apart and sit on the same pump. All four reach
 * at least 3 to 1 against the pump's barrel. They also differ in lightness
 * (gold lightest, orchid darkest), and the number of rings says the level
 * too, so no player has to rely on colour alone.
 */
export const LEVEL_COLOURS: Readonly<Record<string, string>> = {
  easy: '#8ac157', // lime
  medium: '#74ddee', // aqua
  hard: '#d07ed5', // orchid
  expert: '#f6d156', // gold
};

/** For a difficulty with no colour of its own: the pump's own light grey. */
export const LEVEL_FALLBACK = '#c3c9d6';

/** The most rings the pump has room for. Later difficulties show this many. */
export const MAX_LEVEL_MARKS = 4;

/** A difficulty's colour, or the fallback. */
export function levelColour(difficultyId: string): string {
  return Object.hasOwn(LEVEL_COLOURS, difficultyId)
    ? (LEVEL_COLOURS[difficultyId] ?? LEVEL_FALLBACK)
    : LEVEL_FALLBACK;
}

/**
 * What the pump shows for a difficulty: its colour, and one ring for the
 * first difficulty in the list, two for the next, and so on up to
 * MAX_LEVEL_MARKS. A difficulty that is no longer in the list (a round
 * played on one since removed) gets no rings.
 */
export function levelOf(
  difficultyId: string,
  difficulties: readonly Difficulty[] = GAME_CONFIG.difficulties,
): BalloonLevel {
  const position = difficulties.findIndex((d) => d.id === difficultyId);
  return {
    id: difficultyId,
    colour: levelColour(difficultyId),
    marks: position < 0 ? 0 : Math.min(position + 1, MAX_LEVEL_MARKS),
  };
}

/**
 * Which difficulty the pumps of a round on the stage show. While the round
 * is in play: its own. Once it is over, its balloons stay on the stage
 * beside the bet panel, and that panel is now setting up the next round,
 * so the pumps show the difficulty picked there: picking another one
 * changes them at once, as it does before the first bet. With nothing
 * picked, the round's own.
 */
export function stageLevelId(
  round: Pick<RoundView, 'status' | 'difficultyId'>,
  pickedId: string | undefined,
): string {
  return round.status === 'finished' && pickedId !== undefined ? pickedId : round.difficultyId;
}
