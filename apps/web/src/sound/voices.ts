/**
 * What each cue sounds like. Every sound is built here from oscillators and
 * filtered white noise (Web Audio), a fraction of a second long. No sound
 * files.
 *
 * This file only draws sounds into an audio graph. SoundBoard owns the
 * speaker and the on/off switch. Kept apart so a cue can also be drawn into an
 * offline graph and measured (length, loudness) without playing it.
 *
 * The rules from cues.ts hold here too:
 * - Tension rises: the pump whoosh and the stretch squeak climb in pitch
 *   with `height`, one and a half octaves from the bottom of the ladder to
 *   the top.
 * - Losses are quiet: the pop is one short, soft burst with nothing after it.
 * - Money back is neutral: the return tick is a plain wooden tick. Only the
 *   two win cues use bells.
 */

import type { Cue } from './cues';

/** Exponential ramps can't reach 0, so "silent" is this. */
const SILENT = 0.0001;

/** How long the shared noise buffer is, in seconds. Longer than any hiss. */
const NOISE_SECONDS = 0.5;

interface ToneShape {
  readonly type: OscillatorType;
  /** Start pitch in Hz. */
  readonly from: number;
  /** End pitch in Hz; the tone glides there. Leave out for a steady pitch. */
  readonly to?: number;
  readonly seconds: number;
  readonly volume: number;
  /** Seconds to reach full volume. */
  readonly attack?: number;
}

interface HissShape {
  readonly filter: BiquadFilterType;
  /** Filter frequency at the start, in Hz. */
  readonly from: number;
  /** Filter frequency at the end; the hiss sweeps there. */
  readonly to?: number;
  /** How narrow the filter is. Higher is more whistly. */
  readonly q?: number;
  readonly seconds: number;
  readonly volume: number;
  readonly attack?: number;
}

/**
 * Draws one cue into `out`, starting at `at` (seconds on out's clock).
 * `height` (0 to 1) is how far up its ladder the balloon is.
 */
export function drawCue(
  out: AudioNode,
  at: number,
  cue: Cue,
  height: number,
  noise: AudioBuffer,
): void {
  const climb = 2 ** (1.5 * Math.min(1, Math.max(0, height)));

  switch (cue) {
    case 'start':
      // The flat balloon lands on the floor: a soft rubber flop.
      tone(out, at, { type: 'sine', from: 170, to: 95, seconds: 0.14, volume: 0.06 });
      hiss(out, at, noise, { filter: 'lowpass', from: 900, seconds: 0.05, volume: 0.03 });
      break;

    case 'press':
      // Air pushed through the pump: a whoosh that rises as the stroke goes
      // down, a thin hiss of air on top, and a soft thud at the bottom of
      // the stroke (the shortest press lasts 0.3 s, so all of it fits).
      hiss(out, at, noise, {
        filter: 'bandpass',
        from: 420 * climb,
        to: 1300 * climb,
        q: 1.6,
        attack: 0.05,
        seconds: 0.22,
        volume: 0.1,
      });
      hiss(out, at, noise, {
        filter: 'highpass',
        from: 4000,
        attack: 0.05,
        seconds: 0.18,
        volume: 0.02,
      });
      tone(out, at + 0.19, { type: 'sine', from: 120, to: 70, seconds: 0.06, volume: 0.05 });
      break;

    case 'survive':
      // The rubber stretches as the air goes in: a short squeak that sits
      // higher the fuller the balloon is.
      squeak(out, at, 320 * climb, 450 * climb, 0.15, 0.12);
      break;

    case 'saved':
      // The Patch slaps on and holds: a tape thwack, then two calm notes,
      // low then a little higher. Relief, not a win: no bells.
      hiss(out, at, noise, {
        filter: 'lowpass',
        from: 1600,
        attack: 0.002,
        seconds: 0.07,
        volume: 0.1,
      });
      tone(out, at, { type: 'sine', from: 170, to: 90, seconds: 0.08, volume: 0.07 });
      tone(out, at + 0.09, { type: 'triangle', from: 294, seconds: 0.16, volume: 0.065 });
      tone(out, at + 0.17, { type: 'triangle', from: 392, seconds: 0.2, volume: 0.06 });
      break;

    case 'pop':
      // Quiet on purpose: a loss gets one short, soft burst and nothing more.
      // A crisp crack of high noise, a duller puff under it, and the thump
      // of the air going out, all gone in about a tenth of a second. It is
      // the quietest cue in the game, quieter than the neutral tick.
      hiss(out, at, noise, {
        filter: 'highpass',
        from: 1100,
        attack: 0.001,
        seconds: 0.08,
        volume: 0.026,
      });
      hiss(out, at, noise, {
        filter: 'lowpass',
        from: 600,
        attack: 0.002,
        seconds: 0.11,
        volume: 0.018,
      });
      tone(out, at, { type: 'sine', from: 150, to: 45, seconds: 0.09, volume: 0.018 });
      break;

    case 'return':
      // Money back, or one balloon of a round collected: a plain wooden
      // tick. Neutral on purpose, so it never sounds like a win.
      tone(out, at, {
        type: 'sine',
        from: 760,
        to: 620,
        seconds: 0.07,
        volume: 0.05,
        attack: 0.003,
      });
      hiss(out, at, noise, {
        filter: 'bandpass',
        from: 2600,
        q: 3,
        attack: 0.001,
        seconds: 0.02,
        volume: 0.03,
      });
      break;

    case 'win':
      // A round that paid back more than it cost: two bright bells, a fifth
      // apart (A5, E6).
      chime(out, at, [880, 1318.5], 0.55);
      break;

    case 'big-win':
      // A tier 3 win: four bells up an A major chord (A5, C#6, E6, A6), the
      // last one ringing longer, and a few tiny high bells after it.
      chime(out, at, [880, 1108.7, 1318.5, 1760], 0.9);
      sparkle(out, at + 0.3);
      break;
  }
}

