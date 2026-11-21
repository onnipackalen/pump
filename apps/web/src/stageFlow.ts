/**
 * The stage flowing into a new set-up before a round: when the player picks
 * another number of balloons or another difficulty, each pump and the line
 * under it glide from where they were to their new place, a new balloon's
 * slot rises in, and one that goes sinks away (the user: "Make it flow
 * better. Like flow into 3 pumps."). A typed bet just changes.
 *
 * How: the pieces are measured just before the change, React draws the
 * new set-up, and each piece is then moved back to where it was and let go
 * (Web Animations, transform and opacity only). The page itself has
 * changed at once, so it is never half drawn, and nothing lies over it:
 * every tap reaches its button, even mid-glide. A click mid-glide measures
 * the pieces where they are on screen and glides on from there.
 *
 * With animations off (the player's setting or the device's reduced
 * motion) nothing moves: the stage swaps at once, as before.
 *
 * Display only: nothing here touches a round, the math or the server.
 */

import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { BetSetup } from './game/betSetup';

/** How long a glide takes, and its curve: calm, no bounce (the step row's own). */
export const FLOW_MS = 320;
export const FLOW_EASING = 'cubic-bezier(0.22, 0.7, 0.2, 1)';

/** A slot that comes or goes: faded, a little lower and smaller. */
const AWAY: Keyframe = { opacity: 0, transform: 'translateY(14px) scale(0.92)' };
const HERE: Keyframe = { opacity: 1, transform: 'none' };

/** Whether a change to the bet panel moves pumps: a new count or difficulty. */
export function flowsOnChange(before: BetSetup, next: BetSetup): boolean {
  return next.difficultyId !== before.difficultyId || next.bets.length !== before.bets.length;
}

/** The stage as measured just before a change. */
interface Before {
  readonly slots: readonly HTMLElement[];
  readonly slotRects: readonly DOMRect[];
  readonly pumps: readonly (DOMRect | null)[];
  readonly labels: readonly (DOMRect | null)[];
}

function slotsIn(container: HTMLElement): HTMLElement[] {
  return [...container.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('slot'),
  );
}

const pumpOf = (slot: Element): Element | null => slot.querySelector('svg.pump-balloon');
const labelOf = (slot: Element): Element | null => slot.querySelector('.slot-label');

function measure(container: HTMLElement): Before {
  const slots = slotsIn(container);
  return {
    slots,
    slotRects: slots.map((slot) => slot.getBoundingClientRect()),
    pumps: slots.map((slot) => pumpOf(slot)?.getBoundingClientRect() ?? null),
    labels: slots.map((slot) => labelOf(slot)?.getBoundingClientRect() ?? null),
  };
}

/** Stops any glide still running on an element, so it can be measured where it now belongs. */
function stopFlow(el: Element): void {
  for (const animation of el.getAnimations()) {
    if (animation.id === 'flow') animation.cancel();
  }
}

/**
 * Moves a piece back to where it was, centre to centre, and lets it glide
 * to where it is now. A pump also changes size when its new place is
 * smaller (three balloons on a phone); a line of text never does.
 */
function glide(el: Element, from: DOMRect, resize: boolean): void {
  stopFlow(el);
  const to = el.getBoundingClientRect();
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const scale = resize && to.height > 0 ? from.height / to.height : 1;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(scale - 1) < 0.01) return;
  el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${scale})` }, { transform: 'none' }], {
    id: 'flow',
    duration: FLOW_MS,
    easing: FLOW_EASING,
  });
}

function play(container: HTMLElement, gone: HTMLElement | null, before: Before): void {
  const slots = slotsIn(container);
  slots.forEach((slot, index) => {
    if (index >= before.slots.length) {
      // A new balloon: its whole slot rises in.
      stopFlow(slot);
      slot.animate([AWAY, HERE], { id: 'flow', duration: FLOW_MS, easing: FLOW_EASING });
      return;
    }
    const pump = pumpOf(slot);
    const pumpFrom = before.pumps[index];
    if (pump && pumpFrom) glide(pump, pumpFrom, true);
    const label = labelOf(slot);
    const labelFrom = before.labels[index];
    if (label && labelFrom) glide(label, labelFrom, false);
  });
  if (gone === null) return;
  // A balloon that went: a copy of its slot sinks away where it was. The
  // copy is only a picture: hidden from screen readers, never tapped.
  const origin = gone.getBoundingClientRect();
  before.slots.slice(slots.length).forEach((old, offset) => {
    const rect = before.slotRects[slots.length + offset];
    if (!rect) return;
    const ghost = old.cloneNode(true);
    if (!(ghost instanceof HTMLElement)) return;
    ghost.inert = true;
    ghost.style.position = 'absolute';
    ghost.style.left = `${rect.left - origin.left}px`;
    ghost.style.top = `${rect.top - origin.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    // It left a row of two or three, where a pump has no close-up view.
    ghost.style.setProperty('--pb-first-zoom', 'scale(1)');
    gone.append(ghost);
    const sink = ghost.animate([HERE, AWAY], {
      duration: FLOW_MS,
      easing: FLOW_EASING,
      fill: 'forwards',
    });
    // Gone once it has sunk. The timer also clears it when the page draws
    // no frames (a hidden tab), so copies never pile up.
    const clear = (): void => ghost.remove();
    sink.finished.then(clear, clear);
    setTimeout(clear, FLOW_MS * 2);
  });
}

/**
 * The flow for the stage's slots. Call the returned function just before a
 * change that should flow; the glide plays as React draws the change,
 * before the browser paints it. `slots` holds the slots; `gone` is an
 * empty layer over them where slots that go sink away.
 */
export function useStageFlow(
  slots: RefObject<HTMLElement | null>,
  gone: RefObject<HTMLElement | null>,
  animationsOn: boolean,
): () => void {
  const before = useRef<Before | null>(null);
  useLayoutEffect(() => {
    const measured = before.current;
    if (measured === null) return;
    before.current = null;
    if (slots.current) play(slots.current, gone.current, measured);
  });
  return () => {
    const container = slots.current;
    before.current =
      animationsOn && container !== null && typeof container.animate === 'function'
        ? measure(container)
        : null;
  };
}
