import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import './balloon.css';
import './balloon-app.css';
import {
  FLAT,
  HOSE_FALL_MS,
  HOSE_LIFT_MS,
  hoseAt,
  hoseFrame,
  hoseLies,
  hosePath,
  LYING,
  STAND,
  STANDING,
  tipTransform,
  type HosePose,
  type Point,
} from './hoseShape';

/**
 * The balloon picture. This file and balloon.css are the originals of the
 * art; there is no other copy. balloon.css drives every layer by its class
 * name, so the markup and the class names must stay in step with it.
 *
 * This component only sets attributes. Which ones the game uses, and when,
 * is decided in BalloonCard.
 */

/** The hose standing and lying (hoseShape.ts), as path lines. */
const STAND_LINE = hosePath(STAND);
const FLAT_LINE = hosePath(FLAT);
const FLAT_TIP = tipTransform(FLAT);

/** data-beat values: each is one moment the art can show. */
export type BalloonBeat =
  | 'press'
  | 'survive'
  | 'blocked'
  | 'pop'
  | 'popped'
  | 'cashout'
  | 'cashed';

/**
 * The difficulty, as the pump shows it: rings round the foot of the barrel
 * in the difficulty's colour, one ring per level (game/level.ts picks both).
 */
export interface BalloonLevel {
  /** The difficulty's id, set as data-level. */
  readonly id: string;
  /** Any CSS colour. */
  readonly colour: string;
  /** How many rings: 0 to LEVEL_RINGS.length. */
  readonly marks: number;
}

/**
 * Where the rings go, from the bottom up: 2 tall, 1.2 apart, all of them
 * on the barrel between the pump's foot and its number dial.
 */
const LEVEL_RINGS = [299.2, 296, 292.8, 289.6] as const;

export interface BalloonProps {
  /** 1, 2 or 3: picks the colour and the number on the pump. */
  readonly slot: number;
  /** The difficulty, shown on the pump. Leave it out to show none. */
  readonly level?: BalloonLevel | undefined;
  /** 0.45 before the first pump, 1 at the balloon's top rung. */
  readonly scale: number;
  readonly beat?: BalloonBeat | undefined;
  /** 0 to 3, from the published next-pop chance only. */
  readonly strain?: number | undefined;
  /** The Patch sticker on a patched pump. */
  readonly patch?: 'on' | 'spent' | 'torn' | undefined;
  /** Win tier 1 to 3, only for a real gain. */
  readonly win?: 1 | 2 | 3 | undefined;
  /** Reached its top rung, only together with `win`. */
  readonly top?: boolean | undefined;
  /**
   * Its own cash-out ended the round in a real win, so it waits a moment
   * before it floats away (--pb-release-delay). Set once, when the cash-out
   * motion starts, and never added later: that would restart a float that
   * is already on its way.
   */
  readonly hold?: boolean | undefined;
  /** "up": the handle comes back up, for the pump that reached the top. */
  readonly stroke?: 'up' | undefined;
  /**
   * What was in this balloon's place before its round began, on a balloon
   * of a new round only: its pump sets up from that picture (balloon.css,
   * Set-up). "idle" is the picture before any bet (or no balloon there),
   * "void" a refunded balloon still lying flat. Only while the balloon
   * waits for its first answer; leave it out from that answer on.
   */
  readonly setUp?: 'idle' | 'popped' | 'cashed' | 'void' | undefined;
  /**
   * The first pump (balloon.css, First pump). "floor": in play and not yet
   * pumped, so the small flat balloon lies on the floor. "lift": the first
   * pump just held, so the hose lifts it and it blows up (keep it for the
   * whole lift, game/setUp.ts FIRST_LIFT_MS). "floor-popped": the first pump
   * popped it on the floor. "floor-void": its bet was refunded unpumped, so
   * it stays flat on the floor. Leave it out otherwise.
   */
  readonly first?: 'floor' | 'lift' | 'floor-popped' | 'floor-void' | undefined;
  /** The picture before any bet: the hose on the floor, no balloon. */
  readonly idle?: boolean | undefined;
  /**
   * The multiplier printed on the balloon, like "1.37×". Empty before the
   * first pump: an unpumped balloon has no multiplier yet.
   */
  readonly value?: string | undefined;
}

/** The balloon's outline. The depth and strain layers reuse it, so they never spill past the edge. */
const BODY_PATH =
  'M100 208C82 206 28 166 28 100C28 52 60 22 100 22C140 22 172 52 172 100C172 166 118 206 100 208Z';

