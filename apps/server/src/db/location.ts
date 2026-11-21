import { dirname, isAbsolute } from 'node:path';

/**
 * Where the database file goes, and whether its folder may be made.
 *
 * Every wallet lives in this one file, so putting it in the wrong place is
 * the one setup mistake that loses money. A host such as Render keeps only
 * the files on its attached disk; everything else is thrown away on each new
 * deploy. If the file sat anywhere else, the game would look fine until the
 * next deploy and then start again with every balance gone. So the server
 * refuses to start instead:
 *
 * - On a host, DATABASE_PATH must be set, as a full path. The quiet default,
 *   a file inside the app's own folder, is for a developer's machine only.
 * - A folder named by DATABASE_PATH is never made by the server. It has to be
 *   there already: on a host it is the attached disk. A folder the server
 *   made by itself would sit on the throwaway disk, which is exactly the
 *   mistake this guards against (a mistyped path, or a disk that was never
 *   attached).
 */

export interface PlaceInputs {
  /** The value of DATABASE_PATH, if any. */
  readonly chosen: string | undefined;
  /** True on a host, false on someone's own machine. See runningOnHost. */
  readonly onHost: boolean;
  /** Where the file goes when nothing was chosen: inside the app's own folder. */
  readonly fallback: string;
  /** Whether a folder is there. Passed in so the rule can be tested without a disk. */
  readonly folderExists: (folder: string) => boolean;
}

export interface DatabasePlace {
  readonly path: string;
  /** Only the fallback's folder is made for you. */
  readonly createFolder: boolean;
}

/**
 * True when this process runs on a host. Hosts set NODE_ENV=production for a
 * running Node service, and Render also sets RENDER.
 */
export function runningOnHost(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.NODE_ENV === 'production' || env.RENDER !== undefined;
}

/** Decides where the database file goes, or throws with what to fix. */
export function databasePlace(inputs: PlaceInputs): DatabasePlace {
  const chosen = inputs.chosen?.trim() ?? '';

  if (chosen === '') {
    if (inputs.onHost) {
      throw new Error(
        'DATABASE_PATH is not set. On a host it must name a file on the disk that survives ' +
          'deploys (for example /var/data/pump.db). Without it every wallet would be lost on ' +
          'the next deploy, so the server will not start. (This counts as a host because ' +
          'NODE_ENV is "production" or RENDER is set. On your own computer, unset NODE_ENV.)',
      );
    }
    return { path: inputs.fallback, createFolder: true };
  }

  if (inputs.onHost && !isAbsolute(chosen)) {
    throw new Error(
      `DATABASE_PATH must be a full path on a host, starting with "/". It is "${chosen}".`,
    );
  }

  const folder = dirname(chosen);
  if (!inputs.folderExists(folder)) {
    throw new Error(
      `DATABASE_PATH is "${chosen}", but the folder "${folder}" does not exist. The server ` +
        'never makes this folder itself: on a host it must be the attached disk, and a ' +
        'folder made here would be thrown away on the next deploy. Check that the disk is ' +
        'attached at that path, or fix the path.',
    );
  }
  return { path: chosen, createFolder: false };
}
