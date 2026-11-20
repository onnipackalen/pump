import { describe, expect, it } from 'vitest';
import type { BalloonAction } from '../src/api/contract';
import { actionsToText, textToActions } from '../src/verify/actionsText';

const actions: BalloonAction[] = [
  { kind: 'pump', patch: false },
  { kind: 'pump', patch: true },
  { kind: 'pump', patch: false },
  { kind: 'cashOut' },
];

describe('balloon actions as text', () => {
  it('writes P, P+ and C', () => {
    expect(actionsToText(actions)).toBe('P P+ P C');
    expect(actionsToText([])).toBe('');
  });

  it('reads them back exactly, with any spacing, commas or case', () => {
    expect(textToActions('P P+ P C')).toEqual({ actions });
    expect(textToActions('  p,p+  p ,c ')).toEqual({ actions });
    expect(textToActions('')).toEqual({ actions: [] });
  });

  it('names the first step it cannot read', () => {
    expect(textToActions('P X C')).toEqual({ error: '"X" is not a step. Use P, P+ or C.' });
  });
});
