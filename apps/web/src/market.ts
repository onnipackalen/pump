/**
 * Rules that change by country or licence, not by game math.
 *
 * Pick one at build time with VITE_MARKET (for example VITE_MARKET=gb).
 * Case and spaces don't matter, and "uk" means "gb". No value at all gives
 * "default". A value this file doesn't know fails closed: auto-play is off,
 * and the console says why. A typo must never switch a banned feature on.
 */

export interface MarketRules {
  readonly id: string;
  /**
   * Whether auto-play is offered. The brief asks for it, but some
   * regulators ban it for online casino games (Great Britain since 2021).
   */
  readonly autoPlay: boolean;
}

const MARKETS: Readonly<Record<string, MarketRules>> = {
  default: { id: 'default', autoPlay: true },
  gb: { id: 'gb', autoPlay: false },
};

const ALIASES: Readonly<Record<string, string>> = { uk: 'gb' };

const defaultMarket: MarketRules = { id: 'default', autoPlay: true };

export function marketFor(id: string | undefined): MarketRules {
  const key = id?.trim().toLowerCase() ?? '';
  if (key === '') return defaultMarket;
  const name = Object.hasOwn(ALIASES, key) ? (ALIASES[key] ?? key) : key;
  const known = Object.hasOwn(MARKETS, name) ? MARKETS[name] : undefined;
  if (known) return known;
  console.error(`Unknown VITE_MARKET "${id ?? ''}": auto-play is switched off.`);
  return { id: key, autoPlay: false };
}

export const market: MarketRules = marketFor(import.meta.env.VITE_MARKET);
