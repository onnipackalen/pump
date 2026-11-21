import { useCallback, useEffect, useState } from 'react';
import type { GameClient } from '../api/client';
import type { PublicWinsResponse } from '../api/contract';
import {
  answered,
  failed,
  nextFetchIn,
  seen,
  sent,
  START_WATCH,
  tabShown,
  wanted,
  type WinsWatch,
} from './polling';

/** Everyone on this page who wants fresh lists soon (see askForFreshWins). */
const nudges = new Set<() => void>();

/**
 * Asks for fresh lists soon, still never sooner than five seconds after the
 * last request. The settings row calls it once "Keep my wins private" is
 * saved, so the player sees their wins leave (or come back) at the next
 * refresh.
 */
export function askForFreshWins(): void {
  for (const nudge of nudges) nudge();
}

function tabIsVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

export interface PublicWinsControl {
  /** The server's latest answer; null before the first. The panel shows nothing for an off answer. */
  readonly wins: PublicWinsResponse | null;
  /** Goes on the section, so the lists are asked for only while it is on screen. */
  readonly sectionRef: (element: HTMLElement) => () => void;
}

/**
 * The public wins, asked for by the rule in polling.ts. `latestRoundId` is
 * the newest round in the player's history: when it changes, a round of
 * theirs has ended and been saved, so fresh lists are wanted soon.
 */
export function usePublicWins(client: GameClient, latestRoundId: string | null): PublicWinsControl {
  const [watch, setWatch] = useState<WinsWatch>(() => ({
    ...START_WATCH,
    tabVisible: tabIsVisible(),
  }));
  const [wins, setWins] = useState<PublicWinsResponse | null>(null);

  // A new round in the history: React's pattern for reacting to a changed
  // value while rendering, without an extra pass through an effect.
  const [roundSeen, setRoundSeen] = useState(latestRoundId);
  if (roundSeen !== latestRoundId) {
    setRoundSeen(latestRoundId);
    setWatch(wanted);
  }

  // The one place a request is sent. Every change to the watch clears the
  // timer and works out the next one afresh, so there is never more than one.
  useEffect(() => {
    const delay = nextFetchIn(watch, Date.now());
    if (delay === null) return;
    const timer = setTimeout(() => {
      setWatch((w) => sent(w, Date.now()));
      client.getPublicWins().then(
        (answer) => {
          setWins(answer);
          setWatch((w) => answered(w, answer.enabled));
        },
        // The lists shown stay as they were; the rule tries again later.
        () => setWatch(failed),
      );
    }, delay);
    return () => clearTimeout(timer);
  }, [watch, client]);

  useEffect(() => {
    const onChange = (): void => setWatch((w) => tabShown(w, tabIsVisible()));
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  useEffect(() => {
    const nudge = (): void => setWatch(wanted);
    nudges.add(nudge);
    return () => {
      nudges.delete(nudge);
    };
  }, []);

  const sectionRef = useCallback((element: HTMLElement) => {
    // Without IntersectionObserver (an old browser), the lists count as on
    // screen whenever they are on the page.
    if (typeof IntersectionObserver !== 'function') {
      setWatch((w) => seen(w, true));
      return () => setWatch((w) => seen(w, false));
    }
    // The root is cut by a pixel at the top and bottom: a box that only
    // touches the screen's edge counts as intersecting, and on a computer
    // the section starts exactly at the bottom edge, out of sight.
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last) setWatch((w) => seen(w, last.isIntersecting));
      },
      { rootMargin: '-1px 0px' },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      setWatch((w) => seen(w, false));
    };
  }, []);

  return { wins, sectionRef };
}
