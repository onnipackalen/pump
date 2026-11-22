import { describe, expect, it, vi } from 'vitest';
import { NetworkFailure } from '../src/api/client';
import type { SessionView } from '../src/api/contract';
import { DemoClient } from '../src/demo/DemoClient';
import { useGame } from '../src/game/useGame';
import { mount } from './hookRunner';

// The real useGame, run on a small stand-in for React's hooks.
vi.mock('react', () => import('./hookRunner'));

/*
 * A first load that fails leaves the screen with nothing to play on. The
 * notice then offers "Try again" (App.tsx), which loads the session again
 * instead of leaving Bet off until the page is reloaded.
 */

const OFFLINE = 'Could not reach the game server. Check your connection and try again.';

/** A demo server that cannot be reached for its first `failures` loads. */
class FlakyClient extends DemoClient {
  loads = 0;
  constructor(private readonly failures: number) {
    super(undefined, 0);
  }
  override async getSession(): Promise<SessionView> {
    this.loads += 1;
    if (this.loads <= this.failures) throw new NetworkFailure(OFFLINE);
    return super.getSession();
  }
}

async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('a first load that failed', () => {
  it('loads again on Try again, and the game is ready', async () => {
    const client = new FlakyClient(2);
    const game = mount(() => useGame(client));
    await until(() => game.current().state.phase === 'failed');
    expect(game.current().state.notice).toEqual({ tone: 'error', text: OFFLINE });

    // Still down: it fails again and says so again.
    game.current().retryLoad();
    await until(() => client.loads === 2 && game.current().state.phase === 'failed');
    expect(game.current().state.notice?.text).toBe(OFFLINE);

    // Back up: the game loads and the notice goes.
    game.current().retryLoad();
    await Promise.resolve();
    expect(game.current().state.phase).toBe('loading');
    expect(game.current().state.notice).toBeNull();
    await until(() => game.current().state.phase === 'ready');
    expect(client.loads).toBe(3);
    expect(game.current().state.notice).toBeNull();
    expect(game.current().state.wallet).not.toBeNull();
    expect(game.current().state.fairness).not.toBeNull();
  });

  it('does nothing once the game has loaded', async () => {
    const client = new FlakyClient(0);
    const game = mount(() => useGame(client));
    await until(() => game.current().state.phase === 'ready');
    game.current().retryLoad();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(game.current().state.phase).toBe('ready');
    expect(client.loads).toBe(1);
  });
});
