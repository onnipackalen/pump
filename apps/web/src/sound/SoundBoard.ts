/**
 * Game sounds, made in the browser with the Web Audio API. No sound files:
 * every cue is a few oscillators or a burst of noise, a fraction of a
 * second long.
 *
 * Browsers only allow audio after the player has clicked or pressed a key,
 * so the app calls unlock() from its first click or key press.
 */

import type { Cue } from './cues';

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

  /** Plays a cue. `height` (0 to 1) is how far up its ladder the balloon is. */
  play(cue: Cue, height = 0): void {
    if (this.mutedNow) return;
    const context = this.ensureContext();
    if (!context || !this.master) return;
    if (context.state !== 'running') {
      // Suspended by the browser, or interrupted by a phone call on iOS.
      // Ask to resume and skip this one cue; a late sound would be confusing.
      this.wake(context);
      return;
    }
    const now = context.currentTime + 0.005;
    const out = this.master;
    // Pitch climbs one and a half octaves from the bottom of the ladder to the top.
    const climb = 2 ** (1.5 * Math.min(1, Math.max(0, height)));

    switch (cue) {
      case 'start':
        this.tone(out, now, 660, 660, 0.04, 0.05, 'sine');
        break;
      case 'press':
        this.puff(out, now, 450 * climb, 0.09, 0.09);
        break;
      case 'survive':
        this.tone(out, now, 420 * climb, 560 * climb, 0.09, 0.07, 'triangle');
        break;
      case 'saved':
        this.tone(out, now, 220, 220, 0.07, 0.08, 'triangle');
        this.tone(out, now + 0.08, 330, 330, 0.09, 0.07, 'triangle');
        break;
      case 'pop':
        // Quiet on purpose: a loss gets a short, soft pop and nothing more.
        this.puff(out, now, 700, 0.06, 0.07, 'lowpass');
        break;
      case 'return':
        this.tone(out, now, 520, 520, 0.05, 0.04, 'sine');
        break;
      case 'win':
        this.chime(out, now, [880, 1318.5]);
        break;
      case 'top-win':
        this.chime(out, now, [880, 1108.7, 1318.5, 1760]);
        break;
    }
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
      master.connect(context.destination);
      this.context = context;
      this.master = master;
      return context;
    } catch {
      return null;
    }
  }

  /** One oscillator gliding from `from` to `to` Hz, with a quick fade out. */
  private tone(
    out: AudioNode,
    at: number,
    from: number,
    to: number,
    seconds: number,
    volume: number,
    type: OscillatorType,
  ): void {
    const context = out.context;
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, at);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, at + seconds);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    osc.connect(gain).connect(out);
    osc.start(at);
    osc.stop(at + seconds + 0.02);
  }

  /** A short burst of filtered noise: air through the pump, or a soft pop. */
  private puff(
    out: AudioNode,
    at: number,
    frequency: number,
    seconds: number,
    volume: number,
    filterType: BiquadFilterType = 'bandpass',
  ): void {
    const context = out.context;
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer(context);
    const filter = context.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(frequency, at);
    filter.Q.value = filterType === 'bandpass' ? 1.2 : 0.7;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    source.connect(filter).connect(gain).connect(out);
    source.start(at);
    source.stop(at + seconds + 0.02);
  }

  /** Bright notes one after another: the win sound. */
  private chime(out: AudioNode, at: number, notes: readonly number[]): void {
    notes.forEach((frequency, i) => {
      const start = at + i * 0.07;
      this.tone(out, start, frequency, frequency, 0.32, 0.11, 'triangle');
      this.tone(out, start, frequency * 2, frequency * 2, 0.18, 0.03, 'sine');
    });
  }

  /** Half a second of white noise, made once and reused. */
  private noiseBuffer(context: BaseAudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const buffer = context.createBuffer(1, Math.floor(context.sampleRate * 0.5), context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    this.noise = buffer;
    return buffer;
  }
}

/** The one sound board the app uses. Makes no sound until unlocked. */
export const soundBoard = new SoundBoard();
