import { describe, expect, it } from 'vitest';
import { balloonBeat } from '../src/components/BalloonCard';
import { balloon } from './fixtures';

describe('balloonBeat', () => {
  it('plays each live result once', () => {
    expect(balloonBeat(balloon(), 'press')).toBe('press');
    expect(balloonBeat(balloon({ rung: 1 }), 'survived')).toBe('survive');
    expect(balloonBeat(balloon({ status: 'popped' }), 'popped')).toBe('pop');
    expect(balloonBeat(balloon({ status: 'cashed' }), 'cashed')).toBe('cashout');
    expect(balloonBeat(balloon({ status: 'cashed' }), 'top')).toBe('cashout');
  });

  it('never grows a balloon the Patch saved', () => {
    expect(balloonBeat(balloon({ rung: 2 }), 'saved')).toBe('blocked');
  });

  it('shows only the end picture for a balloon restored after a refresh', () => {
    expect(balloonBeat(balloon({ status: 'popped' }), 'idle')).toBe('popped');
    expect(balloonBeat(balloon({ status: 'cashed' }), 'idle')).toBe('cashed');
    expect(balloonBeat(balloon(), 'idle')).toBeUndefined();
  });
});
