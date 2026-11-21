import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BalloonView, RoundView } from '../src/api/contract';
import { RoundControls } from '../src/components/RoundControls';
import {
  canQueueCashOut,
  cashOutsToSend,
  cashOutWaiting,
  dropQueued,
  queueCashOut,
  type QueuedCashOut,
} from '../src/game/cashOutQueue';
import { panelActivity, showOwnPump, type PanelActivity } from '../src/game/controls';
import { busyForMs } from '../src/game/useGame';
import { holdStep, type HoldTarget } from '../src/game/useHoldPump';
import { balloon, round } from './fixtures';

const css = readFileSync(new URL('../src/balloon/balloon.css', import.meta.url), 'utf8');

describe('showOwnPump', () => {
  it('gives a balloon its own Pump only in a round of two or three', () => {
    const one = round([balloon()]);
    expect(showOwnPump(one, one.balloons[0] ?? balloon())).toBe(false);
    const two = round([balloon(), balloon()]);
    expect(two.balloons.map((b) => showOwnPump(two, b))).toEqual([true, true]);
    const three = round([balloon(), balloon(), balloon()]);
    expect(three.balloons.map((b) => showOwnPump(three, b))).toEqual([true, true, true]);
  });

  it('only while that balloon is still in play', () => {
    const r = round([balloon({ status: 'popped' }), balloon(), balloon()]);
    expect(r.balloons.map((b) => showOwnPump(r, b))).toEqual([false, true, true]);
  });

  it('still on the last balloon left in a round of two or three', () => {
    const three = round([balloon({ status: 'popped' }), balloon({ status: 'cashed' }), balloon()]);
    expect(three.balloons.map((b) => showOwnPump(three, b))).toEqual([false, false, true]);
    const two = round([balloon(), balloon({ status: 'popped' })]);
    expect(two.balloons.map((b) => showOwnPump(two, b))).toEqual([true, false]);
  });
});

describe('canQueueCashOut: only what the Cash out button would take', () => {
  const pumped = balloon({ rung: 2, drawIndex: 2, cashOutCents: 118 });

  it('queues a balloon in play that has a cash-out value', () => {
    expect(canQueueCashOut(round([pumped]), pumped)).toBe(true);
  });

  it('does not queue during the very first pump: there is nothing to cash out yet', () => {
    const first = balloon({ rung: 0, drawIndex: 0, cashOutCents: null });
    expect(canQueueCashOut(round([first]), first)).toBe(false);
  });

  it('does not queue a balloon that has ended, or in a finished round', () => {
    expect(canQueueCashOut(round([pumped, balloon()]), { ...pumped, status: 'popped' })).toBe(false);
    const finished = round([{ ...pumped, status: 'cashed' }]);
    expect(canQueueCashOut(finished, pumped)).toBe(false);
    expect(canQueueCashOut(round([pumped]), undefined)).toBe(false);
  });
});

/** A duration custom property from balloon.css, in ms. */
function cssMs(name: string): number {
  const found = new RegExp(`${name}: (\\d+)ms`).exec(css);
  if (!found) throw new Error(`no ${name}`);
  return Number(found[1]);
}

describe('busyForMs: how long an answer keeps its balloon busy', () => {
  it('holds a survive with a cash-out waiting long enough for its whole survive motion', () => {
    const wait = busyForMs('survived', true);
    // The spring, the new number's punch, the air going in, and a spent
    // Patch peeling off: all over before the cash-out starts.
    expect(wait).toBeGreaterThanOrEqual(cssMs('--pb-spring-ms'));
    expect(wait).toBeGreaterThanOrEqual(cssMs('--pb-value-ms'));
    expect(wait).toBeGreaterThanOrEqual(cssMs('--pb-air-in-ms'));
    expect(wait).toBeGreaterThanOrEqual(cssMs('--pb-patch-peel-delay') + cssMs('--pb-patch-peel-ms'));
  });

  it('does not hold a survive with nothing waiting, or a pump that ended the balloon', () => {
    expect(busyForMs('survived', false)).toBe(0);
    expect(busyForMs('popped', true)).toBe(0);
    expect(busyForMs('top', true)).toBe(0);
  });

  it('holds a Patch save for its motion either way', () => {
    expect(busyForMs('saved', false)).toBeGreaterThan(0);
    expect(busyForMs('saved', true)).toBe(busyForMs('saved', false));
  });
});