/** Half a second of white noise, the raw air for every hiss. Make it once per context. */
export function makeNoise(context: BaseAudioContext): AudioBuffer {
  const length = Math.floor(context.sampleRate * NOISE_SECONDS);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** A gain that rises to `peak` in `attack` seconds, then dies away by `seconds`. */
function envelope(
  context: BaseAudioContext,
  at: number,
  attack: number,
  peak: number,
  seconds: number,
): GainNode {
  const gain = context.createGain();
  gain.gain.setValueAtTime(SILENT, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(SILENT, at + seconds);
  return gain;
}

/** One oscillator, steady or gliding, with a quick fade in and a fade out. */
function tone(out: AudioNode, at: number, shape: ToneShape): void {
  const context = out.context;
  const osc = context.createOscillator();
  osc.type = shape.type;
  osc.frequency.setValueAtTime(shape.from, at);
  if (shape.to !== undefined && shape.to !== shape.from) {
    osc.frequency.exponentialRampToValueAtTime(shape.to, at + shape.seconds);
  }
  const gain = envelope(context, at, shape.attack ?? 0.008, shape.volume, shape.seconds);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + shape.seconds + 0.03);
}

/** White noise through one filter: air, a crack, a slap. */
function hiss(out: AudioNode, at: number, noise: AudioBuffer, shape: HissShape): void {
  const context = out.context;
  const source = context.createBufferSource();
  source.buffer = noise;
  const filter = context.createBiquadFilter();
  filter.type = shape.filter;
  filter.frequency.setValueAtTime(shape.from, at);
  if (shape.to !== undefined && shape.to !== shape.from) {
    filter.frequency.exponentialRampToValueAtTime(shape.to, at + shape.seconds);
  }
  filter.Q.value = shape.q ?? (shape.filter === 'bandpass' ? 1.2 : 0.7);
  const gain = envelope(context, at, shape.attack ?? 0.01, shape.volume, shape.seconds);
  source.connect(filter).connect(gain).connect(out);
  // Start somewhere different in the noise each time, so repeated pumps
  // don't sound copy-pasted. Sound only: nothing in the game reads this.
  const room = Math.max(0, noise.duration - shape.seconds - 0.05);
  source.start(at, Math.random() * room);
  source.stop(at + shape.seconds + 0.03);
}

/**
 * Rubber being stretched. A buzzy (sawtooth) tone, shaped by a narrow filter
 * into a squeak, with a fast small wobble in pitch for the grain of the
 * rubber, and a soft plain tone under it for body.
 */
function squeak(
  out: AudioNode,
  at: number,
  from: number,
  to: number,
  seconds: number,
  volume: number,
): void {
  const context = out.context;
  const glideEnd = at + seconds * 0.8;

  const osc = context.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, glideEnd);

  const wobble = context.createOscillator();
  wobble.frequency.value = 31;
  const depth = context.createGain();
  depth.gain.value = from * 0.025;
  wobble.connect(depth);
  depth.connect(osc.frequency);

  const filter = context.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(from * 2.5, at);
  filter.frequency.exponentialRampToValueAtTime(to * 2.5, glideEnd);
  filter.Q.value = 2.5;

  const gain = envelope(context, at, 0.02, volume, seconds);
  osc.connect(filter).connect(gain).connect(out);
  osc.start(at);
  wobble.start(at);
  osc.stop(at + seconds + 0.03);
  wobble.stop(at + seconds + 0.03);

  tone(out, at, { type: 'triangle', from, to, seconds, volume: volume * 0.5, attack: 0.02 });
}

/**
 * One struck bell. A small metal bar rings at a few pitches at once (1, 2.76
 * and 5.4 times the note), and the high ones die first.
 */
function bell(out: AudioNode, at: number, frequency: number, volume: number, ring: number): void {
  const partials: readonly (readonly [ratio: number, level: number, ringShare: number])[] = [
    [1, 1, 1],
    [2.76, 0.32, 0.4],
    [5.4, 0.12, 0.2],
  ];
  for (const [ratio, level, ringShare] of partials) {
    tone(out, at, {
      type: 'sine',
      from: frequency * ratio,
      seconds: ring * ringShare,
      volume: volume * level,
      attack: 0.004,
    });
  }
}

/** Bells one after another, the last one ringing longest, over a soft low note. */
function chime(out: AudioNode, at: number, notes: readonly number[], ring: number): void {
  notes.forEach((frequency, i) => {
    const last = i === notes.length - 1;
    bell(out, at + i * 0.075, frequency, 0.1, last ? ring : ring * 0.6);
  });
  const [root] = notes;
  if (root !== undefined) {
    tone(out, at, {
      type: 'triangle',
      from: root / 2,
      seconds: ring,
      volume: 0.035,
      attack: 0.02,
    });
  }
}

/** A few tiny, quiet high bells (notes of A major), for the big win only. */
function sparkle(out: AudioNode, at: number): void {
  const taps: readonly (readonly [after: number, frequency: number])[] = [
    [0, 3520],
    [0.07, 2637],
    [0.15, 4434.9],
    [0.23, 3520],
  ];
  for (const [after, frequency] of taps) bell(out, at + after, frequency, 0.025, 0.25);
}
