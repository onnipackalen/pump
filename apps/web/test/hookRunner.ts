/**
 * A small stand-in for React's hooks, so a test can run a hook such as
 * useGame in Node, with no page: useState, useRef, useEffect, useCallback
 * and useMemo. A state change draws the hook again on the next microtask
 * (changes made together are drawn once), and effects run right after each
 * draw whose dependencies changed, as React runs them after it commits.
 *
 * A test swaps it in for React with vi.mock('react', () => import('./hookRunner')),
 * then mounts the hook with mount().
 */

interface Slot {
  value: unknown;
  deps: readonly unknown[] | undefined;
  cleanup: (() => void) | undefined;
}

interface Instance {
  readonly slots: Slot[];
  next: number;
  effects: (() => void)[];
  scheduled: boolean;
  readonly draw: () => void;
}

let current: Instance | null = null;

/** The hook's next slot, and whether it is new on this draw. */
function nextSlot(): { readonly instance: Instance; readonly slot: Slot; readonly fresh: boolean } {
  const instance = current;
  if (instance === null) throw new Error('A hook was called outside a mounted hook');
  const index = instance.next;
  instance.next += 1;
  const existing = instance.slots[index];
  if (existing) return { instance, slot: existing, fresh: false };
  const slot: Slot = { value: undefined, deps: undefined, cleanup: undefined };
  instance.slots[index] = slot;
  return { instance, slot, fresh: true };
}

function depsChanged(before: readonly unknown[] | undefined, now: readonly unknown[] | undefined): boolean {
  if (before === undefined || now === undefined) return true;
  return before.length !== now.length || before.some((value, i) => !Object.is(value, now[i]));
}

interface StateCell<T> {
  state: T;
  readonly set: (update: T | ((before: T) => T)) => void;
}

export function useState<T>(initial: T | (() => T)): [T, (update: T | ((before: T) => T)) => void] {
  const { instance, slot, fresh } = nextSlot();
  if (fresh) {
    const cell: StateCell<T> = {
      state: typeof initial === 'function' ? (initial as () => T)() : initial,
      set: (update) => {
        const next = typeof update === 'function' ? (update as (before: T) => T)(cell.state) : update;
        if (Object.is(next, cell.state)) return;
        cell.state = next;
        if (instance.scheduled) return;
        instance.scheduled = true;
        queueMicrotask(() => {
          instance.scheduled = false;
          instance.draw();
        });
      },
    };
    slot.value = cell;
  }
  const cell = slot.value as StateCell<T>;
  return [cell.state, cell.set];
}

export function useRef<T>(initial: T): { current: T } {
  const { slot, fresh } = nextSlot();
  if (fresh) slot.value = { current: initial };
  return slot.value as { current: T };
}

export function useMemo<T>(make: () => T, deps: readonly unknown[]): T {
  const { slot, fresh } = nextSlot();
  if (fresh || depsChanged(slot.deps, deps)) {
    slot.value = make();
    slot.deps = deps;
  }
  return slot.value as T;
}

export function useCallback<T>(callback: T, deps: readonly unknown[]): T {
  const { slot, fresh } = nextSlot();
  if (fresh || depsChanged(slot.deps, deps)) {
    slot.value = callback;
    slot.deps = deps;
  }
  return slot.value as T;
}

export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
  const { instance, slot, fresh } = nextSlot();
  if (!fresh && deps !== undefined && !depsChanged(slot.deps, deps)) return;
  slot.deps = deps;
  instance.effects.push(() => {
    slot.cleanup?.();
    const cleanup = effect();
    slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
  });
}

/** Mounts a hook. `current()` gives what it returned on its latest draw. */
export function mount<R>(hook: () => R): { readonly current: () => R } {
  let result: { readonly value: R } | null = null;
  const instance: Instance = {
    slots: [],
    next: 0,
    effects: [],
    scheduled: false,
    draw: () => {
      instance.next = 0;
      instance.effects = [];
      current = instance;
      try {
        result = { value: hook() };
      } finally {
        current = null;
      }
      const effects = instance.effects;
      instance.effects = [];
      for (const run of effects) run();
    },
  };
  instance.draw();
  return {
    current: () => {
      if (result === null) throw new Error('The hook has not drawn yet');
      return result.value;
    },
  };
}