describe('panelActivity', () => {
  it('says what a balloon is doing, a waiting cash-out first', () => {
    expect(panelActivity(false, 'idle', false)).toBe('free');
    expect(panelActivity(true, 'press', false)).toBe('pumping');
    expect(panelActivity(true, 'saved', false)).toBe('busy');
    expect(panelActivity(true, 'idle', false)).toBe('busy');
    expect(panelActivity(true, 'press', true)).toBe('queued');
  });
});

describe('the round panel while a pump is on its way', () => {
  const b = balloon({
    rung: 1,
    drawIndex: 1,
    multiplierHundredths: 160,
    cashOutCents: 160,
    next: { popChance: { num: 42, den: 100 }, multiplierHundredths: 277, patchPriceCents: 75 },
  });

  /** The panel's markup for one balloon doing `doing`. */
  function panel(doing: PanelActivity, balloons: readonly BalloonView[] = [b]): string {
    const noop = (): void => undefined;
    return renderToStaticMarkup(
      createElement(RoundControls, {
        balloon: balloons[0] ?? null,
        balloons,
        multi: balloons.length > 1,
        pending: false,
        activity: balloons.map(() => doing),
        onPump: noop,
        onPumpHold: noop,
        onPatchPump: noop,
        onCashOut: noop,
        onCashOutAll: noop,
        liveCount: balloons.length,
        onPumpAll: noop,
        onPumpAllHold: noop,
      }),
    );
  }

  /** The opening tag and text of the button whose name starts with `name`. */
  function button(html: string, name: string): { disabled: boolean; text: string } {
    const buttons = html.match(/<button[^>]*>.*?<\/button>/g) ?? [];
    const found = buttons.find((x) => x.replace(/<[^>]+>/g, '').startsWith(name));
    if (!found) throw new Error(`no ${name} button`);
    return { disabled: /<button[^>]* disabled=""/.test(found), text: found.replace(/<[^>]+>/g, '') };
  }

  it('shows the amount, and takes both presses, while nothing is on its way', () => {
    const html = panel('free');
    expect(button(html, 'Cash out')).toEqual({ disabled: false, text: 'Cash out$1.60' });
    expect(button(html, 'Patch + Pump').disabled).toBe(false);
  });

  it('shows no amount on Cash out while the pump is on its way, and greys Patch + Pump', () => {
    const html = panel('pumping');
    expect(button(html, 'Cash out')).toEqual({ disabled: false, text: 'Cash outafter pump' });
    expect(html).not.toContain('$1.60</strong>');
    expect(button(html, 'Patch + Pump').disabled).toBe(true);
  });

  it('says a pressed Cash out is queued, and takes no second press', () => {
    expect(button(panel('queued'), 'Cash out')).toEqual({ disabled: true, text: 'Cash outqueued' });
  });

  it('greys Patch + Pump during a Patch save too, where a press would be ignored', () => {
    expect(button(panel('busy'), 'Patch + Pump').disabled).toBe(true);
    expect(button(panel('busy'), 'Cash out').text).toBe('Cash out$1.60');
  });

  it('shows no amount on Cash out all while any of its balloons is pumping', () => {
    const two = [b, { ...b, index: 1 }];
    expect(button(panel('pumping', two), 'Cash out all').text).toBe('Cash out allafter pump');
    expect(button(panel('free', two), 'Cash out all').text).toBe('Cash out all$3.20');
    expect(button(panel('queued', two), 'Cash out all').disabled).toBe(true);
  });
});

/**
 * Plays "C during a hold" the way useGame does: the balloon's pump is on its
 * way (busy), C is pressed and queued, then the pump's answer arrives and
 * the queue is looked at once more on the newest round.
 */
function cOnAnswer(
  before: RoundView,
  index: number,
  answer: RoundView | null,
): { sent: readonly number[]; left: readonly QueuedCashOut[] } {
  // C while busy: it waits instead of being dropped.
  let queue = queueCashOut([], before.id, index);
  const whileBusy = cashOutsToSend(queue, before, () => true);
  expect(whileBusy.send).toEqual([]);
  expect(whileBusy.keep).toEqual(queue);
  queue = whileBusy.keep;
  // The answer is in: the balloon is free.
  const after = cashOutsToSend(queue, answer, () => false);
  return { sent: after.send, left: after.keep };
}

