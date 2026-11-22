import { GAME_CONFIG, ladderProblems, topRungForBet, type Difficulty } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import {
  BASE,
  cappedDifficulty,
  difficultyWithRungs,
  MADE_CAPPED,
  MADE_DIFFICULTIES,
  MADE_LONG,
  surestStart,
} from './fixtures';

/** The ladders the tests make for themselves must be ladders the game would accept. */
describe('the ladders made for tests', () => {
  const { limits } = GAME_CONFIG;
  const rtps = [...new Set([9400, 9700, 9900, GAME_CONFIG.rtpBp])];

  it.each(rtps)('pass the start-up checks at RTP %i', (rtpBp) => {
    for (const made of MADE_DIFFICULTIES) {
      expect(ladderProblems(rtpBp, made.ladder, limits), made.id).toEqual([]);
    }
  });

  it('never share an id with a configured difficulty', () => {
    const ids = new Set(GAME_CONFIG.difficulties.map((d) => d.id));
    for (const made of MADE_DIFFICULTIES) expect(ids.has(made.id), made.id).toBe(false);
  });

  it('have the shape they promise', () => {
    expect(topRungForBet(MADE_LONG.ladder, limits.maxBetCents, limits.maxPayoutCents)).toBe(
      MADE_LONG.ladder.length,
    );
    expect(topRungForBet(MADE_CAPPED.ladder, limits.maxBetCents, limits.maxPayoutCents)).toBe(3);
    expect(topRungForBet(MADE_CAPPED.ladder, 100, limits.maxPayoutCents)).toBe(
      MADE_CAPPED.ladder.length,
    );
  });

  it('give a test what it asks for, from the config when it can', () => {
    expect(BASE.ladder.length).toBeGreaterThanOrEqual(10);
    for (const rungs of [1, 2, 3, 5, 10, 24]) {
      const got = difficultyWithRungs(rungs);
      expect(got.ladder.length).toBeGreaterThanOrEqual(rungs);
      const configured = GAME_CONFIG.difficulties.find(
        (d) => d.ladder.length >= rungs && topRungForBet(d.ladder, 100, limits.maxPayoutCents) === d.ladder.length,
      );
      expect(got).toBe(configured ?? MADE_LONG);
    }
    const capped = cappedDifficulty();
    expect(topRungForBet(capped.ladder, limits.maxBetCents, limits.maxPayoutCents)).toBeLessThan(
      capped.ladder.length,
    );
    expect(topRungForBet(capped.ladder, 100, limits.maxPayoutCents)).toBe(capped.ladder.length);
  });

  it('give a test that needs pump 1 to hold a ladder where it holds at least half the time', () => {
    // A legal ladder starting at 20x: pump 1 holds under 5% of the time.
    const steep: Difficulty = { id: 'made-steep', label: 'Made steep', ladder: [2000, 50_000, 1_500_000] };
    for (const rtpBp of rtps) {
      expect(ladderProblems(rtpBp, steep.ladder, limits)).toEqual([]);
      // The config, the config with the steep one first, and the steep one alone.
      for (const list of [GAME_CONFIG.difficulties, [steep, ...GAME_CONFIG.difficulties], [steep]]) {
        const got = surestStart(rtpBp, () => true, list);
        expect(got).not.toBe(steep);
        // R / m_1 >= 1/2.
        expect(2 * rtpBp).toBeGreaterThanOrEqual(100 * (got.ladder[0] ?? Infinity));
        // From the list when one there will do.
        const fits = list.some((d) => 2 * rtpBp >= 100 * (d.ladder[0] ?? Infinity));
        expect(got === MADE_LONG).toBe(!fits);
      }
    }
  });
});
