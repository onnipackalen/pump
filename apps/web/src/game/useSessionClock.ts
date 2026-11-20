import { useEffect, useState } from 'react';

/** Milliseconds since `startedAt`, updated once a second. */
export function useSessionClock(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return startedAt === null ? 0 : now - startedAt;
}
