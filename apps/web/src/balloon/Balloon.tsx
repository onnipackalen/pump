import type { CSSProperties } from 'react';
import './balloon.css';
import './balloon-states.css';

/**
 * The balloon picture, from graphics/balloon/balloon.svg. Its layers and
 * class names must stay as the graphics README describes; the CSS in
 * balloon.css drives them.
 */
export interface BalloonProps {
  /** 1, 2 or 3: picks the colour and the number on the tag. */
  readonly slot: number;
  /** 0.45 before the first pump, 1 at the balloon's top rung. */
  readonly scale: number;
  /** "press" while a pump waits for the server, "survive" when it lived. */
  readonly beat?: 'press' | 'survive' | undefined;
  /** Set once the balloon is over. */
  readonly end?: 'popped' | 'cashed' | undefined;
}

export function Balloon({ slot, scale, beat, end }: BalloonProps) {
  const style = { '--balloon-scale': scale.toFixed(4) } as CSSProperties;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 200 320"
      className="pump-balloon"
      data-slot={slot}
      data-beat={beat}
      data-end={end}
      role="img"
      aria-label={`Balloon ${slot}`}
      style={style}
    >
      <defs>
        <radialGradient id="pb-shade" cx="0.4" cy="0.36" r="0.72" fx="0.3" fy="0.22">
          <stop offset="0" className="pb-shade-a" />
          <stop offset="0.42" className="pb-shade-b" />
          <stop offset="0.62" className="pb-shade-c" />
          <stop offset="1" className="pb-shade-d" />
        </radialGradient>
      </defs>

      <ellipse className="pb-shadow" cx="100" cy="315" rx="30" ry="4" />

      <g className="pb-float">
        <g className="pb-grow">
          <g className="pb-wobble">
            <g className="pb-squash">
              <path
                className="pb-body"
                d="M100 208C82 206 28 166 28 100C28 52 60 22 100 22C140 22 172 52 172 100C172 166 118 206 100 208Z"
              />
              <path
                className="pb-shade"
                fill="url(#pb-shade)"
                d="M100 208C82 206 28 166 28 100C28 52 60 22 100 22C140 22 172 52 172 100C172 166 118 206 100 208Z"
              />
              <path className="pb-rim" d="M163 118C160 156 132 190 108 201C128 186 153 158 163 118Z" />
              <path
                className="pb-shine"
                d="M47 96C45 66 61 42 85 33C70 47 60 68 58 93C57.5 101 47.5 102 47 96Z"
              />
              <ellipse className="pb-glint" cx="99" cy="33" rx="7" ry="4" />
              <g className="pb-patch" />
            </g>
          </g>
          <path
            className="pb-knot"
            d="M100 205C96 209 92.5 214 91 219.5Q100 217 109 219.5C107.5 214 104 209 100 205Z"
          />
          <ellipse className="pb-knot" cx="100" cy="220" rx="9.5" ry="2.6" />
          <g className="pb-shards" />
        </g>
        <g className="pb-swing">
          <path
            className="pb-string"
            d="M100 222C94 236 106 249 100 262C97.5 268 99 274 100 279"
          />
          <g className="pb-tag">
            <rect className="pb-tag-card" x="81" y="278" width="38" height="32" rx="7" />
            <text className="pb-tag-text" x="100" y="302">
              {slot}
            </text>
          </g>
        </g>
      </g>
    </svg>
  );
}

/**
 * How big the balloon is drawn. It grows by the same step each time the
 * multiplier doubles, and fills its box at the top reachable rung. Size
 * shows value only, never risk. Display only, so floats are fine here.
 */
export function balloonScale(multiplierHundredths: number | null, topHundredths: number): number {
  if (multiplierHundredths === null || topHundredths <= 100) return 0.45;
  const progress = Math.log(multiplierHundredths / 100) / Math.log(topHundredths / 100);
  return 0.45 + 0.55 * Math.min(1, Math.max(0, progress));
}
