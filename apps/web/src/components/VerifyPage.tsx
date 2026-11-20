import { multiplierAt, type GameConfig } from '@pump/engine';
import {
  bytesToHex,
  drawMessage,
  hashServerSeed,
  hmacSha256,
  isServerSeed,
  verifyRound,
  type BalloonCheck,
  type CheckedDraw,
  type RoundCheck,
} from '@pump/engine/fair';
import { useEffect, useMemo, useState } from 'react';
import { ApiFailure, NetworkFailure, type GameClient } from '../api/client';
import type { BalloonStatus, RoundSummary, VerifiableBalloon, VerifiableRound } from '../api/contract';
import { centsToInput, formatCents, formatMultiplier, formatSignedCents, parseDollarsToCents } from '../money';
import { actionsToText, textToActions } from '../verify/actionsText';

interface VerifyPageProps {
  readonly client: GameClient;
  readonly config: GameConfig;
  /** Recent finished rounds, newest first. */
  readonly rounds: readonly RoundSummary[];
  /** A round to open straight away, or null. */
  readonly initialRoundId: string | null;
  /** The seed can be rotated now: no round or auto-play in progress. */
  readonly canRotate: boolean;
  readonly onRotate: () => void;
  readonly onBack: () => void;
}

const timeOfDay = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function describeFailure(error: unknown): string {
  if (error instanceof ApiFailure || error instanceof NetworkFailure) return error.message;
  return 'The round could not be loaded.';
}

/**
 * The verify page. A player picks a finished round whose server seed has
 * been revealed, and the page recomputes every pump in the browser with the
 * engine package the server uses: @pump/engine/fair verifyRound replays each
 * balloon with the engine's own rules and draws from the seeds, and lists
 * every place where the record differs. This page only shows the result.
 */
