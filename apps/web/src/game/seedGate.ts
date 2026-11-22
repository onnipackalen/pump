/**
 * Keeps a round start and a seed change (saving a client seed, rotating the
 * server seed) from being on their way at the same time.
 *
 * Why: a round start saves the seeds on screen as the bet goes out, for the
 * verify page (startRoundShown in session.ts). Say the player saves a new
 * client seed and presses Bet before that answer is back. The server applies
 * the seed change first and plays the round on the new seed, but the screen
 * still shows the old one, so the old one is saved. The verify page would
 * then call an honest round a mismatch. And two requests on their way at
 * once may even reach the server in either order.
 *
 * So:
 * - a start waits for a seed change on its way, then reads the seeds on
 *   screen. If that change failed, the screen may be behind the server, so
 *   no round is started;
 * - a seed change is refused while a start, or another seed change, is on
 *   its way. Nothing is sent then.
 *
 * Plain code, no React, so it can be tested; useGame holds one.
 */
export class SeedGate {
  private change: Promise<boolean> | null = null;
  private starts = 0;

  /**
   * Runs a seed change. `work` sends it, puts its answer on screen and
   * resolves true if it went through. Null, with nothing sent, while a start
   * or another change is on its way.
   */
  changeSeeds(work: () => Promise<boolean>): Promise<boolean> | null {
    if (this.starts > 0 || this.change !== null) return null;
    const change = work().catch(() => false);
    this.change = change;
    void change.then(() => {
      if (this.change === change) this.change = null;
    });
    return change;
  }

  /**
   * Runs a round start. `work` reads the seeds on screen and sends the
   * start. It runs once any seed change on its way is done; if that change
   * failed, it does not run, and this gives null.
   */
  async start<T>(work: () => Promise<T>): Promise<T | null> {
    this.starts += 1;
    try {
      const change = this.change;
      if (change !== null && !(await change)) return null;
      return await work();
    } finally {
      this.starts -= 1;
    }
  }
}
