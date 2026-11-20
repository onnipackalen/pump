/**
 * verifyRound catches a dishonest or broken record, one change at a time.
 *
 * Each test starts from an honest record of a round played by the live
 * engine with real seeds, changes exactly one thing the way a cheating or
 * buggy server might, and checks the exact sentence the player is shown.
 *
 * The honest round (expert ladder, so the cap matters for a big bet):
 *   Balloon 1  12,345 cents. Pump, then Patch + pump until a Patch saves it,
 *              then cash out. So it has a Patch cost and a saved draw.
 *   Balloon 2  99 cents. Pumps with no Patch until it pops, after at least
 *              one survived pump.
 *   Balloon 3  100,000 cents, capped below the top of the ladder. Never
 *              pumped; the round is abandoned, so its bet is refunded.
 * The nonce is the first one, counting from 0, whose draws give that story,
 * so the same round comes out at every RTP without hard-coding any roll.
 */
import { describe, expect, it } from 'vitest';
import {
  cashOut,
  DIFFICULTIES,
  GAME_CONFIG,
  pump,
  RTP_BP,
  settleAbandoned,
  startRound,
  surviveChance,
  type BalloonAction,
  type DrawRecord,
  type GameConfig,
  type PumpOutcome,
  type Round,
} from '@pump/engine';
import {
  drawerFor,
  drawRoll,
  hashServerSeed,
  verifyRound,
  type BalloonRecord,
  type ClaimedBalloon,
  type RoundRecord,
} from '@pump/engine/fair';

/** The three RTP values reviewers will try, plus whatever is configured now. */
const RTPS = [...new Set([9400, 9700, 9900, RTP_BP])];
const RICH = 1_000_000_000;
const CAP = GAME_CONFIG.limits.maxPayoutCents;

const SERVER_SEED = '3f1c9a7e5b2d4c6a8e0f1b3d5c7a9e2f4b6d8c0a1e3f5b7d9c2a4e6f8b0d1c3a';
const OTHER_SEED = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const CLIENT_SEED = 'verify_Test-1';

// ---------------------------------------------------------------------------
// Playing a round the way the server does, and storing it
// ---------------------------------------------------------------------------

/** One move by the test player. */
type Move = { readonly balloon: number; readonly patch: boolean } | { readonly cashOut: number };

/** What the server keeps while a round is played: actions and draws per balloon. */
class Recorder {
  round: Round;
  readonly actions: BalloonAction[][];
  readonly draws: DrawRecord[][];
  readonly outcomes: PumpOutcome[][];

  constructor(
    readonly config: GameConfig,
    readonly nonce: number,
    difficultyId: string,
    bets: readonly number[],
  ) {
    this.round = startRound(config, difficultyId, bets, RICH).round;
    this.actions = bets.map(() => []);
    this.draws = bets.map(() => []);
    this.outcomes = bets.map(() => []);
  }

  balloon(index: number) {
    const balloon = this.round.balloons[index];
    if (balloon === undefined) throw new Error(`no balloon ${String(index)}`);
    return balloon;
  }

  play(move: Move): void {
    if ('cashOut' in move) {
      const balloonIndex = move.cashOut;
      const expectedDrawIndex = this.balloon(balloonIndex).drawIndex;
      this.round = cashOut(this.round, { balloonIndex, expectedDrawIndex }).round;
      this.actions[balloonIndex]?.push({ kind: 'cashOut' });
      return;
    }
    const { balloon: balloonIndex, patch } = move;
    const drawIndex = this.balloon(balloonIndex).drawIndex;
    const result = pump(
      this.round,
      { balloonIndex, expectedDrawIndex: drawIndex, patch, balanceCents: RICH },
      drawerFor({
        serverSeed: SERVER_SEED,
        clientSeed: CLIENT_SEED,
        nonce: this.nonce,
        balloonIndex,
        drawIndex,
      }),
    );
    this.round = result.round;
    this.actions[balloonIndex]?.push({ kind: 'pump', patch });
    this.draws[balloonIndex]?.push(result.draw);
    this.outcomes[balloonIndex]?.push(result.outcome);
  }

  abandon(): void {
    const settled = settleAbandoned(this.round);
    for (const { balloonIndex, kind } of settled.settled) {
      if (kind === 'cashed') this.actions[balloonIndex]?.push({ kind: 'cashOut' });
    }
    this.round = settled.round;
  }

