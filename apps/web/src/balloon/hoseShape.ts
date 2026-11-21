/**
 * The hose's shape as it falls to the floor and lifts back up.
 *
 * The hose is one line from the pump's nozzle to the balloon's neck. When
 * a round ends (a pop or a cash-out) it falls and lies on the floor; when
 * a new balloon's first pump holds, it lifts back up. The user asked for
 * this to be one fluid motion (2026-11-20): it used to be the standing
 * hose turned over as a stiff piece and swapped for a lying shape at the
 * end, which looked like a crumple.
 *
 * So the line itself bends, frame by frame: at every moment it is the
 * standing hose turned partway down around the nozzle, blended more and
 * more into the lying shape, and kept above the floor. Both shapes are
 * three cubic pieces, point for point, so any blend of them is a smooth
 * hose. Safari cannot animate a path's shape in CSS, so Balloon.tsx sets
 * the line from these numbers on each frame instead.
 *
 * Display only. Plain numbers, no I/O.
 */

/** A point of the drawing (200 x 320 units). */
export type Point = readonly [number, number];

/** Where the hose leaves the pump. It never moves. */
export const NOZZLE: Point = [116, 295];

/** The hose's centre line when it lies on the floor (it is 5 wide). */
export const FLOOR_Y = 308.5;

/**
 * The standing hose: out of the nozzle to the left, round and up into the
 * neck at (100, 227). One cubic curve, split into three equal pieces so it
 * has the same points as the lying hose. 79.2 long.
 */
export const STAND: readonly Point[] = splitInThirds([116, 295], [88, 295], [100, 262], [100, 227]);

/**
 * The hose lying on the floor: off the nozzle in a small arc, down to the
 * floor by x 85, then resting flat on it (bottom on the floor line, no
 * bump) out to x 56, pointing left. Its very end rises 1.5 units: the
 * fitting there is wider than the hose and rests on the floor too. Three cubic pieces, 66.5 long. Its end
 * stays clear of the left edge so the small flat balloon can come straight
 * out of it, pointing the same way (the user: "make baloon in direction of
 * nozzle", 2026-11-20): the 14% line and the next pump to the left both
 * start about x 39.
 */
export const FLAT: readonly Point[] = [
  [116, 295],
  [106, 291],
  [97, 292],
  [93, 301],
  [90.5, 306.5],
  [85, 308.5],
  [77, 308.5],
  [69, 308.5],
  [62, 308.4],
  [56, 307],
];

/** How far the standing hose turns to lie down (anticlockwise on screen). */
export const HOSE_DOWN_DEG = -87;

/** Where the standing hose's end is (it points straight up there). */
export const STAND_END: Point = [100, 227];

/** How long the fall takes, from standing to lying. */
export const HOSE_FALL_MS = 440;

/**
 * How long the lift takes, from lying to standing. balloon.css has the same
 * number (--pb-lift-ms) for the small flat balloon that rides up with it;
 * a test checks the two match.
 */
export const HOSE_LIFT_MS = 280;

/** What the art is showing, as far as the hose cares. */
export interface HoseState {
  readonly beat?: string | undefined;
  readonly first?: string | undefined;
  readonly idle?: boolean | undefined;
}

/**
 * Whether the hose lies on the floor: before any bet, while a new balloon
 * waits for its first pump (or was refunded unpumped), and once a round has
 * ended, on a pop or a cash-out alike. Otherwise it stands, holding the
 * balloon.
 */
export function hoseLies({ beat, first, idle }: HoseState): boolean {
  if (idle === true || first === 'floor' || first === 'floor-popped' || first === 'floor-void') return true;
  return beat === 'pop' || beat === 'popped' || beat === 'cashout' || beat === 'cashed';
}

/** A path's `d` for ten points: a start and three cubic pieces. */
export function hosePath(points: readonly Point[]): string {
  const p = points.map(([x, y]) => `${round(x)} ${round(y)}`);
  return `M${p[0]}C${p[1]} ${p[2]} ${p[3]}C${p[4]} ${p[5]} ${p[6]}C${p[7]} ${p[8]} ${p[9]}`;
}

/**
 * The hose `down` of the way from standing (0) to lying (1), at `share`
 * of the way from its standing length (79.2) to its lying length (66.5).
 *
 * Turning: the standing hose turns around the nozzle by `down` of the full
 * angle. Bending: from a third of the way on, it blends into the lying
 * shape, all of it by the end. Length: the result is then scaled around
 * the nozzle to its share of the length, so the length can change evenly
 * over the motion instead of all at once (it would look like a stretch).
 * Floor: no point goes below the floor line, so the hose lands on the
 * floor instead of passing through it.
 */
export function hoseAt(down: number, share = down): Point[] {
  const turned = STAND.map((p) => turn(p, HOSE_DOWN_DEG * down));
  const blend = smoothstep(1 / 3, 1, down);
  const bent = turned.map(([x, y], i): Point => {
    const [fx, fy] = FLAT[i] ?? [x, y];
    return [x + (fx - x) * blend, y + (fy - y) * blend];
  });
  const k = (STAND_LENGTH + (FLAT_LENGTH - STAND_LENGTH) * clamp01(share)) / hoseLength(bent);
  const [nx, ny] = NOZZLE;
  return bent.map(([x, y], i): Point => (i === 0 ? [x, y] : [nx + (x - nx) * k, Math.min(ny + (y - ny) * k, FLOOR_Y)]));
}

