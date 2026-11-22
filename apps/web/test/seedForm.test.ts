import { GAME_CONFIG } from '@pump/engine';
import { describe, expect, it, vi } from 'vitest';
import { NetworkFailure } from '../src/api/client';
import type { FairnessView, SessionView } from '../src/api/contract';
import { ClientSeedForm, notSavedText, SAVE_UNSURE_TEXT } from '../src/components/FairnessPanel';
import { DemoClient } from '../src/demo/DemoClient';
import { useGame, type Game } from '../src/game/useGame';
import { mount } from './hookRunner';

// The real useGame and the real client seed box, run on a small stand-in for React's hooks.
vi.mock('react', () => import('./hookRunner'));

/*
 * The line under the client seed box after a save. It says which seed is
 * still in use only when the save surely did not go through. When the
 * answer was lost, the server may have saved it, so the line says only
 * that it is not sure.
 */

interface Element {
  readonly type: unknown;
  readonly props: Readonly<Record<string, unknown>>;
}

function isElement(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && 'props' in node && 'type' in node;
}

/** Every element in a drawn tree, depth first. */
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isElement(node)) return [];
  return [node, ...elements(node.props.children)];
}

/** The text inside a drawn tree. */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return isElement(node) ? textOf(node.props.children) : '';
}

/** The first element of this type; its handler `name`, called with `arg`. */
function fire(tree: unknown, type: string, name: string, arg: unknown): void {
  const found = elements(tree).find((e) => e.type === type);
  const handler = found?.props[name];
  if (typeof handler !== 'function') throw new Error(`no ${type} with ${name}`);
  (handler as (value: unknown) => void)(arg);
}

async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** An honest server on a line that drops: it saves the seed, then both answers are lost, and so is the reload. */
class SavesThenGoesOffline extends DemoClient {
  offline = false;
  override async setClientSeed(clientSeed: string, k: string): Promise<FairnessView> {
    const answer = await super.setClientSeed(clientSeed, k);
    if (this.offline) throw new NetworkFailure('Could not reach the game server. Check your connection.');
    return answer;
  }
  override async getSession(): Promise<SessionView> {
    if (this.offline) throw new NetworkFailure('Could not reach the game server. Check your connection.');
    return super.getSession();
  }
}

/** The box, drawn with the game's own save. */
function openBox(game: { readonly current: () => Game }, saved: string) {
  return mount(() =>
    ClientSeedForm({
      saved,
      locked: false,
      changing: false,
      onSave: (clientSeed) => game.current().saveClientSeed(clientSeed),
    }),
  );
}

/** Types a seed into the box and presses Save. */
async function typeAndSave(box: { readonly current: () => unknown }, seed: string): Promise<void> {
  fire(box.current(), 'input', 'onChange', { target: { value: seed } });
  await Promise.resolve();
  fire(box.current(), 'form', 'onSubmit', { preventDefault: () => undefined });
}

describe('the client seed box after a save', () => {
  it('whose answer was lost says it is not sure, never that the old seed is still in use', async () => {
    const server = new SavesThenGoesOffline(GAME_CONFIG, 5);
    const game = mount(() => useGame(server));
    await until(() => game.current().state.phase === 'ready');
    const old = game.current().state.fairness?.clientSeed ?? '';
    const box = openBox(game, old);

    server.offline = true;
    await typeAndSave(box, 'my-new-seed');
    await until(() => textOf(box.current()).includes(SAVE_UNSURE_TEXT));
    expect(textOf(box.current())).not.toContain(notSavedText(old));
    // The server did save it.
    server.offline = false;
    expect((await server.getSession()).fairness.clientSeed).toBe('my-new-seed');
  }, 30_000);

  it('that was not sent says the old seed is still in use', async () => {
    const server = new DemoClient(GAME_CONFIG, 60);
    const game = mount(() => useGame(server));
    await until(() => game.current().state.phase === 'ready');
    const old = game.current().state.fairness?.clientSeed ?? '';
    const box = openBox(game, old);

    // A rotate is on its way, so the save is not sent.
    game.current().rotateSeed();
    await until(() => game.current().state.seedChanging);
    await typeAndSave(box, 'my-new-seed');
    await until(() => textOf(box.current()).includes(notSavedText(old)));
    await until(() => !game.current().state.seedChanging);
    expect((await server.getSession()).fairness.clientSeed).toBe(old);
  }, 30_000);
});
