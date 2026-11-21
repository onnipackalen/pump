import { describe, expect, it } from 'vitest';
import { balloonBeat, balloonPatch, subText } from '../src/components/BalloonCard';
import { busyAfter, shouldSettle } from '../src/game/useGame';
import { balloon, round } from './fixtures';

describe('shouldSettle', () => {
  const r = round([balloon({ rung: 2, drawIndex: 2 }), balloon()]);

  it('settles the beat it was set for', () => {
    expect(shouldSettle({ round: r, beats: ['survived', 'idle'] }, 'round-1', 0, 'survived', 2)).toBe(
      true,
    );
  });

  it('leaves a newer pump that ended the same way alone (more draws since)', () => {
    const newer = round([balloon({ rung: 3, drawIndex: 3 }), balloon()]);
    expect(
      shouldSettle({ round: newer, beats: ['survived', 'idle'] }, 'round-1', 0, 'survived', 2),
    ).toBe(false);
  });

  it('leaves a balloon whose beat has moved on, or another round, alone', () => {
    expect(shouldSettle({ round: r, beats: ['press', 'idle'] }, 'round-1', 0, 'survived', 2)).toBe(
      false,
    );
    expect(shouldSettle({ round: r, beats: ['survived', 'idle'] }, 'round-2', 0, 'survived', 2)).toBe(
      false,
    );
  });
});

describe('busyAfter', () => {
  it('keeps only a Patch save busy, so its motion is never cut by the next press', () => {
    expect(busyAfter('saved')).toBe(true);
    expect(busyAfter('survived')).toBe(false);
    expect(busyAfter('popped')).toBe(false);
    expect(busyAfter('top')).toBe(false);
  });
});

describe('balloonBeat with a request on its way', () => {
  it('keeps a balloon in play until its own answer starts its motion', () => {
    // Another balloon's answer already shows this one cashed out.
    expect(balloonBeat(balloon({ status: 'cashed' }), 'idle', true)).toBeUndefined();
    expect(balloonBeat(balloon({ status: 'cashed' }), 'cashed', true)).toBe('cashout');
  });
});

describe('balloonPatch', () => {
  it('peels a Patch that was not needed, the pump that reached the top included', () => {
    expect(balloonPatch('survived', true)).toBe('spent');
    expect(balloonPatch('top', true)).toBe('spent');
    expect(balloonPatch('saved', true)).toBe('torn');
    expect(balloonPatch('idle', true)).toBeUndefined();
  });
});

describe('subText', () => {
  const b = balloon({ rung: 2, cashOutCents: 121 });

  it('still says the Patch stopped a pop after the motion has settled', () => {
    expect(subText(b, 'idle', true, 'saved')).toBe('Patch stopped a pop');
  });

  it('says a Patch was not needed, and nothing about Patches after a plain pump', () => {
    expect(subText(b, 'idle', true, 'survived')).toBe('Patch not needed');
    expect(subText(b, 'idle', false, 'survived')).toBe('$1.21');
  });
});
