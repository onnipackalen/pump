import { cashOutCents, GAME_CONFIG, topRungForBet } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import type { RoundView } from '../src/api/contract';
import { DemoClient } from '../src/demo/DemoClient';
import { nextPumpGainCents } from '../src/game/patchGain';
import { balloon, configWith, MADE_LONG } from './fixtures';

let keys = 0;
const key = (): string => `patch-gain-${String((keys += 1))}`;

describe('what the next pump adds, shown on Patch + Pump', () => {
  it('is the next rung paid minus the rung now, rounded down, for odd bets too', () => {
    // Bets where rounding down to the cent matters, and the largest bet.
    const bets = [10, 11, 13, 99, 101, 123, 1234, 99_999, GAME_CONFIG.limits.maxBetCents];
    for (const difficulty of GAME_CONFIG.difficulties) {
      const ladder = difficulty.ladder;
      for (const betCents of bets) {
        const top = topRungForBet(ladder, betCents, GAME_CONFIG.limits.maxPayoutCents);
        for (let rung = 1; rung < top; rung += 1) {
          const now = cashOutCents(betCents, ladder, rung);
          const view = balloon({
            betCents,
            rung,
            topRung: top,
            cashOutCents: now,
            multiplierHundredths: ladder[rung - 1] ?? null,
            next: {
              popChance: { num: 1, den: 2 },
              multiplierHundredths: ladder[rung] ?? 0,
              patchPriceCents: 1,
            },
          });
          expect(nextPumpGainCents(view)).toBe(cashOutCents(betCents, ladder, rung + 1) - now);
        }
      }
    }
  });

  it('matches what a pump that holds really adds in a played round', async () => {
    const client = new DemoClient(configWith(MADE_LONG), 0);
    await client.setClientSeed('patch-gain-test', key());
    let checked = 0;
    // 40 rounds on the configured difficulties in turn. If their ladders are
    // too short to give enough held pumps, the long made ladder adds more.
    for (let n = 0; n < 80 && checked < 30; n += 1) {
      const difficulty =
        n < 40 ? GAME_CONFIG.difficulties[n % GAME_CONFIG.difficulties.length] : MADE_LONG;
      if (!difficulty) continue;
      let { round }: { round: RoundView } = await client.startRound(
        { difficultyId: difficulty.id, betsCents: [137] },
        key(),
      );
      while (round.status === 'active') {
        const before = round.balloons[0];
        if (!before || before.status !== 'active') break;
        const gain = nextPumpGainCents(before);
        ({ round } = await client.pump(
          round.id,
          { balloonIndex: 0, expectedDrawIndex: before.drawIndex, patch: false },
          key(),
        ));
        const after = round.balloons[0];
        if (gain === null || !after || after.rung !== before.rung + 1) continue;
        // Held: the new value is the old one plus the gain shown. On the top
        // rung the balloon cashes out by itself, so read what it was paid.
        const paid = after.status === 'cashed' ? after.payoutCents : after.cashOutCents;
        expect(paid).toBe((before.cashOutCents ?? 0) + gain);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('is null before the first pump and once the balloon is over', () => {
    expect(nextPumpGainCents(balloon())).toBeNull();
    expect(nextPumpGainCents(balloon({ status: 'popped', rung: 2, cashOutCents: null }))).toBeNull();
  });
});
