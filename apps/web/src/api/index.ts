import type { GameClient } from './client';
import { HttpClient } from './httpClient';

/**
 * The client the app uses: the real server.
 *
 * (An in-browser stand-in still exists in ../demo for tests of the screen's
 * own logic. It is not imported here, so it is not part of the built app.)
 */
export const gameClient: GameClient = new HttpClient();
