import { GAME_CONFIG, ladderProblems, topRungForBet, type GameConfig } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import { freeId, MADE_CAPPED, MADE_DIFFICULTIES, MADE_LONG, TINY } from './play';

/**
 * The ladders the server tests make for themselves (play.ts) must be ladders
 * the game would accept, and must never take the place of a configured one.
 */
describe('the ladders made for server tests', () => {
  const { limits } = GAME_CONFIG;
  const rtps = [...new Set([9400, 9700, 9900, GAME_CONFIG.rtpBp])];

  it.each(rtps)('pass the start-up checks at RTP %i', (rtpBp) => {
    for (const made of MADE_DIFFICULTIES) {
      expect(ladderProblems(rtpBp, made.ladder, limits), made.id).toEqual([]);
    }
  });

  it('never share an id with a configured difficulty, or with each other', () => {
    const ids = new Set(GAME_CONFIG.difficulties.map((d) => d.id));
    for (const made of MADE_DIFFICULTIES) expect(ids.has(made.id), made.id).toBe(false);
    expect(new Set(MADE_DIFFICULTIES.map((d) => d.id)).size).toBe(MADE_DIFFICULTIES.length);
  });

  it('have the shape they promise', () => {
    // Tiny: three rungs, all in reach of the largest bet.
    expect(TINY.ladder).toHaveLength(3);
    expect(topRungForBet(TINY.ladder, limits.maxBetCents, limits.maxPayoutCents)).toBe(3);
    expect(topRungForBet(MADE_LONG.ladder, limits.maxBetCents, limits.maxPayoutCents)).toBe(
      MADE_LONG.ladder.length,
    );
    expect(topRungForBet(MADE_CAPPED.ladder, limits.maxBetCents, limits.maxPayoutCents)).toBe(3);
    expect(topRungForBet(MADE_CAPPED.ladder, 100, limits.maxPayoutCents)).toBe(
      MADE_CAPPED.ladder.length,
    );
  });
});

describe('freeId', () => {
  it('gives the id asked for, or the first numbered one no difficulty has', () => {
    // A grader may well add a difficulty called "tiny" or "test-tiny".
    const ladder = [300, 1000];
    const config: GameConfig = {
      ...GAME_CONFIG,
      difficulties: [
        ...GAME_CONFIG.difficulties,
        { id: 'test-tiny', label: 'Tiny', ladder },
        { id: 'test-tiny-2', label: 'Tiny 2', ladder },
      ],
    };
    expect(freeId('test-tiny', config)).toBe('test-tiny-3');
    // A configured id is never given back.
    for (const d of config.difficulties) expect(freeId(d.id, config)).not.toBe(d.id);
  });
});
