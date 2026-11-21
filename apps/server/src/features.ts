/**
 * Things the server can switch off for a market. They are about what a
 * regulator allows, not about the game's math, so they do not live in the
 * engine's configuration.
 *
 * Each is set by an environment variable when the server starts. A value the
 * server does not know switches the feature OFF and says so: a typo must
 * never switch on something a market does not allow.
 */
export interface Features {
  /**
   * Whether GET /api/wins lists other players' wins. Showing other players'
   * results is not allowed everywhere. Set PUBLIC_WINS=off to switch it off;
   * the server then reads nothing for it and sends empty lists.
   */
  readonly publicWins: boolean;
}

export interface FeaturesFromEnv {
  readonly features: Features;
  /** One sentence for each setting that was not understood. */
  readonly warnings: readonly string[];
}

/** Everything on: what the server does when nothing is set. */
export const ALL_FEATURES: Features = { publicWins: true };

/** Reads one on/off setting. Nothing set means on; an unknown word means off. */
function onUnlessOff(name: string, value: string | undefined, warnings: string[]): boolean {
  const word = value?.trim().toLowerCase() ?? '';
  if (word === '' || word === 'on') return true;
  if (word === 'off') return false;
  warnings.push(`${name} is "${value ?? ''}", which is neither "on" nor "off": it is switched off.`);
  return false;
}

export function featuresFromEnv(env: Readonly<Record<string, string | undefined>>): FeaturesFromEnv {
  const warnings: string[] = [];
  const features: Features = {
    publicWins: onUnlessOff('PUBLIC_WINS', env.PUBLIC_WINS, warnings),
  };
  return { features, warnings };
}