export function Balloon({
  slot,
  level,
  scale,
  beat,
  strain,
  patch,
  win,
  top,
  hold,
  stroke,
  setUp,
  first,
  idle,
  value,
}: BalloonProps) {
  const style = {
    '--balloon-scale': scale.toFixed(4),
    ...(level ? { '--pb-level': level.colour } : {}),
  } as CSSProperties;
  const marks = level ? Math.max(0, Math.min(level.marks, LEVEL_RINGS.length)) : 0;
  const rings = LEVEL_RINGS.slice(0, marks);
  const lying = hoseLies({ beat, first, idle });
  const hose = useHoseMotion(lying, beat);
  const line = lying ? FLAT_LINE : STAND_LINE;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 200 320"
      className="pump-balloon"
      data-slot={slot}
      data-level={level?.id}
      data-beat={beat}
      data-strain={strain}
      data-patch={patch}
      data-win={win}
      data-top={win !== undefined && top ? 'true' : undefined}
      data-hold={hold ? 'true' : undefined}
      data-stroke={stroke}
      data-setup={setUp}
      data-first={first}
      data-idle={idle ? 'true' : undefined}
      role="img"
      aria-label={`Balloon ${slot}`}
      style={style}
    >
      <defs>
        {/* Light from the top left, darker towards the edges. White and black
             only, so it works on every balloon colour. */}
        <radialGradient id="pb-shade" cx="0.4" cy="0.36" r="0.72" fx="0.3" fy="0.22">
          <stop offset="0" className="pb-shade-a" />
          <stop offset="0.42" className="pb-shade-b" />
          <stop offset="0.62" className="pb-shade-c" />
          <stop offset="1" className="pb-shade-d" />
        </radialGradient>
        {/* Depth: darker towards the bottom of the balloon. */}
        <linearGradient id="pb-core-fade" gradientUnits="userSpaceOnUse" x1="0" y1="110" x2="0" y2="208">
          <stop offset="0" className="pb-core-a" />
          <stop offset="1" className="pb-core-b" />
        </linearGradient>
        {/* Neck: darker where it is pinched into the balloon and at the lip. */}
        <linearGradient id="pb-neck-fade" gradientUnits="userSpaceOnUse" x1="0" y1="203" x2="0" y2="221">
          <stop offset="0" className="pb-neck-fade-a" />
          <stop offset="0.5" className="pb-neck-fade-b" />
          <stop offset="1" className="pb-neck-fade-c" />
        </linearGradient>
        {/* Strain sheen: how far the stretched, paler patch reaches, as a
             mask (white shows, black hides). It fades to nothing, with no
             edge, so it can't read as a dent. */}
        <radialGradient
          id="pb-sheen-fade"
          gradientUnits="userSpaceOnUse"
          cx="132"
          cy="56"
          r="70"
          gradientTransform="rotate(-32 132 56) scale(1 0.72) translate(0 22)"
        >
          <stop offset="0" className="pb-sheen-fade-a" />
          <stop offset="0.55" className="pb-sheen-fade-b" />
          <stop offset="1" className="pb-sheen-fade-c" />
        </radialGradient>
        <mask id="pb-sheen-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="320">
          <rect x="0" y="0" width="200" height="320" fill="url(#pb-sheen-fade)" />
        </mask>
        {/* Strain band: the bright light along the stretched upper-right curve. */}
        <linearGradient id="pb-band-fade" gradientUnits="userSpaceOnUse" x1="104" y1="28" x2="166" y2="96">
          <stop offset="0" className="pb-band-a" />
          <stop offset="0.45" className="pb-band-b" />
          <stop offset="1" className="pb-band-c" />
        </linearGradient>
        {/* Latex: the balloon's own deeper colour builds towards the bottom,
             where the rubber is thicker. A mask, so the colour comes from
             the fill and the id can repeat. */}
        <linearGradient id="pb-deep-fade" gradientUnits="userSpaceOnUse" x1="0" y1="118" x2="0" y2="208">
          <stop offset="0" className="pb-deep-fade-a" />
          <stop offset="1" className="pb-deep-fade-b" />
        </linearGradient>
        <mask id="pb-deep-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="320">
          <rect x="0" y="0" width="200" height="320" fill="url(#pb-deep-fade)" />
        </mask>
        {/* Latex: the broad, soft light of the window on the upper left. */}
        <radialGradient
          id="pb-soft-light"
          gradientUnits="userSpaceOnUse"
          cx="72"
          cy="72"
          r="46"
          gradientTransform="translate(72 72) rotate(-24) scale(0.74 1) translate(-72 -72)"
        >
          <stop offset="0" className="pb-soft-light-a" />
          <stop offset="1" className="pb-soft-light-b" />
        </radialGradient>
        <clipPath id="pb-body-clip">
          <path d={BODY_PATH} />
        </clipPath>
      </defs>

      {/* scene: the whole drawing, so a new balloon's pump can be shown a
           little closer and ease back out (balloon.css, First pump). The
           zoom is anchored at the right edge of the pump's shadow, so the
           drawing never passes 14% or 87% of the width. */}
      <g className="pb-scene">
        {/* Shadow on the floor, under the pump. */}
        <ellipse className="pb-shadow" cx="142" cy="314" rx="32" ry="4" />

        {/* pump: the floor pump for this balloon. The slot number sits on it,
             so balloons never rely on colour alone. */}
        <g className="pb-pump">
          <rect className="pb-pump-base" x="116" y="305" width="52" height="6" rx="3" />
          {/* handle: pushes down on each tap. Drawn before the barrel, which
               hides the rod as it goes in. */}
          <g className="pb-handle">
            <rect className="pb-pump-rod" x="139.5" y="224" width="5" height="26" />
            <rect className="pb-pump-grip" x="124" y="220" width="36" height="7" rx="3.5" />
          </g>
          <rect className="pb-pump-nozzle" x="115" y="291" width="20" height="8" rx="2" />
          <rect className="pb-pump-cap" x="130" y="242" width="24" height="5" rx="2.5" />
          <rect className="pb-pump-barrel" x="132" y="245" width="20" height="60" rx="4" />
          {/* level: the difficulty, as rings round the foot of the barrel in
               its own colour: one for the first difficulty, up to four, so
               it is never told by colour alone. Under the shine, so they
               wrap the barrel like it. Nothing here moves. */}
          {rings.length > 0 && (
            <g className="pb-level">
              {rings.map((y) => (
                <rect key={y} className="pb-level-ring" x="132" y={y} width="20" height="2" />
              ))}
            </g>
          )}
          <rect className="pb-pump-shine" x="135" y="249" width="3.5" height="52" rx="1.75" />
          {/* tag: the slot number, on the pump's gauge dial. */}
          <g className="pb-tag">
            <circle className="pb-tag-card" cx="142" cy="273" r="13" />
            <text className="pb-tag-text" x="142" y="280">
              {slot}
            </text>
          </g>
        </g>

        {/* hose: from the pump into the neck. It stands while a balloon is
             on it and lies on the floor otherwise: before any bet, while a
             new balloon waits for its first pump, and after a pop or a
             cash-out. Between the two it bends as one line (hoseShape.ts,
             useHoseMotion below): every line marked data-hose-line gets the
             same shape on every frame. */}
        <g className="pb-hose" ref={hose}>
          <path className="pb-hose-tube" data-hose-line="" d={line} />
          <path className="pb-hose-shine" data-hose-line="" d={line} />
          {/* air: the pocket of air that runs along the hose on each tap. It is
               the hose itself swelling: short, thick pieces of the hose's own
               line, stacked from long and thin to short and fat, so together
               they make a bulge that tapers into the hose and bends where it
               bends. balloon.css slides them along the line. They are hose
               lines too, so the pocket runs along whatever shape the hose
               has: lying on the floor for a new balloon's first pump, and
               falling with it on a pop. Hidden until a press. */}
          <g className="pb-air">
            <defs>
              {/* Soft edges for the pale middle, so it shades smoothly instead of
                   showing as hard-edged stripes. Fixed frame around the hose,
                   standing or lying: a frame from the path's own box would
                   clip the blur. */}
              <filter id="pb-air-soft" filterUnits="userSpaceOnUse" x="30" y="190" width="115" height="130">
                <feGaussianBlur stdDeviation="1.3" />
              </filter>
              <filter id="pb-air-softer" filterUnits="userSpaceOnUse" x="30" y="190" width="115" height="130">
                <feGaussianBlur stdDeviation="0.6" />
              </filter>
            </defs>
            <path className="pb-air-wall pb-air-1" data-hose-line="" d={line} />
            <path className="pb-air-wall pb-air-2" data-hose-line="" d={line} />
            <path className="pb-air-wall pb-air-3" data-hose-line="" d={line} />
            <path className="pb-air-wall pb-air-4" data-hose-line="" d={line} />
            <path className="pb-air-wall pb-air-5" data-hose-line="" d={line} />
            <path className="pb-air-wall pb-air-6" data-hose-line="" d={line} />
            <path className="pb-air-thin" data-hose-line="" d={line} />
            <path className="pb-air-core" data-hose-line="" d={line} />
            <path className="pb-air-shine" data-hose-line="" d={line} />
          </g>
          {/* tip: what sits on the hose's end. Drawn on the standing hose's
               end at (100, 227); carried to wherever the end is, turned the
               way the hose points there. */}
          <g className="pb-hose-tip" transform={lying ? FLAT_TIP : undefined}>
            {/* limp: the new balloon before its first pump: small, flat, not
                 blown up, coming straight out of the fitting and pointing the
                 way the hose points (the user: "make baloon in direction of
                 nozzle"). Drawn on the standing hose's end, where the blown-up
                 balloon's neck will be, so the blow-up starts from it. When the
                 hose lies on the floor it lies on the floor in line with it,
                 pointing left, its flat side down on the floor line; when the
                 first pump lifts the hose it comes up with it. Hidden unless a
                 balloon waits for its first pump. */}
            <g className="pb-limp">
              <path className="pb-limp-body" d="M98.4 221.8C97.8 218.4 97.6 214.6 98 212.4C98.4 210.8 100.6 210.6 102.2 211.6C104 212.8 104.4 215.8 103.8 218.4C103.4 220 102.6 221.2 101.6 221.8Z" />
              <path className="pb-limp-crease" d="M100.4 220.8C100.2 218.4 100.6 215.6 101.2 213.4" />
            </g>
            <rect className="pb-hose-end" x="96" y="221" width="8" height="7" rx="2" />
          </g>
        </g>

        {/* float: the balloon. Lifts and fades on cash-out. */}
        <g className="pb-float">
          {/* grow: balloon and knot. Scales to the size of the current rung. */}
          <g className="pb-grow">
            {/* glow: soft light behind the balloon on a real win. */}
            <g className="pb-glow">
              <defs>
                {/* Mint halo. Only ever shown on a real win. */}
                <radialGradient id="pb-win-glow">
                  <stop offset="0" className="pb-win-glow-a" />
                  <stop offset="0.72" className="pb-win-glow-b" />
                  <stop offset="0.86" className="pb-win-glow-c" />
                  <stop offset="1" className="pb-win-glow-d" />
                </radialGradient>
              </defs>
              {/* Bottom stays above y=222 even at its biggest, so the pivot never moves. */}
              <ellipse className="pb-glow-disc" fill="url(#pb-win-glow)" cx="100" cy="112" rx="96" ry="104" />
            </g>
            {/* ghost: faint outline left behind after a pop. Hidden until then. */}
            <path className="pb-ghost" d="M100 208C82 206 28 166 28 100C28 52 60 22 100 22C140 22 172 52 172 100C172 166 118 206 100 208Z" />
            {/* wobble: sways a little; more as the pop chance rises. */}
            <g className="pb-wobble">
              {/* squash: the short squeeze on each tap. */}
              <g className="pb-squash">
                <path className="pb-body" d="M100 208C82 206 28 166 28 100C28 52 60 22 100 22C140 22 172 52 172 100C172 166 118 206 100 208Z" />
                <path className="pb-shade" fill="url(#pb-shade)" d="M100 208C82 206 28 166 28 100C28 52 60 22 100 22C140 22 172 52 172 100C172 166 118 206 100 208Z" />
                {/* depth: the balloon's deeper colour towards the bottom, a
                     darker underside, and a little light bounced up along the
                     lower left edge, so it reads as round rubber. */}
                <path className="pb-deep" mask="url(#pb-deep-mask)" d={BODY_PATH} />
                <path className="pb-core" fill="url(#pb-core-fade)" d={BODY_PATH} />
                <path
                  className="pb-bounce"
                  clipPath="url(#pb-body-clip)"
                  d="M40 150C52 178 74 198 96 205C78 196 58 178 46 150Z"
                />
                {/* gather: the little creases where the rubber bunches into
                     the neck, each with a lit edge beside it. */}
                <g className="pb-gather" clipPath="url(#pb-body-clip)">
                  <path className="pb-gather-line" d="M87 198Q94 203 98.6 206.5M113 198Q106 203 101.4 206.5M93 192Q97 200 99.4 206.5M107 192Q103 200 100.6 206.5" />
                  <path className="pb-gather-light" d="M87.6 196.8Q94.6 201.8 99 205.4M93.9 191.4Q97.9 199.4 99.9 205.4" />
                </g>
                {/* soft light: the broad glow of the window on the upper left.
                     Drawn on the body's own outline (the gradient makes the
                     glow), so it can never reach past the balloon's edge. */}
                <path className="pb-soft-light" fill="url(#pb-soft-light)" d={BODY_PATH} />
                <path className="pb-rim" d="M163 118C160 156 132 190 108 201C128 186 153 158 163 118Z" />
                <path className="pb-shine" d="M47 96C45 66 61 42 85 33C70 47 60 68 58 93C57.5 101 47.5 102 47 96Z" />
                <ellipse className="pb-glint" cx="99" cy="33" rx="7" ry="4" />
                {/* value: the multiplier written on the balloon. Your code sets the
                     text; leave it empty before the first pump. */}
                <text className="pb-value" x="100" y="124">
                  {value}
                </text>
                {/* strain: the rubber over the upper right stretches thin as the pop
                     chance rises: it goes paler, with a bright band along the
                     curve. Soft to the edge, with no ring: the old oval spot had a
                     dark rim and read as a dent. The mask and band are black and
                     white only, so their ids can repeat on every balloon; the
                     colour comes from the fill (balloon.css). */}
                <g className="pb-strain">
                  <g className="pb-thin">
                    <path className="pb-sheen" mask="url(#pb-sheen-mask)" d={BODY_PATH} />
                    <path
                      className="pb-band"
                      fill="url(#pb-band-fade)"
                      clipPath="url(#pb-body-clip)"
                      d="M106 29C140 30 163 55 166 90C158 63 137 41 106 35Z"
                    />
                  </g>
                </g>
                {/* patch: the Patch sticker goes here. */}
                <g className="pb-patch">
                  {/* piece: the whole patch. Slaps on, peels off, or holds while it tears. */}
                  <g className="pb-patch-piece">
                    {/* Fixed tilt and size. Never animate this group; animate its children.
                         The edge rect is filled too, so no seam shows between the halves. */}
                    <g transform="translate(136 67) rotate(-14) scale(1.14) translate(-135 -65)">
                      <rect className="pb-patch-shadow" x="122.5" y="55.5" width="28" height="24" rx="4" />
                      <rect className="pb-patch-edge" x="121" y="53" width="28" height="24" rx="4" />
                      <g className="pb-patch-half pb-patch-left">
                        <path className="pb-patch-tape" d="M125 53H135L133 57L137 61L133.5 65L137 69L134 73L136 77H125Q121 77 121 73V57Q121 53 125 53Z" />
                        <path className="pb-patch-stitch" d="M132.6 56.5H127.5Q124.5 56.5 124.5 59.5V70.5Q124.5 73.5 127.5 73.5H133.6" />
                      </g>
                      <g className="pb-patch-half pb-patch-right">
                        <path className="pb-patch-tape" d="M135 53H145Q149 53 149 57V73Q149 77 145 77H136L134 73L137 69L133.5 65L137 61L133 57Z" />
                        <path className="pb-patch-stitch" d="M134 56.5H142.5Q145.5 56.5 145.5 59.5V70.5Q145.5 73.5 142.5 73.5H134.9" />
                      </g>
                      {/* flash: one short white flash when the patch blocks a pop. */}
                      <rect className="pb-patch-flash" x="121" y="53" width="28" height="24" rx="4" />
                    </g>
                  </g>
                </g>
              </g>
            </g>
            {/* neck: the open neck the hose blows into while the balloon is pumped. */}
            <g className="pb-neck">
              <path className="pb-neck-tube" d="M95.5 204C96.6 210 96.6 215.5 95.2 220H104.8C103.4 215.5 103.4 210 104.5 204Z" />
              <path
                className="pb-neck-shade"
                fill="url(#pb-neck-fade)"
                d="M95.5 204C96.6 210 96.6 215.5 95.2 220H104.8C103.4 215.5 103.4 210 104.5 204Z"
              />
              {/* lip: the rubber rolled over the hose nozzle. */}
              <ellipse className="pb-neck-lip" cx="100" cy="220.8" rx="7.2" ry="2.9" />
              <ellipse className="pb-neck-gleam" cx="98" cy="219.9" rx="3.6" ry="0.9" />
            </g>
            {/* tie: the knot. Hidden until the balloon is tied off on cash-out. */}
            <g className="pb-tie">
              {/* tail: the end of the neck left below the knot, flaring out. */}
              <path
                className="pb-knot-tail"
                d="M97.6 213.5C97.8 216 96.6 218.6 94.4 220.4H105.6C103.4 218.6 102.2 216 102.4 213.5Z"
              />
              <path
                className="pb-knot-tail-shade"
                fill="url(#pb-neck-fade)"
                d="M97.6 213.5C97.8 216 96.6 218.6 94.4 220.4H105.6C103.4 218.6 102.2 216 102.4 213.5Z"
              />
              {/* lip: the rolled end of the neck. */}
              <ellipse className="pb-knot" cx="100" cy="220.6" rx="6.2" ry="2" />
              {/* knot: the wrapped lump, with the wrap's crease and a little light. */}
              <ellipse className="pb-knot" cx="100" cy="210.4" rx="5.2" ry="4.4" />
              <path className="pb-knot-crease" d="M95.4 210.6Q100 213.6 104.6 209.8" />
              <ellipse className="pb-knot-gleam" cx="98.2" cy="208.6" rx="1.9" ry="1.1" />
            </g>
            {/* shards: 8 pieces of rubber that fly out on a pop. Hidden until
                 then. They rest inside the body outline so they don't move the
                 pivot. Each one's flight is set in balloon.css. */}
            <g className="pb-shards">
              <path className="pb-shard pb-shard-1" d="M61 53L71 46L83 50L80 57L85 63L73 69L67 62Z" />
              <path className="pb-shard pb-shard-2" d="M112 47L121 41L133 45L130 52L134 58L123 59L117 55Z" />
              <path className="pb-shard pb-shard-3" d="M41 99C50 104 56 115 53 127L48 120C47 112 45 106 41 99Z" />
              <path className="pb-shard pb-shard-4" d="M147 96L157 94L162 101L159 108L163 114L152 116L149 108Z" />
              <path className="pb-shard pb-shard-5" d="M58 155L68 150L77 154L74 161L78 167L66 170L61 164Z" />
              <path className="pb-shard pb-shard-6" d="M122 150C132 152 140 158 143 167L135 165C132 159 128 155 122 150Z" />
              <path className="pb-shard pb-shard-7" d="M90 88L99 82L110 86L106 93L111 99L98 101L93 96Z" />
              <path className="pb-shard pb-shard-8" d="M90 184C96 180 106 180 112 186L104 190C100 187 95 186 90 184Z" />
            </g>
            {/* top: marker for reaching the top rung. Centred on x=100. */}
            <g className="pb-top">
              {/* Top reached: a dark seal with a mint ring and a star, sitting on
                   top of the balloon. Centred on x=100, never below y=222. */}
              <g className="pb-top-mark">
                <circle className="pb-top-disc" cx="100" cy="12" r="14" />
                <circle className="pb-top-ring" cx="100" cy="12" r="14" />
                <path className="pb-top-star" d="M100.0 4.6L101.9 9.9L107.6 10.1L103.1 13.6L104.7 19.1L100.0 15.9L95.3 19.1L96.9 13.6L92.4 10.1L98.1 9.9Z" />
              </g>
            </g>
          </g>
        </g>

        {/* burst: win effects that stay in place while the balloon floats away. */}
        <g className="pb-burst">
          {/* Invisible frame centred on the knot (100, 222), so the burst scales
               with the balloon around the same point. Everything inside stays
               within it, so the pivot never moves. */}
          <rect className="pb-burst-anchor" x="-200" y="-100" width="600" height="644" />
          {/* Rings start just outside the balloon, so they never cross it. */}
          <circle className="pb-ring pb-ring-1" cx="100" cy="114" r="98" />
          <circle className="pb-ring pb-ring-2" cx="100" cy="114" r="98" />
          <g className="pb-sparks">
              <path className="pb-spark pb-spark-1 pb-spark-mint" d="M35.9 147.0L39.8 156.1L48.9 160.0L39.8 163.9L35.9 173.0L32.0 163.9L22.9 160.0L32.0 156.1Z" />
              <path className="pb-spark pb-spark-2 pb-spark-pale" d="M26.1 107.0L29.1 114.0L36.1 117.0L29.1 120.0L26.1 127.0L23.1 120.0L16.1 117.0L23.1 114.0Z" />
              <path className="pb-spark pb-spark-3 pb-spark-mint" d="M31.9 60.5L36.1 70.3L45.9 74.5L36.1 78.7L31.9 88.5L27.7 78.7L17.9 74.5L27.7 70.3Z" />
              <path className="pb-spark pb-spark-4 pb-spark-pale" d="M52.4 28.5L55.4 35.5L62.4 38.5L55.4 41.5L52.4 48.5L49.4 41.5L42.4 38.5L49.4 35.5Z" />
              <path className="pb-spark pb-spark-5 pb-spark-mint" d="M83.4 4.5L87.6 14.3L97.4 18.5L87.6 22.7L83.4 32.5L79.2 22.7L69.4 18.5L79.2 14.3Z" />
              <path className="pb-spark pb-spark-6 pb-spark-pale" d="M116.6 8.5L119.6 15.5L126.6 18.5L119.6 21.5L116.6 28.5L113.6 21.5L106.6 18.5L113.6 15.5Z" />
              <path className="pb-spark pb-spark-7 pb-spark-mint" d="M147.6 24.5L151.8 34.3L161.6 38.5L151.8 42.7L147.6 52.5L143.4 42.7L133.6 38.5L143.4 34.3Z" />
              <path className="pb-spark pb-spark-8 pb-spark-pale" d="M168.1 64.5L171.1 71.5L178.1 74.5L171.1 77.5L168.1 84.5L165.1 77.5L158.1 74.5L165.1 71.5Z" />
              <path className="pb-spark pb-spark-9 pb-spark-mint" d="M173.9 104.0L177.8 113.1L186.9 117.0L177.8 120.9L173.9 130.0L170.0 120.9L160.9 117.0L170.0 113.1Z" />
              <path className="pb-spark pb-spark-10 pb-spark-pale" d="M164.1 150.0L167.1 157.0L174.1 160.0L167.1 163.0L164.1 170.0L161.1 163.0L154.1 160.0L161.1 157.0Z" />
              <path className="pb-spark pb-spark-11 pb-spark-mint pb-spark-extra" d="M28.9 129.5L31.6 135.8L37.9 138.5L31.6 141.2L28.9 147.5L26.2 141.2L19.9 138.5L26.2 135.8Z" />
              <path className="pb-spark pb-spark-12 pb-spark-mint pb-spark-extra" d="M40.9 45.2L43.6 51.5L49.9 54.2L43.6 56.9L40.9 63.2L38.2 56.9L31.9 54.2L38.2 51.5Z" />
              <path className="pb-spark pb-spark-13 pb-spark-mint pb-spark-extra" d="M66.4 17.5L69.1 23.8L75.4 26.5L69.1 29.2L66.4 35.5L63.7 29.2L57.4 26.5L63.7 23.8Z" />
              <path className="pb-spark pb-spark-14 pb-spark-mint pb-spark-extra" d="M133.6 17.5L136.3 23.8L142.6 26.5L136.3 29.2L133.6 35.5L130.9 29.2L124.6 26.5L130.9 23.8Z" />
              <path className="pb-spark pb-spark-15 pb-spark-mint pb-spark-extra" d="M159.1 45.2L161.8 51.5L168.1 54.2L161.8 56.9L159.1 63.2L156.4 56.9L150.1 54.2L156.4 51.5Z" />
              <path className="pb-spark pb-spark-16 pb-spark-mint pb-spark-extra" d="M171.1 129.5L173.8 135.8L180.1 138.5L173.8 141.2L171.1 147.5L168.4 141.2L162.1 138.5L168.4 135.8Z" />
          </g>
        </g>
      </g>
    </svg>
  );
}

