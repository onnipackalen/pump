/** Fixed settings of the server. Game numbers (RTP, ladders, limits) live in the engine. */

/** Every new player starts with $10,000, in cents. */
export const STARTING_BALANCE_CENTS = 1_000_000;

/** The cookie that identifies an anonymous player. */
export const PLAYER_COOKIE = 'pump_player';

/** How long that cookie lasts: one year, in seconds. */
export const PLAYER_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * A round nobody has touched for this long is settled for the player: pumped
 * balloons cash out, unpumped bets are refunded. 24 hours, in milliseconds.
 */
export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

/** How often the server looks for such rounds on its own: every 10 minutes. */
export const ABANDONED_SWEEP_EVERY_MS = 10 * 60 * 1000;

/** How many finished rounds the history list returns when not told otherwise. */
export const HISTORY_DEFAULT_LIMIT = 10;
export const HISTORY_MAX_LIMIT = 50;
