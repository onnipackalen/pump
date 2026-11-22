import { GAME_CONFIG } from '@pump/engine';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FairnessView, RoundSummary } from '../src/api/contract';
import { FairnessPanel, notSavedText, SAVE_UNSURE_TEXT, saveLine } from '../src/components/FairnessPanel';
import { VerifyPage } from '../src/components/VerifyPage';
import { DemoClient } from '../src/demo/DemoClient';

const FAIRNESS: FairnessView = { serverSeedHash: 'e'.repeat(64), clientSeed: 'player-seed', nextNonce: 3 };

function panel(locked: boolean, changing: boolean): string {
  return renderToStaticMarkup(
    <FairnessPanel
      fairness={FAIRNESS}
      revealed={[]}
      locked={locked}
      changing={changing}
      onSaveClientSeed={() => Promise.resolve('saved' as const)}
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

  it('after a save whose answer was lost, says only that it is not sure', () => {
    expect(saveLine('not-saved', 'player-seed')).toBe(notSavedText('player-seed'));
    expect(saveLine('unsure', 'player-seed')).toBe(SAVE_UNSURE_TEXT);
    expect(SAVE_UNSURE_TEXT).not.toContain('player-seed');
    expect(saveLine('saved', 'player-seed')).toBeNull();
    expect(saveLine(null, 'player-seed')).toBeNull();
  });
});

/** The verify page, with one finished round on the seed still in use. */
function verifyPage(canRotate: boolean, seedChanging: boolean): string {
  const round: RoundSummary = {
    id: 'round-1',
    difficultyId: GAME_CONFIG.difficulties[0]?.id ?? 'easy',
    balloonCount: 1,
    betCents: 100,
    patchesCents: 0,
    payoutCents: 0,
    refundedCents: 0,
    serverSeedHash: FAIRNESS.serverSeedHash,
    nonce: 0,
    finishedAt: '2026-11-22T10:00:00.000Z',
    seedRevealed: false,
  };
  return renderToStaticMarkup(
    <VerifyPage
      client={new DemoClient(GAME_CONFIG, 0)}
      config={GAME_CONFIG}
      rounds={[round]}
      initialRoundId={null}
      canRotate={canRotate}
      seedChanging={seedChanging}
      onRotate={() => undefined}
      onBack={() => undefined}
    />,
  );
}

describe('the verify page’s Rotate while a seed change is on its way', () => {
  it('waits, and says why', () => {
    const busy = verifyPage(true, true);
    expect(buttons(busy)).toContain('Rotate server seed (off)');
    expect(busy).toContain('A seed change is on its way.');
    expect(busy).not.toContain('Finish the round in play first.');
    expect(buttons(verifyPage(true, false))).toContain('Rotate server seed');
    expect(verifyPage(false, false)).toContain('Finish the round in play first.');
  });
});