/** The length of a hose line (ten points: a start and three cubic pieces). */
export function hoseLength(points: readonly Point[]): number {
  let total = 0;
  for (let piece = 0; piece < 3; piece += 1) {
    const [p0, p1, p2, p3] = points.slice(piece * 3, piece * 3 + 4) as [Point, Point, Point, Point];
    let prev = p0;
    for (let i = 1; i <= 24; i += 1) {
      const t = i / 24;
      const u = 1 - t;
      const at = (k: 0 | 1) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k];
      const next: Point = [at(0), at(1)];
      total += Math.hypot(next[0] - prev[0], next[1] - prev[1]);
      prev = next;
    }
  }
  return total;
}

/** Where the hose is in its motion: how far down, and its length share. */
export interface HosePose {
  readonly down: number;
  readonly share: number;
}

export const STANDING: HosePose = { down: 0, share: 0 };
export const LYING: HosePose = { down: 1, share: 1 };

/**
 * The hose `t` of the way (0 to 1) through a fall (`lying`) or a lift,
 * starting from `from`: wherever it was drawn last, so a motion that
 * starts while another is under way (a cash-out during the first pump's
 * lift) carries on from there instead of jumping. The length share moves
 * evenly with the time.
 */
export function hoseFrame(from: HosePose, lying: boolean, t: number): HosePose {
  const time = clamp01(t);
  if (lying) {
    return { down: from.down + (1 - from.down) * fallAt(time), share: from.share + (1 - from.share) * time };
  }
  return { down: from.down * liftAt(time), share: from.share * (1 - time) };
}

/**
 * The transform that carries what sits on the standing hose's end (the
 * fitting, the small flat balloon) to the end of `points`, turned to
 * point the same way the hose does there.
 */
export function tipTransform(points: readonly Point[]): string {
  const { dx, dy, degrees } = tipPose(points);
  const [sx, sy] = STAND_END;
  return `translate(${round(dx)} ${round(dy)}) rotate(${round(degrees)} ${sx} ${sy})`;
}

/** tipTransform as numbers: a shift, then a turn around STAND_END. */
export function tipPose(points: readonly Point[]): { dx: number; dy: number; degrees: number } {
  const [ex, ey] = points[9] ?? STAND_END;
  const [cx, cy] = points[8] ?? STAND_END;
  // The standing hose points straight up at its end (angle -90 degrees).
  const degrees = (Math.atan2(ey - cy, ex - cx) * 180) / Math.PI + 90;
  return { dx: ex - STAND_END[0], dy: ey - STAND_END[1], degrees };
}

/** Where a point drawn on the standing hose's end goes under tipPose. */
export function onTip([x, y]: Point, pose: { dx: number; dy: number; degrees: number }): Point {
  const r = (pose.degrees * Math.PI) / 180;
  const [sx, sy] = STAND_END;
  const px = x - sx;
  const py = y - sy;
  return [sx + px * Math.cos(r) - py * Math.sin(r) + pose.dx, sy + px * Math.sin(r) + py * Math.cos(r) + pose.dy];
}

/**
 * How far down the hose is, `t` of the way through its fall (both 0 to 1):
 * slow at first, then faster, onto the floor at 62%, one small bounce of
 * its free end, then still. Like a rope let go.
 */
export function fallAt(t: number): number {
  const x = clamp01(t);
  if (x < 0.62) return easeIn(x / 0.62);
  if (x < 0.8) return 1 - 0.07 * easeOut((x - 0.62) / 0.18);
  return 0.93 + 0.07 * easeIn((x - 0.8) / 0.2);
}

/**
 * How far down the hose is, `t` of the way through being lifted (both 0
 * to 1): quick off the floor, slowing as it comes upright.
 */
export function liftAt(t: number): number {
  return 1 - easeOut(clamp01(t));
}

function turn([x, y]: Point, degrees: number): Point {
  const r = (degrees * Math.PI) / 180;
  const [nx, ny] = NOZZLE;
  const dx = x - nx;
  const dy = y - ny;
  return [nx + dx * Math.cos(r) - dy * Math.sin(r), ny + dx * Math.sin(r) + dy * Math.cos(r)];
}

function splitInThirds(p0: Point, p1: Point, p2: Point, p3: Point): Point[] {
  const [a, rest] = split([p0, p1, p2, p3], 1 / 3);
  const [b, c] = split(rest, 1 / 2);
  return [...a, ...b.slice(1), ...c.slice(1)];
}

function split(q: readonly Point[], t: number): [Point[], Point[]] {
  const lerp = (a: Point, b: Point): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const [p0, p1, p2, p3] = q as [Point, Point, Point, Point];
  const a = lerp(p0, p1);
  const b = lerp(p1, p2);
  const c = lerp(p2, p3);
  const d = lerp(a, b);
  const e = lerp(b, c);
  const f = lerp(d, e);
  return [
    [p0, a, d, f],
    [f, e, c, p3],
  ];
}

function smoothstep(from: number, to: number, x: number): number {
  const t = clamp01((x - from) / (to - from));
  return t * t * (3 - 2 * t);
}

function easeIn(t: number): number {
  return t * t;
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

/** The standing and lying lengths (79.2 and 66.5). */
export const STAND_LENGTH = hoseLength(STAND);
export const FLAT_LENGTH = hoseLength(FLAT);
