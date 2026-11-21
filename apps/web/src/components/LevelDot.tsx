import type { CSSProperties } from 'react';
import { levelColour } from '../game/level';

/**
 * A small dot in a difficulty's colour, on its button in the bet panel, so
 * the player learns which colour the pump shows for which level. The
 * button's own words name the level, so the dot is hidden from screen
 * readers.
 */
export function LevelDot({ difficultyId }: { readonly difficultyId: string }) {
  const style = { '--level-colour': levelColour(difficultyId) } as CSSProperties;
  return <span className="level-dot" data-level={difficultyId} style={style} aria-hidden="true" />;
}