/**
 * Bends the hose between standing and lying as the art's state changes:
 * it falls when a round ends and lifts when a new balloon's first pump
 * holds (hoseShape.ts has the shapes and the timing). React draws the end
 * shape; this draws the frames on the way there, straight onto the lines,
 * so a frame never waits for React.
 *
 * Every motion starts from the shape drawn last (`pose`), so one that
 * starts while another is under way (a cash-out during the first pump's
 * lift) carries on from there instead of jumping. The first drawing (a
 * page load, a restored round, a new balloon) and every change with
 * animations off show the end shape at once.
 */
function useHoseMotion(lying: boolean, beat: BalloonBeat | undefined) {
  const layer = useRef<SVGGElement>(null);
  const pose = useRef<HosePose | null>(null);
  const latestBeat = useRef(beat);
  useLayoutEffect(() => {
    latestBeat.current = beat;
  }, [beat]);
  useLayoutEffect(() => {
    const g = layer.current;
    if (!g) return undefined;
    const target = lying ? LYING : STANDING;
    const from = pose.current;
    if (from === null || animationsOff()) {
      pose.current = target;
      drawHose(g, hoseAt(target.down, target.share));
      return undefined;
    }
    if (from.down === target.down && from.share === target.share) return undefined;
    // A cash-out lets the balloon go first (after its glow, on a real win).
    // A hose already on its way, cut off by the cash-out, just carries on.
    const atRest = from.down === 0 && from.share === 0;
    const svg = g.ownerSVGElement;
    const wait = lying && atRest && latestBeat.current === 'cashout' && svg ? releaseDelayMs(svg) + 40 : 0;
    const duration = lying ? HOSE_FALL_MS : HOSE_LIFT_MS;
    const start = performance.now() + wait;
    const show = (next: HosePose) => {
      pose.current = next;
      drawHose(g, hoseAt(next.down, next.share));
    };
    let frame = 0;
    const step = (now: number) => {
      const t = (now - start) / duration;
      show(hoseFrame(from, lying, t));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    show(from);
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [lying]);
  return layer;
}

/** Puts one hose shape on every hose line, and the tip on its end. */
function drawHose(layer: SVGGElement, points: readonly Point[]): void {
  const d = hosePath(points);
  for (const line of layer.querySelectorAll('[data-hose-line]')) line.setAttribute('d', d);
  layer.querySelector('.pb-hose-tip')?.setAttribute('transform', tipTransform(points));
}

/** The same rule balloon.css follows: the player's choice, else the device's. */
function animationsOff(): boolean {
  const choice = document.documentElement.dataset.motion;
  if (choice === 'reduce') return true;
  if (choice === 'full') return false;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** --pb-release-delay on the balloon, in milliseconds. */
function releaseDelayMs(svg: SVGSVGElement): number {
  const value = getComputedStyle(svg).getPropertyValue('--pb-release-delay').trim();
  const ms = Number.parseFloat(value);
  if (!Number.isFinite(ms)) return 0;
  return value.endsWith('ms') ? ms : value.endsWith('s') ? ms * 1000 : ms;
}

/** The size before the first pump. balloon.css is drawn for this range. */
const BALLOON_SCALE_MIN = 0.45;

/**
 * How big the balloon is drawn: 0.45 before the first pump, 1 at the
 * balloon's top reachable rung.
 *
 * Size follows progress up the ladder: pumps survived out of the pumps
 * this balloon can make. (It used to follow the multiplier, and then the
 * first pump on a long ladder grew the balloon by a fifth of one percent.)
 *
 * The curve is a fifth straight line and four fifths progress to the
 * power 0.4. The power makes the early pumps big steps, so the balloon
 * fills the sky the user saw empty ("Zoom out, the balloon needs to grow
 * more", 2026-11-20): on Easy it is 0.56 / 0.63 / 0.68 / 0.76 after 1 / 3 /
 * 5 / 10 pumps, where it used to be 0.51 / 0.56 / 0.60 / 0.69. The
 * straight line keeps a floor under the late ones: its slope at the top is
 * 0.2 + 0.8 x 0.4 = 0.52 of an even share, so no pump grows the balloon
 * by less than half an even share of the way. Full size still comes only
 * at the top rung, so the biggest balloon is the same as before.
 *
 * Size shows how far up the ladder the balloon is, never risk. Display
 * only, so floats are fine here.
 */
export function balloonSize(rung: number, topRung: number): number {
  if (topRung <= 0) return BALLOON_SCALE_MIN;
  const progress = Math.min(1, Math.max(0, rung / topRung));
  const curved = 0.2 * progress + 0.8 * progress ** 0.4;
  return BALLOON_SCALE_MIN + (1 - BALLOON_SCALE_MIN) * curved;
}
