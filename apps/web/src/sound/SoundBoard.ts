/**
 * The game's speaker: one Web Audio context, the on/off switch, and a
 * safety limiter. What each cue sounds like is in voices.ts.
 *
 * Browsers only allow audio after the player has clicked or pressed a key,
 * so the app calls unlock() from its first click or key press.
 */

import type { Cue } from './cues';
import { drawCue, makeNoise } from './voices';

const MUTED_KEY = 'pump.sound.muted';
const MASTER_VOLUME = 0.5;

function readMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
  } catch {
    // Private mode or storage blocked: the setting lasts for this visit only.
  }
}

export class SoundBoard {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private mutedNow: boolean = readMuted();

  get muted(): boolean {
    return this.mutedNow;
  }

  setMuted(muted: boolean): void {
    this.mutedNow = muted;
    writeMuted(muted);
    if (this.master && this.context) {
      this.master.gain.setValueAtTime(muted ? 0 : MASTER_VOLUME, this.context.currentTime);
    }
  }

  /**
   * Call from a tap, click or key handler, so the browser lets sound start.
   * On phones a tap only counts when the finger lifts (touchend, pointerup,
   * click), so the app calls this from those too. Safe to call often.
   */
  unlock(): void {
    const context = this.ensureContext();
    this.wake(context);
  }

  /**
   * Plays a cue. `height` (0 to 1) is how far up its ladder the balloon is;
   * `delay` is in seconds.
   */
  play(cue: Cue, height = 0, delay = 0): void {
    if (this.mutedNow) return;
    const context = this.ensureContext();
    if (!context || !this.master) return;
    if (context.state !== 'running') {
      // Suspended by the browser, or interrupted by a phone call on iOS.
      // Ask to resume and skip this one cue; a late sound would be confusing.
      this.wake(context);
      return;
    }
    const now = context.currentTime + 0.005 + Math.max(0, delay);
    drawCue(this.master, now, cue, height, this.noiseFor(context));
  }

  /** Resumes a context that isn't running. A refusal is expected outside a gesture. */
  private wake(context: AudioContext | null): void {
    if (!context || context.state === 'running' || context.state === 'closed') return;
    context.resume().catch(() => {
      // Not allowed yet: the next tap or key press tries again.
    });
  }

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    if (typeof AudioContext === 'undefined') return null;
    try {
      const context = new AudioContext();
      const master = context.createGain();
      master.gain.value = this.mutedNow ? 0 : MASTER_VOLUME;
      // A safety limit. One cue on its own never reaches it; when three
      // balloons and auto-play stack cues on top of each other, the peaks
      // are squeezed instead of crackling.
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 6;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.12;
      master.connect(limiter).connect(context.destination);
      this.context = context;
      this.master = master;
      return context;
    } catch {
      return null;
    }
  }

  /** The shared white noise, made once for this context. */
  private noiseFor(context: AudioContext): AudioBuffer {
    this.noise ??= makeNoise(context);
    return this.noise;
  }
}

/** The one sound board the app uses. Makes no sound until unlocked. */
export const soundBoard = new SoundBoard();