  record(): RoundRecord {
    return {
      serverSeed: SERVER_SEED,
      serverSeedHash: hashServerSeed(SERVER_SEED),
      clientSeed: CLIENT_SEED,
      nonce: this.nonce,
      difficultyId: this.round.difficultyId,
      rtpBp: this.round.rtpBp,
      ladder: this.round.ladder,
      maxPayoutCents: this.config.limits.maxPayoutCents,
      balloons: this.round.balloons.map((balloon, i) => ({
        betCents: balloon.betCents,
        actions: this.actions[i] ?? [],
        status: balloon.status,
        rung: balloon.rung,
        drawIndex: balloon.drawIndex,
        topRung: balloon.topRung,
        patchesCents: balloon.patchesCents,
        payoutCents: balloon.payoutCents,
        draws: this.draws[i] ?? [],
      })),
    };
  }
}

/** The first nonce from 0 whose round passes `wanted`, played by `script`. */
function firstRound(script: (nonce: number) => Recorder, wanted: (r: Recorder) => boolean) {
  for (let nonce = 0; nonce < 10_000; nonce += 1) {
    const recorder = script(nonce);
    if (wanted(recorder)) return recorder;
  }
  throw new Error('no nonce gave the round the test needs');
}

/** The honest round described at the top of this file, at one RTP. */
function honestRound(rtpBp: number): Recorder {
  const config: GameConfig = { ...GAME_CONFIG, rtpBp };
  return firstRound(
    (nonce) => {
      const r = new Recorder(config, nonce, 'expert', [12_345, 99, 100_000]);
      // Balloon 1: pump, Patch + pump until saved (at most 6), cash out.
      r.play({ balloon: 0, patch: false });
      for (let i = 0; i < 6 && r.balloon(0).status === 'active'; i += 1) {
        if (r.outcomes[0]?.includes('saved') === true) break;
        r.play({ balloon: 0, patch: true });
      }
      if (r.balloon(0).status === 'active') r.play({ cashOut: 0 });
      // Balloon 2: pump until it pops or tops out.
      while (r.balloon(1).status === 'active') r.play({ balloon: 1, patch: false });
      // Balloon 3 is never pumped: walk away.
      r.abandon();
      return r;
    },
    (r) =>
      r.outcomes[0]?.includes('saved') === true &&
      r.outcomes[0].at(-1) !== 'top' &&
      r.balloon(0).status === 'cashed' &&
      r.balloon(1).status === 'popped' &&
      r.balloon(1).rung >= 1 &&
      r.balloon(2).status === 'refunded',
  );
}

// ---------------------------------------------------------------------------
// Changing one thing
// ---------------------------------------------------------------------------

function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`nothing at ${String(index)}`);
  return item;
}

/** A copy of the record with balloon `index` changed. */
function withBalloon(
  record: RoundRecord,
  index: number,
  change: (balloon: BalloonRecord) => BalloonRecord,
): RoundRecord {
  return {
    ...record,
    balloons: record.balloons.map((balloon, i) => (i === index ? change(balloon) : balloon)),
  };
}

/** A copy of the record with some of balloon `index`'s claimed fields changed. */
function withClaim(
  record: RoundRecord,
  index: number,
  change: (claimed: ClaimedBalloon) => Partial<ClaimedBalloon>,
): RoundRecord {
  return withBalloon(record, index, (balloon) => ({ ...balloon, ...change(balloon) }));
}

/** A copy of the record with draw `drawAt` of balloon `index` changed. */
function withDraw(
  record: RoundRecord,
  index: number,
  drawAt: number,
  change: (draw: DrawRecord) => Partial<DrawRecord>,
): RoundRecord {
  return withClaim(record, index, (claimed) => ({
    draws: claimed.draws.map((draw, j) => (j === drawAt ? { ...draw, ...change(draw) } : draw)),
  }));
}

/**
 * The roll sentence for the first draw that changes when a record's seeds or
 * nonce are swapped for `changed`'s. Up to that draw every roll is the same,
 * so the balloon is in the same state and the draw has the same den.
 */
