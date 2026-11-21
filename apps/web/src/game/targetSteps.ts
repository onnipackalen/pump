/**
 * The − and + beside auto-play's Target. Each moves the target one step
 * along the ladder: one pump fewer or one more per balloon, so the
 * multiplier next to them changes step by step.
 *
 * Display only: auto-play still gets a pump count, checked as before
 * (checkAutoPlayForm). This only works out the next text for the box.
 *
 * + goes no higher than the top these bets can reach (`topRung`, never
 * past the ladder): a balloon there cashes out by itself, so a higher
 * count would change nothing. A count typed past that top comes back to
 * the top on −. Text that is not a count yet becomes 1.
 *
 * Returns the new text, or null when the button has nothing to do (−
 * at 1, + at the top): it is greyed out then.
 */
export function stepTargetPumps(
  text: string,
  delta: 1 | -1,
  ladderLength: number,
  topRung: number,
): string | null {
  const highest = Math.max(1, Math.min(ladderLength, topRung));
  const trimmed = text.trim();
  const typed = /^\d+$/.test(trimmed) ? Number(trimmed) : 0;
  if (typed < 1) return '1';
  if (typed > highest) return delta < 0 ? String(highest) : null;
  const next = typed + delta;
  return next < 1 || next > highest ? null : String(next);
}

/** The first target the auto-play form shows. */
export const FIRST_TARGET_PUMPS = '3';

/**
 * The target as a pump count, read the same way the auto-play form reads
 * it (a whole number from 1 to the ladder's length), or null while it is
 * not one. The stage marks this step (StepRow's target).
 */
export function targetPumpsOf(text: string, ladderLength: number): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  const pumps = Number(trimmed);
  return pumps >= 1 && pumps <= ladderLength ? pumps : null;
}
