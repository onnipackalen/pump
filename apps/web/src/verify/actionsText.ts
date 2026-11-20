/**
 * A balloon's actions as short text, so a player can read and edit them:
 *   P   pump
 *   P+  Patch + Pump
 *   C   cash out
 * separated by spaces, for example "P P P+ P C".
 */

import type { BalloonAction } from '../api/contract';

export function actionsToText(actions: readonly BalloonAction[]): string {
  return actions
    .map((a) => (a.kind === 'cashOut' ? 'C' : a.patch ? 'P+' : 'P'))
    .join(' ');
}

/** Reads the text back. Returns the actions, or the first step it can't read. */
export function textToActions(
  text: string,
): { readonly actions: BalloonAction[] } | { readonly error: string } {
  const actions: BalloonAction[] = [];
  for (const token of text.trim().split(/[\s,]+/).filter((t) => t !== '')) {
    switch (token.toUpperCase()) {
      case 'P':
        actions.push({ kind: 'pump', patch: false });
        break;
      case 'P+':
        actions.push({ kind: 'pump', patch: true });
        break;
      case 'C':
        actions.push({ kind: 'cashOut' });
        break;
      default:
        return { error: `"${token}" is not a step. Use P, P+ or C.` };
    }
  }
  return { actions };
}
