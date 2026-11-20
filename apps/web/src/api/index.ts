import { DemoClient } from '../demo/DemoClient';
import type { GameClient } from './client';

/**
 * The client the app uses. For now that is the in-browser demo, because the
 * server is not built yet. When it is, replace this with the HTTP client.
 */
export const gameClient: GameClient = new DemoClient();
