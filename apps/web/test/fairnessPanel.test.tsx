import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FairnessView } from '../src/api/contract';
import { FairnessPanel, notSavedText } from '../src/components/FairnessPanel';

const FAIRNESS: FairnessView = { serverSeedHash: 'e'.repeat(64), clientSeed: 'player-seed', nextNonce: 3 };

function panel(locked: boolean, changing: boolean): string {
  return renderToStaticMarkup(
    <FairnessPanel
      fairness={FAIRNESS}
      revealed={[]}
      locked={locked}
      changing={changing}
      onSaveClientSeed={() => Promise.resolve(true)}
      onRotate={() => undefined}
    />,
  );
}

/** The buttons' text, each with whether it is disabled. */
function buttons(html: string): string[] {
  return [...html.matchAll(/<button([^>]*)>([^<]+)<\/button>/g)].map(
    ([, attributes, text]) => `${text ?? ''}${attributes?.includes('disabled') ? ' (off)' : ''}`,
  );
}

describe('the Provably fair panel while a seed change is on its way', () => {
  it('Save and Rotate wait, and nothing says the seeds are locked for a round', () => {
    const html = panel(false, true);
    expect(buttons(html)).toEqual(['Save (off)', 'Rotate server seed (off)']);
    expect(html).not.toContain('Seeds are locked');
    expect(buttons(panel(false, false))).toEqual(['Save (off)', 'Rotate server seed']);
  });

  it('after a save that did not go through, says which seed is still in use', () => {
    expect(notSavedText('player-seed')).toBe('Not saved. Rounds still use “player-seed”.');
    expect(notSavedText('')).toBe('Not saved.');
  });
});