describe('a cash-out pressed while the balloon\'s pump is on its way', () => {
  const before = round([balloon({ rung: 3, drawIndex: 3, cashOutCents: 150 }), balloon()]);

  it('is sent once the pump survives and the balloon is still in play', () => {
    const answer = round([balloon({ rung: 4, drawIndex: 4, cashOutCents: 170 }), balloon()]);
    expect(cOnAnswer(before, 0, answer)).toEqual({ sent: [0], left: [] });
  });

  it('is sent after a Patch save too, once the save is over (same rung, one more draw)', () => {
    const saved = round([balloon({ rung: 3, drawIndex: 4, cashOutCents: 150 }), balloon()]);
    let queue = queueCashOut([], before.id, 0);
    // The save's motion keeps the balloon busy: still waiting.
    expect(cashOutsToSend(queue, saved, (i) => i === 0).send).toEqual([]);
    queue = cashOutsToSend(queue, saved, (i) => i === 0).keep;
    expect(cashOutsToSend(queue, saved, () => false)).toEqual({ send: [0], keep: [] });
  });

  it('is never sent for a balloon that popped', () => {
    const popped = round([balloon({ status: 'popped', rung: 3, drawIndex: 4 }), balloon()]);
    expect(cOnAnswer(before, 0, popped)).toEqual({ sent: [], left: [] });
  });

  it('is never sent for a balloon that reached its top (it cashed out by itself)', () => {
    const top = round([balloon({ status: 'cashed', rung: 10, drawIndex: 10, payoutCents: 900 }), balloon()]);
    expect(cOnAnswer(before, 0, top)).toEqual({ sent: [], left: [] });
  });

  it('is never sent in another round', () => {
    const other = round([balloon({ rung: 4, drawIndex: 4 }), balloon()], { id: 'round-2' });
    expect(cOnAnswer(before, 0, other)).toEqual({ sent: [], left: [] });
    expect(cOnAnswer(before, 0, null)).toEqual({ sent: [], left: [] });
  });

  it('is never sent for a finished round, or before the first pump has landed', () => {
    const finished = round([balloon({ status: 'cashed', rung: 3, drawIndex: 3 })]);
    expect(cOnAnswer(round([balloon({ rung: 3, drawIndex: 3 })]), 0, finished).sent).toEqual([]);
    // The first pump's answer has not moved it off rung 0 (a refusal, say).
    const unpumped = round([balloon(), balloon()]);
    expect(cOnAnswer(unpumped, 0, unpumped).sent).toEqual([]);
  });

  it('is sent once only, however many times C was pressed', () => {
    let queue = queueCashOut([], before.id, 0);
    queue = queueCashOut(queue, before.id, 0);
    expect(queue).toHaveLength(1);
    const answer = round([balloon({ rung: 4, drawIndex: 4 }), balloon()]);
    const first = cashOutsToSend(queue, answer, () => false);
    expect(first.send).toEqual([0]);
    expect(cashOutsToSend(first.keep, answer, () => false).send).toEqual([]);
  });

  it('leaves other balloons\' waiting cash-outs alone until they are free', () => {
    const r = round([balloon({ rung: 2, drawIndex: 2 }), balloon({ rung: 1, drawIndex: 1 })]);
    let queue = queueCashOut([], r.id, 0);
    queue = queueCashOut(queue, r.id, 1);
    const step = cashOutsToSend(queue, r, (i) => i === 1);
    expect(step.send).toEqual([0]);
    expect(step.keep).toEqual([{ roundId: r.id, index: 1 }]);
  });

  it('blocks a new pump on that balloon while it waits, and is dropped if the pump fails', () => {
    const queue = queueCashOut([], before.id, 0);
    expect(cashOutWaiting(queue, before.id, 0)).toBe(true);
    expect(cashOutWaiting(queue, before.id, 1)).toBe(false);
    expect(cashOutWaiting(queue, 'round-2', 0)).toBe(false);
    expect(dropQueued(queue, 0)).toEqual([]);
    expect(dropQueued(queue, 1)).toBe(queue);
  });

  it('ends the hold: once the balloon has cashed out, the hold has nothing left to pump', () => {
    const hold: HoldTarget = { kind: 'one', roundId: 'round-1', index: 0 };
    const cashed = round([balloon({ status: 'cashed', rung: 4, drawIndex: 4 }), balloon()]);
    expect(holdStep(cashed, [false, false], hold)).toBeNull();
  });
});
