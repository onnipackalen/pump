import type { PlayerSettings } from '@pump/contract';
import type { PlayersRepository } from '../repositories/players';
import type { PublicWinsService } from './publicWins';

/**
 * A player's own choices. For now there is one: whether their wins are kept
 * out of the lists everyone can see.
 *
 * It is the player's choice and nothing else: it moves no money and changes
 * nothing about any round.
 */
export type SettingsService = ReturnType<typeof settingsService>;

export function settingsService(players: PlayersRepository, publicWins: PublicWinsService) {
  const view = (playerId: string): PlayerSettings => ({
    winsPrivate: players.get(playerId).winsPrivate,
  });

  return {
    view,

    set(playerId: string, settings: PlayerSettings): PlayerSettings {
      players.setWinsPrivate(playerId, settings.winsPrivate);
      // Private means private now: the lists are reused for a few seconds,
      // so the player's wins are also taken out of the answer already made.
      if (settings.winsPrivate) publicWins.hide(playerId);
      return view(playerId);
    },
  };
}
