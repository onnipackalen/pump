/** Fixed settings of the server. Game numbers (RTP, ladders, limits) live in the engine. */

/** Every new player starts with $10,000, in cents. */
export const STARTING_BALANCE_CENTS = 1_000_000;

/** The cookie that identifies an anonymous player. */
export const PLAYER_COOKIE = 'pump_player';

/** How long that cookie lasts: one year, in seconds. */
export const PLAYER_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** How many finished rounds the history list returns when not told otherwise. */
export const HISTORY_DEFAULT_LIMIT = 10;
export const HISTORY_MAX_LIMIT = 50;
