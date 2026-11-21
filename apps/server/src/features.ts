/**
 * Things the server can switch off for a market. They are about what a
 * regulator allows, not about the game's math, so they do not live in the
 * engine's configuration.
 *
 * Each is set by an environment variable when the server starts:
 *
 * - "on" or "off" is taken as written.
 * - A word the server does not know switches the feature OFF and says so: a
 *   typo in the value must never switch on something a market does not allow.
 * - Nothing set, or an empty value: ON on someone's own machine, so a person
 *   running the game from the repository sees everything; OFF on a host. On a
 *   host a feature that shows players' results to others must be a written
 *   choice, and a forgotten or misnamed entry must not publish anything.
 *
 * A typo in the variable's NAME cannot be seen from here, so the server says
 * at every start whether each feature is on.
 */
export interface Features {
  /**
   * Whether GET /api/wins lists players' wins to everyone. Showing other
   * players' results is not allowed everywhere. PUBLIC_WINS=off switches it
   * off: the server then reads nothing for it and sends empty lists. On a
   * host it is off unless PUBLIC_WINS=on.
   */
  readonly publicWins: boolean;
}

export interface FeaturesFromEnv {
  readonly features: Features;
  /** One sentence for each setting that was not understood. */
  readonly warnings: readonly string[];
}

/** Everything on: what the server does on someone's own machine when nothing is set. */
export const ALL_FEATURES: Features = { publicWins: true };

/** Reads one on/off setting. `whenUnset` is what nothing set (or only spaces) means. */
function onOrOff(
  name: string,
  value: string | undefined,
  whenUnset: boolean,
  warnings: string[],
): boolean {
  const word = value?.trim().toLowerCase() ?? '';
  if (word === '') return whenUnset;
  if (word === 'on') return true;
  if (word === 'off') return false;
  warnings.push(`${name} is "${value ?? ''}", which is neither "on" nor "off": it is switched off.`);
  return false;
}

/** `onHost`: true on a host, false on someone's own machine (see db/location.ts runningOnHost). */
export function featuresFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  onHost: boolean,
): FeaturesFromEnv {
  const warnings: string[] = [];
  const features: Features = {
    publicWins: onOrOff('PUBLIC_WINS', env.PUBLIC_WINS, !onHost, warnings),
  };
  return { features, warnings };
}
