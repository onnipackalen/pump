import { readFileSync } from 'node:fs';
import { GAME_CONFIG } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import { setUpFrom } from '../src/game/setUp';
import { stageRound } from '../src/game/stage';
import { balloon, round } from './fixtures';

/**
 * The stage follows the bet panel: once a round is over, picking another
 * number of balloons or another difficulty shows the next round's set-up
 * at once (game/stage.ts). There is no DOM in these tests, so the screen
 * itself is checked by reading App.tsx for the wiring.
 */

const ids = GAME_CONFIG.difficulties.map((d) => d.id);
const counts = Array.from({ length: GAME_CONFIG.limits.maxBalloons }, (_, i) => i + 1);
const played = ids[0] ?? '';

/** A round of `count` balloons on `difficultyId`, in play or over. */
function roundOf(count: number, difficultyId: string, over: boolean) {
  const status = over ? 'popped' : 'active';
  return round(
    Array.from({ length: count }, () => balloon({ status, rung: 1 })),
    { difficultyId },
  );
}

describe('what the stage shows', () => {
  it('shows the set-up before any round, for every pick', () => {
    for (const id of [...ids, undefined]) {
      for (const count of counts) expect(stageRound(null, id, count)).toBeNull();
    }
  });

  it('keeps a round in play on the stage, whatever the bet panel says', () => {
    for (const count of counts) {
      const live = roundOf(count, played, false);
      expect(live.status).toBe('active');
      for (const id of ids) {
        for (const picked of counts) expect(stageRound(live, id, picked)).toBe(live);
      }
    }
  });

  it('keeps a round that is over while the same balloons and difficulty are picked', () => {
    for (const id of ids) {
      for (const count of counts) {
        const over = roundOf(count, id, true);
        expect(over.status).toBe('finished');
        expect(stageRound(over, id, count)).toBe(over);
      }
    }
  });

  it('swaps a round that is over for the set-up as soon as another number of balloons is picked', () => {
    for (const count of counts) {
      const over = roundOf(count, played, true);
      for (const picked of counts) {
        expect(stageRound(over, played, picked)).toBe(picked === count ? over : null);
      }
    }
  });

  it('swaps a round that is over for the set-up as soon as another difficulty is picked', () => {
    for (const id of ids) {
      const over = roundOf(1, id, true);
      for (const picked of ids) {
        expect(stageRound(over, picked, 1)).toBe(picked === id ? over : null);
      }
    }
  });

  it('sets up the next round from empty pumps when the set-up was on the stage', () => {
    // The stage hands useSetUpFrom null while it shows the set-up, so the
    // next round's balloons go on pumps with their hoses on the floor, not
    // on the balloons of the round before, which were no longer shown.
    const next = roundOf(3, played, false);
    expect(setUpFrom(null, next, true)).toEqual(['idle', 'idle', 'idle']);
  });
});

describe('the game screen', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

  it('works out the stage from the round and the bet panel picks', () => {
    expect(app).toMatch(
      /const stage = stageRound\(round, setupDifficulty\?\.id, setup\.bets\.length\);/,
    );
  });

  it('draws the stage round, or one set-up card per bet in the panel', () => {
    expect(app).toMatch(/\{stage\s*\?\s*stage\.balloons\.map\(/);
    expect(app).toMatch(/:\s*setup\.bets\.map\(\(text, index\) => \(\s*<PreviewCard\b/);
  });

  it('gives each balloon its own round\'s difficulty and ladder', () => {
    const card = /<BalloonCard\b[\s\S]*?\/>/.exec(app)?.[0] ?? '';
    expect(card).toMatch(/difficultyId=\{stage\.difficultyId\}/);
    expect(card).toMatch(/ladder=\{stage\.ladder\}/);
  });

  it('sets up from what the stage showed, and shows the net only with the round', () => {
    expect(app).toMatch(/useSetUpFrom\(stage, state\.phase !== 'loading' && stage === null,/);
    expect(app).toMatch(/\{stage\?\.status === 'finished' && <RoundResult round=\{stage\} \/>\}/);
  });
});