function firstChangedRoll(honest: RoundRecord, changed: RoundRecord): string | undefined {
  for (const [balloonIndex, balloon] of honest.balloons.entries()) {
    for (const [j, draw] of balloon.draws.entries()) {
      const inputs = { ...changed, balloonIndex, drawIndex: draw.drawIndex };
      const roll = drawRoll(inputs, draw.den).roll;
      if (roll !== draw.roll) {
        return (
          `Balloon ${String(balloonIndex + 1)}, pump ${String(j + 1)} ` +
          `(draw index ${String(draw.drawIndex)}): the server says roll ${String(draw.roll)}, ` +
          `the seeds give ${String(roll)}.`
        );
      }
    }
  }
  return undefined;
}

function plural(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe.each(RTPS)('verifyRound at RTP %i', (rtpBp) => {
  const honest = honestRound(rtpBp).record();
  const [one, two, three] = [at(honest.balloons, 0), at(honest.balloons, 1), at(honest.balloons, 2)];

  it('passes the honest round, which has a Patch save, a pop, a cash-out and a refund', () => {
    const check = verifyRound(honest);
    expect(check.problems).toEqual([]);
    expect(check).toMatchObject({ ok: true, seedHashMatches: true });
    expect(one.patchesCents).toBeGreaterThan(0);
    expect(one.drawIndex).toBeGreaterThan(one.rung);
    expect(check.balloons.map((b) => b.balloon?.status)).toEqual(['cashed', 'popped', 'refunded']);
    expect(check.balloons[0]?.draws.some((d) => d.patched && !d.survived)).toBe(true);
    // Balloon 3's bet is capped below the top of the ladder.
    expect(three.topRung).toBeLessThan(honest.ladder.length);
  });

  describe('seeds', () => {
    it('catches a seed hash that is not the one for the revealed seed', () => {
      const shown = hashServerSeed(OTHER_SEED);
      const check = verifyRound({ ...honest, serverSeedHash: shown });
      expect(check.seedHashMatches).toBe(false);
      expect(check.ok).toBe(false);
      expect(check.problems).toEqual([
        'The revealed server seed does not match the hash you were shown. ' +
          `Its SHA-256 is ${hashServerSeed(SERVER_SEED)}, the hash shown was "${shown}".`,
      ]);
      // The draws themselves still match the revealed seed.
      expect(check.balloons.every((b) => b.ok)).toBe(true);
    });

    it('catches a revealed seed that is not the one the round was played with', () => {
      const changed = { ...honest, serverSeed: OTHER_SEED };
      const check = verifyRound(changed);
      expect(check.seedHashMatches).toBe(false);
      expect(check.problems[0]).toBe(
        'The revealed server seed does not match the hash you were shown. ' +
          `Its SHA-256 is ${hashServerSeed(OTHER_SEED)}, ` +
          `the hash shown was "${honest.serverSeedHash}".`,
      );
      const rollProblem = firstChangedRoll(honest, changed);
      expect(rollProblem).toBeDefined();
      expect(check.problems).toContain(rollProblem);
    });

    it('catches a different client seed', () => {
      const changed = { ...honest, clientSeed: 'someone-else' };
      const check = verifyRound(changed);
      expect(check.ok).toBe(false);
      expect(check.seedHashMatches).toBe(true);
      const rollProblem = firstChangedRoll(honest, changed);
      expect(rollProblem).toBeDefined();
      expect(check.problems).toContain(rollProblem);
      expect(check.balloons[0]?.draws[0]?.message).toBe(`someone-else:${String(honest.nonce)}:0:0:0`);
    });

    it('catches a different nonce', () => {
      const changed = { ...honest, nonce: honest.nonce + 1 };
      const check = verifyRound(changed);
      expect(check.ok).toBe(false);
      const rollProblem = firstChangedRoll(honest, changed);
      expect(rollProblem).toBeDefined();
      expect(check.problems).toContain(rollProblem);
    });

    it('names seeds and a nonce of the wrong form, and recomputes nothing', () => {
      const check = verifyRound({
        ...honest,
        serverSeed: SERVER_SEED.toUpperCase(),
        clientSeed: 'has:colon',
        nonce: -1,
      });
      expect(check.seedHashMatches).toBe(false);
      expect(check.problems).toEqual([
        'The revealed server seed is not 64 lowercase hex characters (0-9, a-f).',
        'The client seed is not 1 to 64 characters from A-Z, a-z, 0-9, _ and -.',
        'The nonce is not a whole number from 0 up.',
        ...[1, 2, 3].map(
          (n) =>
            `Balloon ${String(n)}: its draws cannot be recomputed without a valid server seed, ` +
            'client seed and nonce.',
        ),
      ]);
      expect(check.balloons.map((b) => b.balloon)).toEqual([null, null, null]);
    });
  });

  describe('draws', () => {
    it('catches one changed roll', () => {
      const last = two.draws.length - 1;
      const draw = at(two.draws, last);
      const fake = (draw.roll + 1) % draw.den;
      const check = verifyRound(withDraw(honest, 1, last, () => ({ roll: fake })));
      expect(check.problems).toEqual([
        `Balloon 2, pump ${String(last + 1)} (draw index ${String(last)}): ` +
          `the server says roll ${String(fake)}, the seeds give ${String(draw.roll)}.`,
      ]);
      expect(check.balloons.map((b) => b.ok)).toEqual([true, false, true]);
    });

    it('catches a changed num or den', () => {
      const draw = at(one.draws, 1);
      const chance = (num: number, den: number) =>
        'Balloon 1, pump 2 (draw index 1): the server says the survival chance was ' +
        `${String(num)}/${String(den)}, the round's RTP and ladder give ` +
        `${String(draw.num)}/${String(draw.den)}.`;
      expect(verifyRound(withDraw(honest, 0, 1, (d) => ({ num: d.num + 1 }))).problems).toEqual([
        chance(draw.num + 1, draw.den),
      ]);
      expect(verifyRound(withDraw(honest, 0, 1, (d) => ({ den: d.den + 1 }))).problems).toEqual([
        chance(draw.num, draw.den + 1),
      ]);
    });

    it('catches a changed draw index', () => {
      const check = verifyRound(withDraw(honest, 0, 1, () => ({ drawIndex: 5 })));
      expect(check.problems).toEqual([
        'Balloon 1, pump 2 (draw index 1): the server gives it draw index 5.',
      ]);
    });

    it('catches a draw left out or added', () => {
      const made = one.draws.length;
      const missing = withClaim(honest, 0, (c) => ({ draws: c.draws.slice(0, -1) }));
      expect(verifyRound(missing).problems).toEqual([
        `Balloon 1: the server lists ${plural(made - 1, 'draw')}, its actions make ${String(made)}.`,
      ]);
      const extra = withClaim(honest, 0, (c) => ({
        draws: [...c.draws, { drawIndex: made, den: 2, num: 1, roll: 0 }],
      }));
      expect(verifyRound(extra).problems).toEqual([
        `Balloon 1: the server lists ${plural(made + 1, 'draw')}, its actions make ${String(made)}.`,
      ]);
    });
  });

  describe('money and end state', () => {
    it('catches a payout one cent too high', () => {
      const paid = one.payoutCents;
      const check = verifyRound(withClaim(honest, 0, () => ({ payoutCents: paid + 1 })));
      expect(check.problems).toEqual([
        `Balloon 1: the server says it paid out ${String(paid + 1)} cents, ` +
          `the replay gives ${String(paid)} cents.`,
      ]);
    });

    it('catches Patches one cent cheaper than charged', () => {
      const cost = one.patchesCents;
      const check = verifyRound(withClaim(honest, 0, () => ({ patchesCents: cost - 1 })));
      expect(check.problems).toEqual([
        `Balloon 1: the server says its Patches cost ${String(cost - 1)} cents, ` +
          `the replay gives ${String(cost)} cents.`,
      ]);
    });

    it('catches popped and cashed swapped', () => {
      expect(verifyRound(withClaim(honest, 1, () => ({ status: 'cashed' }))).problems).toEqual([
        'Balloon 2: the server says it cashed out, the replay says it popped.',
      ]);
      expect(verifyRound(withClaim(honest, 0, () => ({ status: 'popped' }))).problems).toEqual([
        'Balloon 1: the server says it popped, the replay says it cashed out.',
      ]);
    });

    it('catches a changed rung or draw count', () => {
      const { rung, drawIndex } = two;
      expect(verifyRound(withClaim(honest, 1, () => ({ rung: rung + 1 }))).problems).toEqual([
        `Balloon 2: the server says it ended on rung ${String(rung + 1)}, ` +
          `the replay ends on rung ${String(rung)}.`,
      ]);
      expect(verifyRound(withClaim(honest, 1, () => ({ drawIndex: 1 }))).problems).toEqual([
        `Balloon 2: the server says it used 1 draw, the replay uses ${String(drawIndex)}.`,
      ]);
    });

    it('catches a top rung raised beyond the cap', () => {
      const top = three.topRung;
      const check = verifyRound(withClaim(honest, 2, () => ({ topRung: top + 1 })));
      expect(check.problems).toEqual([
        `Balloon 3: the server says its top rung is ${String(top + 1)}, but a bet of ` +
          `100000 cents under the ${String(CAP)}-cent cap tops out at rung ${String(top)}.`,
      ]);
    });

    it('catches a pumped balloon claimed as refunded', () => {
      const check = verifyRound(withClaim(honest, 1, () => ({ status: 'refunded' })));
      expect(check.problems).toEqual([
        `Balloon 2: the server says its bet was refunded, but it lists ` +
          `${plural(two.actions.length, 'action')}. Only a balloon that was never pumped is refunded.`,
      ]);
    });

    it('catches a refunded balloon that claims a draw', () => {
      const draw = { drawIndex: 0, den: 2, num: 1, roll: 0 };
      const check = verifyRound(withClaim(honest, 2, () => ({ draws: [draw] })));
      expect(check.problems).toEqual(['Balloon 3: the server lists 1 draw, its actions make 0.']);
    });

    it('catches a cash-out left out of the actions, which would hide a payout', () => {
      const hidden = withBalloon(honest, 0, (balloon) => ({
        ...balloon,
        actions: balloon.actions.slice(0, -1),
        status: 'active',
        payoutCents: 0,
      }));
      expect(verifyRound(hidden).problems).toEqual([
        `Balloon 1: after its last action it is still in play on rung ${String(one.rung)}. ` +
          'In a finished round it would have popped or been cashed out.',
      ]);
    });
  });

  describe('actions the game would refuse', () => {
    it('catches actions after the balloon ended, and still shows the steps before', () => {
      const n = two.actions.length;
      const more = withBalloon(honest, 1, (b) => ({
        ...b,
        actions: [...b.actions, { kind: 'pump', patch: false }],
      }));
      const check = verifyRound(more);
      expect(check.problems).toEqual([
        `Balloon 2, action ${String(n + 1)} (pump): the game rules refuse it. ` +
          'These actions go on after the balloon was over.',
      ]);
      const honestCheck = verifyRound(honest);
      expect(check.balloons[1]?.balloon).toEqual(honestCheck.balloons[1]?.balloon);
      expect(check.balloons[1]?.draws).toEqual(honestCheck.balloons[1]?.draws);

      const afterCashOut = withBalloon(honest, 0, (b) => ({
        ...b,
        actions: [...b.actions, { kind: 'cashOut' }],
      }));
      expect(verifyRound(afterCashOut).problems).toEqual([
        `Balloon 1, action ${String(one.actions.length + 1)} (cash out): the game rules refuse it. ` +
          'These actions go on after the balloon was over.',
      ]);
    });

    it('catches a Patch on the first pump', () => {
      const patchedFirst = withBalloon(honest, 1, (b) => ({
        ...b,
        actions: [{ kind: 'pump', patch: true }, ...b.actions.slice(1)],
      }));
      const check = verifyRound(patchedFirst);
      expect(check.problems).toEqual([
        'Balloon 2, action 1 (Patch + pump): the game rules refuse it. ' +
          'A Patch is only sold after the first pump.',
      ]);
      expect(check.balloons[1]?.draws).toEqual([]);
    });

    it('catches an action the game does not have', () => {
      const unknown = { kind: 'refund' } as unknown as BalloonAction;
      const check = verifyRound(withBalloon(honest, 0, (b) => ({ ...b, actions: [unknown] })));
      expect(check.problems).toEqual([
        'Balloon 1, action 1: it is neither a pump nor a cash out, so the balloon cannot be replayed.',
      ]);
    });
  });
});

describe('verifyRound uses the RTP stored with the round', () => {
  it.each([
    [9700, 9400],
    [9400, 9900],
    [9900, 9700],
  ])('catches a round played at %i but claimed at %i', (played, claimed) => {
    const honest = honestRound(played).record();
    const check = verifyRound({ ...honest, rtpBp: claimed });
    expect(check.ok).toBe(false);
    const real = surviveChance(played, honest.ladder, 1);
    const said = surviveChance(claimed, honest.ladder, 1);
    // The server's draws say the played chance; the claimed RTP gives another.
    expect(check.problems).toContain(
      'Balloon 1, pump 1 (draw index 0): the server says the survival chance was ' +
        `${String(real.num)}/${String(real.den)}, the round's RTP and ladder give ` +
        `${String(said.num)}/${String(said.den)}.`,
    );
  });

  it('verifies a round played at another RTP than the one configured now', () => {
    const played = GAME_CONFIG.rtpBp === 9900 ? 9400 : 9900;
    const honest = honestRound(played).record();
    expect(honest.rtpBp).toBe(played);
    // Read with the configured RTP instead, pump 1 would have another chance.
    expect(surviveChance(played, honest.ladder, 1)).not.toEqual(
      surviveChance(GAME_CONFIG.rtpBp, honest.ladder, 1),
    );
    expect(verifyRound(honest).problems).toEqual([]);
  });

  it('checks the stored RTP and ladder with the engine’s own rules', () => {
    const honest = honestRound(9700).record();
    const ladder = [...honest.ladder];
    ladder[2] = ladder[1] ?? 0; // rung 3 no longer above rung 2
    const check = verifyRound({ ...honest, ladder });
    expect(check.problems[0]).toBe(
      "The round's RTP and ladder break a game rule: rung 3 is not above rung 2.",
    );
    const tooHigh = verifyRound({ ...honest, rtpBp: 100 * (honest.ladder[0] ?? 0) });
    expect(tooHigh.problems[0]).toBe(
      "The round's RTP and ladder break a game rule: RTP must be below the first multiplier.",
    );
  });
});

describe('a server that let a balloon climb past the cap', () => {
  it('is caught by the top rung and by the pumps after it', () => {
    // The server played with a cap 100 times too high, then claimed the real one.
    const loose: GameConfig = {
      ...GAME_CONFIG,
      rtpBp: 9700,
      limits: { ...GAME_CONFIG.limits, maxPayoutCents: CAP * 100 },
    };
    const r = firstRound(
      (nonce) => {
        const recorder = new Recorder(loose, nonce, 'expert', [100_000]);
        recorder.play({ balloon: 0, patch: false });
        // With a Patch on every pump after the first it cannot pop.
        while (recorder.balloon(0).status === 'active') recorder.play({ balloon: 0, patch: true });
        return recorder;
      },
      (recorder) => recorder.balloon(0).status === 'cashed',
    );
    const record = { ...r.record(), maxPayoutCents: CAP };
    const realTop = Math.max(
      ...record.ladder.flatMap((h, k) => (100_000 * h <= CAP * 100 ? [k + 1] : [])),
    );
    const played = at(record.balloons, 0);
    // The action after the pump that first reached the real top rung.
    let rung = 0;
    let reachedAt = -1;
    for (const [i, outcome] of (r.outcomes[0] ?? []).entries()) {
      if (outcome === 'survived') rung += 1;
      if (rung === realTop && reachedAt < 0) reachedAt = i;
    }
    expect(played.topRung).toBeGreaterThan(realTop);
    expect(verifyRound(record).problems).toEqual([
      `Balloon 1: the server says its top rung is ${String(played.topRung)}, but a bet ` +
        `of 100000 cents under the ${String(CAP)}-cent cap tops out at rung ${String(realTop)}.`,
      `Balloon 1, action ${String(reachedAt + 2)} (Patch + pump): the game rules refuse it. ` +
        'These actions go on after the balloon was over.',
    ]);
  });
});

describe('records that are wrong but of the right types', () => {
  it('never throws, and says what is wrong', () => {
    const honest = honestRound(9700).record();
    const broken: RoundRecord[] = [
      { ...honest, ladder: [] },
      { ...honest, rtpBp: 0 },
      { ...honest, rtpBp: 97.5 },
      { ...honest, maxPayoutCents: 0 },
      { ...honest, nonce: Number.NaN },
      { ...honest, balloons: [] },
      withBalloon(honest, 0, (b) => ({ ...b, betCents: 0 })),
      withBalloon(honest, 0, (b) => ({ ...b, betCents: 12.5 })),
      withClaim(honest, 0, () => ({ status: 'lost' as unknown as ClaimedBalloon['status'] })),
      { ...honest, ladder: honest.ladder.map((h) => h + 0.5) },
    ];
    for (const record of broken) {
      const check = verifyRound(record);
      expect(check.ok).toBe(false);
      expect(check.problems.length).toBeGreaterThan(0);
    }
    expect(verifyRound({ ...honest, balloons: [] }).problems).toEqual(['The round has no balloons.']);
    expect(verifyRound({ ...honest, ladder: [] }).problems).toEqual([
      "The round's RTP and ladder break a game rule: the ladder is empty.",
      ...[12_345, 99, 100_000].map(
        (bet, i) =>
          `Balloon ${String(i + 1)}: a bet of ${String(bet)} cents cannot reach even rung 1 ` +
          `under the ${String(CAP)}-cent cap, so the game would not have accepted it.`,
      ),
    ]);
    expect(verifyRound(withClaim(honest, 0, () => ({ status: 'lost' as never }))).problems).toEqual([
      'Balloon 1: the server says it has a status the game does not have ("lost"), ' +
        'the replay says it cashed out.',
    ]);
  });
});

describe('the docs/fairness.md worked round with a Patch save', () => {
  // Server seed and client seed from the doc, nonce 3, balloon 0, Easy, RTP 97%.
  const DOC_SEED = 'a4d93ce3d9f9e3f860e6275882ff4ecdfdb3adc0e87e99e1bc07b8ab1beeff14';
  const easy = DIFFICULTIES.find((d) => d.id === 'easy');
  if (easy === undefined) throw new Error('no easy ladder');
  // The doc gives no bet: it only changes the Patch price and the top rung.
  // 100 cents never meets the cap on Easy, so its top rung is the ladder's end.
  // Patch for pump 2: ceil(100 * 101 * (111 - 101) * 100 / (111 * 9700)) = ceil(9.38) = 10.
  const BET = 100;
  const draws: DrawRecord[] = [
    { drawIndex: 0, den: 101, num: 97, roll: 84 }, // survives: rung 1
    { drawIndex: 1, den: 111, num: 101, roll: 101 }, // would pop; the Patch saves it
    { drawIndex: 2, den: 111, num: 101, roll: 108 }, // pops
  ];
  const record: RoundRecord = {
    serverSeed: DOC_SEED,
    serverSeedHash: '947d192d090f6845f059ae8e45b1d90105b3a34cfdcf209e7369fda4b5d60071',
    clientSeed: 'myseed',
    nonce: 3,
    difficultyId: 'easy',
    rtpBp: 9700,
    ladder: easy.ladder,
    maxPayoutCents: CAP,
    balloons: [
      {
        betCents: BET,
        actions: [
          { kind: 'pump', patch: false },
          { kind: 'pump', patch: true },
          { kind: 'pump', patch: false },
        ],
        status: 'popped',
        rung: 1,
        drawIndex: 3,
        topRung: easy.ladder.length,
        patchesCents: 10,
        payoutCents: 0,
        draws,
      },
    ],
  };

  it('verifies, with the doc’s messages, numbers and rolls', () => {
    expect(easy.ladder.slice(0, 3)).toEqual([101, 111, 123]);
    const check = verifyRound(record);
    expect(check.problems).toEqual([]);
    expect(check.balloons[0]?.draws).toEqual([
      {
        ...draws[0],
        survived: true,
        patched: false,
        block: 0,
        wordIndex: 0,
        word: 228159387,
        message: 'myseed:3:0:0:0',
      },
      {
        ...draws[1],
        survived: false,
        patched: true,
        block: 0,
        wordIndex: 0,
        word: 621571796,
        message: 'myseed:3:0:1:0',
      },
      {
        ...draws[2],
        survived: false,
        patched: false,
        block: 0,
        wordIndex: 0,
        word: 498186423,
        message: 'myseed:3:0:2:0',
      },
    ]);
  });

  it('catches the doc’s common mistake: the rung 3 chance on the third press', () => {
    const mistaken = withDraw(record, 0, 2, () => ({ num: 37, den: 41, roll: 15 }));
    expect(verifyRound(mistaken).problems).toEqual([
      'Balloon 1, pump 3 (draw index 2): the server says the survival chance was 37/41, ' +
        "the round's RTP and ladder give 101/111.",
      'Balloon 1, pump 3 (draw index 2): the server says roll 15, the seeds give 108.',
    ]);
  });
});
