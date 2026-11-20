/**
 * Rules that change by country or licence, not by game math.
 *
 * Pick one at build time with VITE_MARKET (for example VITE_MARKET=gb).
 * Unknown or missing values fall back to "default".
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

const defaultMarket: MarketRules = { id: 'default', autoPlay: true };

export function marketFor(id: string | undefined): MarketRules {
  return (id === undefined ? undefined : MARKETS[id]) ?? defaultMarket;
}

export const market: MarketRules = marketFor(import.meta.env.VITE_MARKET);