export function VerifyPage({
  client,
  config,
  rounds,
  initialRoundId,
  canRotate,
  onRotate,
  onBack,
}: VerifyPageProps) {
  const [roundId, setRoundId] = useState<string | null>(initialRoundId);
  const [idText, setIdText] = useState('');
  const label = (id: string): string => config.difficulties.find((d) => d.id === id)?.label ?? id;
  const anyUnrevealed = rounds.some((r) => !r.seedRevealed);

  return (
    <main className="verify" aria-labelledby="verify-title">
      <div className="verify-inner">
        <div className="verify-head">
          <h1 id="verify-title">Verify a round</h1>
          <button type="button" className="btn btn-small" onClick={onBack}>
            Back to game
          </button>
        </div>
        <p className="hint">
          Every pump is decided by the server seed, your client seed and the round’s nonce. Once
          the server seed is revealed, this page works out every pump again in your browser and
          checks it against what was recorded and paid.
        </p>

        <section className="card panel" aria-labelledby="verify-pick">
          <h2 id="verify-pick">Pick a round</h2>
          {rounds.length === 0 ? (
            <p className="hint">No finished rounds yet.</p>
          ) : (
            <ul className="verify-rounds">
              {rounds.map((r) => {
                const net = r.payoutCents - r.betCents - r.patchesCents;
                return (
                  <li key={r.id} data-current={roundId === r.id}>
                    <span>
                      {timeOfDay.format(new Date(r.finishedAt))} · {label(r.difficultyId)} ·{' '}
                      {r.balloonCount} balloon{r.balloonCount === 1 ? '' : 's'} ·{' '}
                      <span className={net > 0 ? 'win' : 'muted'}>{formatSignedCents(net)}</span>
                    </span>
                    {r.seedRevealed ? (
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-pressed={roundId === r.id}
                        onClick={() => setRoundId(r.id)}
                      >
                        Check
                      </button>
                    ) : (
                      <span className="muted">Seed in use</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {anyUnrevealed && (
            <div className="verify-rotate">
              <p className="hint">
                Rounds on your current server seed can be checked once you rotate it, which
                reveals it.
              </p>
              <button type="button" className="btn btn-small" disabled={!canRotate} onClick={onRotate}>
                Rotate server seed
              </button>
              {!canRotate && <p className="hint">Finish the round in play first.</p>}
            </div>
          )}
          <form
            className="verify-id"
            onSubmit={(event) => {
              event.preventDefault();
              const id = idText.trim();
              if (id !== '') setRoundId(id);
            }}
          >
            <label htmlFor="verify-round-id">Round id</label>
            <input
              id="verify-round-id"
              type="text"
              value={idText}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setIdText(event.target.value)}
            />
            <button type="submit" className="btn btn-small" disabled={idText.trim() === ''}>
              Load
            </button>
          </form>
        </section>

        {roundId !== null && <RoundLoader key={roundId} client={client} roundId={roundId} />}
      </div>
    </main>
  );
}

/** Fetches one round's record, then hands it to the workbench. */
function RoundLoader({ client, roundId }: { readonly client: GameClient; readonly roundId: string }) {
  const [loaded, setLoaded] = useState<
    { readonly record: VerifiableRound } | { readonly error: string } | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    client.getVerifiableRound(roundId).then(
      (record) => {
        if (!cancelled) setLoaded({ record });
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ error: describeFailure(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, roundId]);

  if (loaded === null) return <p className="hint">Loading the round…</p>;
  if ('error' in loaded) {
    return (
      <p className="notice notice-error" role="status">
        {loaded.error}
      </p>
    );
  }
  return <Workbench key={loaded.record.id} record={loaded.record} />;
}

/** The inputs as the player can edit them: all text. */
interface RoundForm {
  readonly serverSeed: string;
  readonly serverSeedHash: string;
  readonly clientSeed: string;
  readonly nonce: string;
  readonly rtpBp: string;
  readonly ladder: string;
  readonly balloons: readonly { readonly bet: string; readonly topRung: string; readonly actions: string }[];
}

function formFrom(record: VerifiableRound): RoundForm {
  return {
    serverSeed: record.serverSeed,
    serverSeedHash: record.serverSeedHash,
    clientSeed: record.clientSeed,
    nonce: String(record.nonce),
    rtpBp: String(record.rtpBp),
    ladder: record.ladder.join(', '),
    balloons: record.balloons.map((b) => ({
      bet: centsToInput(b.betCents),
      topRung: String(b.topRung),
      actions: actionsToText(b.actions),
    })),
  };
}

function parseWhole(text: string): number | null {
  const t = text.trim();
  return /^\d{1,15}$/.test(t) ? Number(t) : null;
}

/**
 * Builds the round to check from the edited text. What was recorded (each
 * balloon's end state and draws, and the payout cap) is kept from the record:
 * those are the claims being checked, not inputs.
 */
function roundFrom(
  form: RoundForm,
  record: VerifiableRound,
): { readonly round: VerifiableRound } | { readonly errors: readonly string[] } {
  const errors: string[] = [];
  const nonce = parseWhole(form.nonce);
  if (nonce === null) errors.push('Nonce: a whole number, 0 or more.');
  const rtpBp = parseWhole(form.rtpBp);
  if (rtpBp === null) errors.push('RTP: a whole number of basis points, like 9700.');
  const ladder = form.ladder
    .trim()
    .split(/[\s,]+/)
    .filter((part) => part !== '')
    .map(parseWhole);
  if (ladder.length === 0 || ladder.some((h) => h === null)) {
    errors.push('Ladder: whole numbers in hundredths, like 101, 111, 123.');
  }
  const balloons = form.balloons.map((b, i): VerifiableBalloon => {
    const recorded = record.balloons[i];
    const betCents = parseDollarsToCents(b.bet);
    if (betCents === null) errors.push(`Balloon ${i + 1} bet: an amount like 1.00.`);
    const topRung = parseWhole(b.topRung);
    if (topRung === null) errors.push(`Balloon ${i + 1} top rung: a whole number.`);
    const parsed = textToActions(b.actions);
    if ('error' in parsed) errors.push(`Balloon ${i + 1} steps: ${parsed.error}`);
    return {
      betCents: betCents ?? 0,
      topRung: topRung ?? 0,
      actions: 'actions' in parsed ? parsed.actions : [],
      status: recorded?.status ?? 'active',
      rung: recorded?.rung ?? 0,
      drawIndex: recorded?.drawIndex ?? 0,
      patchesCents: recorded?.patchesCents ?? 0,
      payoutCents: recorded?.payoutCents ?? 0,
      draws: recorded?.draws ?? [],
    };
  });
  if (errors.length > 0) return { errors };
  return {
    round: {
      ...record,
      serverSeed: form.serverSeed.trim(),
      serverSeedHash: form.serverSeedHash.trim(),
      clientSeed: form.clientSeed.trim(),
      nonce: nonce ?? 0,
      rtpBp: rtpBp ?? 0,
      ladder: ladder.map((h) => h ?? 0),
      balloons,
    },
  };
}

/** Runs the engine's checker. It throws only on values of the wrong type, which roundFrom never builds. */
function check(round: VerifiableRound): RoundCheck | { readonly error: string } {
  try {
    return verifyRound(round);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'This round could not be checked.' };
  }
}

/** The round's inputs, editable, and the check worked out from them. */
function Workbench({ record }: { readonly record: VerifiableRound }) {
  const [form, setForm] = useState<RoundForm>(() => formFrom(record));
  const edited = JSON.stringify(form) !== JSON.stringify(formFrom(record));
  const built = useMemo(() => roundFrom(form, record), [form, record]);
  const result = useMemo(() => ('round' in built ? check(built.round) : null), [built]);

  const field = (
    id: string,
    labelText: string,
    value: string,
    onChange: (value: string) => void,
    mono = false,
  ) => (
    <label className="verify-field" htmlFor={id}>
      <span className="verify-label">{labelText}</span>
      <input
        id={id}
        className={mono ? 'mono' : undefined}
        type="text"
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );

  return (
    <>
      <section className="card panel" aria-labelledby="verify-inputs">
        <div className="verify-head">
          <h2 id="verify-inputs">The round’s inputs</h2>
          {edited && (
            <button type="button" className="btn btn-small" onClick={() => setForm(formFrom(record))}>
              Reset to the recorded round
            </button>
          )}
        </div>
        <p className="hint">
          Round <code>{record.id}</code>, played with a payout cap of{' '}
          {formatCents(record.maxPayoutCents)} per balloon. Change any input to see that a
          different seed gives different results.
        </p>
        <div className="verify-grid">
          {field('v-server-seed', 'Server seed (revealed)', form.serverSeed, (v) => setForm({ ...form, serverSeed: v }), true)}
          {field('v-server-hash', 'Server seed hash (shown before the round)', form.serverSeedHash, (v) => setForm({ ...form, serverSeedHash: v }), true)}
          {field('v-client-seed', 'Client seed', form.clientSeed, (v) => setForm({ ...form, clientSeed: v }), true)}
          {field('v-nonce', 'Nonce', form.nonce, (v) => setForm({ ...form, nonce: v }))}
          {field('v-rtp', 'RTP (basis points)', form.rtpBp, (v) => setForm({ ...form, rtpBp: v }))}
          {field('v-ladder', 'Ladder (hundredths)', form.ladder, (v) => setForm({ ...form, ladder: v }), true)}
        </div>
        {form.balloons.map((b, i) => {
          const setBalloon = (change: Partial<RoundForm['balloons'][number]>) =>
            setForm({
              ...form,
              balloons: form.balloons.map((x, j) => (j === i ? { ...x, ...change } : x)),
            });
          return (
            <div className="verify-grid verify-balloon" key={i}>
              {field(`v-bet-${i}`, `Balloon ${i + 1} bet ($)`, b.bet, (v) => setBalloon({ bet: v }))}
              {field(`v-top-${i}`, 'Top rung', b.topRung, (v) => setBalloon({ topRung: v }))}
              {field(`v-steps-${i}`, 'Steps (P pump, P+ Patch + Pump, C cash out)', b.actions, (v) => setBalloon({ actions: v }), true)}
            </div>
          );
        })}
      </section>

      {'errors' in built || (result !== null && 'error' in result) ? (
        <section className="card panel verify-verdict" data-verdict="cannot-check" role="status">
          <strong>These inputs can’t be checked.</strong>
          <ul>
            {('errors' in built ? built.errors : result !== null && 'error' in result ? [result.error] : []).map(
              (e) => (
                <li key={e}>{e}</li>
              ),
            )}
          </ul>
        </section>
      ) : (
        result !== null && 'round' in built && <Results result={result} round={built.round} />
      )}
    </>
  );
}

function Results({ result, round }: { readonly result: RoundCheck; readonly round: VerifiableRound }) {
  const computedHash = isServerSeed(round.serverSeed) ? hashServerSeed(round.serverSeed) : null;
  return (
    <>
      <section
        className="card panel verify-verdict"
        data-verdict={result.ok ? 'match' : 'mismatch'}
        role="status"
      >
        <strong>
          {result.ok
            ? '✓ This round checks out. Every pump, worked out again from the seeds, gives exactly what was recorded and paid.'
            : '✗ This round does not match what was recorded.'}
        </strong>
        {result.problems.length > 0 && (
          <ul>
            {result.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="card panel" aria-labelledby="verify-seed">
        <h2 id="verify-seed">Server seed</h2>
        <p className="verify-line">
          SHA-256 of the server seed: <code>{computedHash ?? '—'}</code>
        </p>
        <p className="verify-line" data-ok={result.seedHashMatches}>
          {result.seedHashMatches
            ? '✓ Same as the hash shown before the round, so the seed was fixed before you played.'
            : '✗ Not the hash shown before the round.'}
        </p>
      </section>

      {result.balloons.map((b) => (
        <BalloonResult key={b.balloonIndex} check={b} round={round} />
      ))}
    </>
  );
}

type DrawOutcome = 'survived' | 'saved' | 'popped' | 'top';

const OUTCOME_TEXT: Readonly<Record<DrawOutcome, string>> = {
  survived: 'Survived',
  saved: 'Would pop: Patch saved it',
  popped: 'Popped',
  top: 'Survived: top rung, cashed out',
};

/**
 * Labels each recomputed draw for display: the rung it tried for (a Patch
 * save keeps the rung, so the next pump tries for the same rung again) and
 * what it did. The checking itself is verifyRound's.
 */
function labelDraws(
  draws: readonly CheckedDraw[],
  topRung: number,
): { readonly draw: CheckedDraw; readonly targetRung: number; readonly outcome: DrawOutcome }[] {
  let rung = 0;
  return draws.map((draw) => {
    const targetRung = rung + 1;
    let outcome: DrawOutcome;
    if (draw.survived) {
      rung = targetRung;
      outcome = rung === topRung ? 'top' : 'survived';
    } else {
      outcome = draw.patched ? 'saved' : 'popped';
    }
    return { draw, targetRung, outcome };
  });
}

/** A balloon's end state, as the record or the replay has it. */
interface BalloonEnd {
  readonly status: BalloonStatus;
  readonly rung: number;
  readonly drawIndex: number;
  readonly patchesCents: number;
  readonly payoutCents: number;
}

const STATUS_TEXT: Readonly<Record<BalloonStatus, string>> = {
  active: 'Still in play',
  popped: 'Popped',
  cashed: 'Cashed out',
  refunded: 'Refunded',
};

function multiplierText(ladder: readonly number[], rung: number): string {
  return rung >= 1 && rung <= ladder.length ? ` (${formatMultiplier(multiplierAt(ladder, rung))})` : '';
}

function describeEnd(end: BalloonEnd, ladder: readonly number[]): string {
  return [
    STATUS_TEXT[end.status],
    `rung ${end.rung}${multiplierText(ladder, end.rung)}`,
    `${end.drawIndex} draw${end.drawIndex === 1 ? '' : 's'}`,
    `Patches ${formatCents(end.patchesCents)}`,
    `paid ${formatCents(end.payoutCents)}`,
  ].join(' · ');
}

function BalloonResult({ check, round }: { readonly check: BalloonCheck; readonly round: VerifiableRound }) {
  const recorded = round.balloons[check.balloonIndex];
  if (!recorded) return null;
  const rows = labelDraws(check.draws, recorded.topRung);
  // The exact message whose HMAC gave each roll (block 1+ only in the rare
  // case that every word of block 0 was rejected).
  const messageOf = (d: CheckedDraw): string =>
    d.block === 0
      ? d.message
      : drawMessage({
          clientSeed: round.clientSeed,
          nonce: round.nonce,
          balloonIndex: check.balloonIndex,
          drawIndex: d.drawIndex,
          block: d.block,
        });

  return (
    <section className="card panel" aria-labelledby={`verify-b${check.balloonIndex}`}>
      <h2 id={`verify-b${check.balloonIndex}`}>
        Balloon {check.balloonIndex + 1} · bet {formatCents(recorded.betCents)}
      </h2>

      {rows.length === 0 ? (
        <p className="hint">No pumps: no draw was made on this balloon.</p>
      ) : (
        <>
          <div className="table-scroll">
            <table className="verify-table">
              <thead>
                <tr>
                  <th scope="col" className="num">Draw</th>
                  <th scope="col">Tries for</th>
                  <th scope="col">Message</th>
                  <th scope="col" className="num">Roll</th>
                  <th scope="col">Survives if</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ draw: d, targetRung, outcome }) => (
                  <tr key={d.drawIndex}>
                    <td className="num">{d.drawIndex}</td>
                    <td>
                      rung {targetRung}
                      {multiplierText(round.ladder, targetRung)}
                      {d.patched ? ' · Patch' : ''}
                    </td>
                    <td>
                      <code>{messageOf(d)}</code>
                    </td>
                    <td className="num">{d.roll}</td>
                    <td>
                      roll &lt; {d.num} of {d.den}
                    </td>
                    <td>{OUTCOME_TEXT[outcome]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="verify-bytes">
            <summary>Show the bytes behind each roll</summary>
            <ol start={0}>
              {check.draws.map((d) => {
                const message = messageOf(d);
                return (
                  <li key={d.drawIndex}>
                    <code>{message}</code> → HMAC-SHA256{' '}
                    <code>
                      {isServerSeed(round.serverSeed)
                        ? bytesToHex(hmacSha256(round.serverSeed, message))
                        : '—'}
                    </code>{' '}
                    → word {d.wordIndex}
                    {d.block > 0 ? ` of block ${d.block}` : ''} = {d.word} → {d.word} mod {d.den} ={' '}
                    {d.roll}
                  </li>
                );
              })}
            </ol>
          </details>
        </>
      )}

      <p className="verify-line">Recorded: {describeEnd(recorded, round.ladder)}</p>
      {check.balloon !== null && (
        <p className="verify-line" data-ok={check.ok}>
          {check.ok
            ? '✓ Recomputed: the same.'
            : `✗ Recomputed: ${describeEnd(check.balloon, round.ladder)}`}
        </p>
      )}
      {check.problems.length > 0 && (
        <ul className="verify-diff">
          {check.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
