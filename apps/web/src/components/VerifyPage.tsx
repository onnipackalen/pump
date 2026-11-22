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
  type CheckedReveal,
  type RoundCheck,
} from '@pump/engine/fair';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiFailure, NetworkFailure, type GameClient } from '../api/client';
import type {
  BalloonStatus,
  DrawRecordView,
  RevealOutcome,
  RoundSummary,
  VerifiableBalloon,
  VerifiableRound,
} from '../api/contract';
import { afterRoundText } from '../game/afterRound';
import { HISTORY_SIZE } from '../game/session';
import { centsToInput, formatCents, formatMultiplier, formatSignedCents, parseDollarsToCents } from '../money';
import { actionsToText, textToActions } from '../verify/actionsText';
import {
  clientSeedFieldLabel,
  noRecordNote,
  nonceFieldLabel,
  recordProblems,
} from '../verify/copyCheck';
import { hashFieldLabel, hashSource, hashVerdict } from '../verify/hashCheck';
import {
  copiesWithSameNonce,
  shownFor,
  type HashStorage,
  type ShownEntry,
  type ShownSeeds,
} from '../verify/shownHashes';
import {
  lastListed,
  listedRounds,
  mayHaveOlder,
  OLDER_PAGE_SIZE,
  roundListStep,
  startRoundList,
  withSeedsKnown,
} from '../verify/roundList';
import { screenAgrees, shownReveals, topAgrees } from '../verify/shownReveals';
import { roundVerdict } from '../verify/verdict';

interface VerifyPageProps {
  readonly client: GameClient;
  readonly config: GameConfig;
  /** The game's list of the newest finished rounds, newest first. */
  readonly rounds: readonly RoundSummary[];
  /** The hashes of the server seeds this browser has rotated out and seen revealed. */
  readonly revealedSeedHashes: readonly string[];
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

const dayAndTime = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** When a round finished: the time of day, and the date too if that was not `today`. */
function finishedWhen(iso: string, today: string): string {
  const at = new Date(iso);
  return at.toDateString() === today ? timeOfDay.format(at) : dayAndTime.format(at);
}

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
 *
 * The hash, client seed and nonce "shown before the round" are this
 * browser's own copy, saved when the round started (verify/shownHashes), not
 * the server's record of them, so the check can catch a server that lies
 * about any of them. The copy is found by the round id the player asked
 * for, never by the id the server put in its answer. Without a copy, the
 * page says so, and also looks for a copy saved with the record's hash and
 * nonce under another id (see copyCheck).
 */
export function VerifyPage({
  client,
  config,
  rounds,
  revealedSeedHashes,
  initialRoundId,
  canRotate,
  onRotate,
  onBack,
}: VerifyPageProps) {
  const [roundId, setRoundId] = useState<string | null>(initialRoundId);
  const [idText, setIdText] = useState('');
  const list = useRoundList(client, rounds);
  const listed = withSeedsKnown(listedRounds(list.state), revealedSeedHashes);
  const anyUnrevealed = listed.some((r) => !r.seedRevealed);
  // Read once, so the dates in the list don't change while it is open.
  const [today] = useState(() => new Date().toDateString());
  const pick = useRef<HTMLElement>(null);
  const check = (id: string): void => {
    setRoundId(id);
    // The check comes up just under this list, which can be long once older
    // rounds are loaded: bring it into view.
    requestAnimationFrame(() => pick.current?.nextElementSibling?.scrollIntoView({ block: 'start' }));
  };

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

        <section ref={pick} className="card panel" aria-labelledby="verify-pick">
          <h2 id="verify-pick">Pick a round</h2>
          <RoundPicker
            config={config}
            rounds={listed}
            current={roundId}
            today={today}
            older={{
              shown: mayHaveOlder(list.state, HISTORY_SIZE),
              loading: list.state.loadingAfter !== null,
              failure: list.state.failure,
            }}
            onCheck={check}
            onOlder={list.loadOlder}
          />
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

/**
 * The list of rounds to pick from: the game's newest rounds, then older
 * pages loaded with the button. The game loads its own list again whenever
 * a round ends or the seed is rotated; the rules for keeping the pages
 * below it right are in verify/roundList.
 */
function useRoundList(client: GameClient, newest: readonly RoundSummary[]) {
  const [state, dispatch] = useReducer(roundListStep, newest, startRoundList);

  useEffect(() => {
    dispatch({ type: 'newest', rounds: newest });
  }, [newest]);

  const loadOlder = (): void => {
    const before = lastListed(state);
    if (before === null || state.loadingAfter !== null) return;
    dispatch({ type: 'asked', before });
    client.getHistoryPage(OLDER_PAGE_SIZE, before).then(
      (page) => dispatch({ type: 'answered', before, page }),
      () => dispatch({ type: 'failed', before }),
    );
  };

  return { state, loadOlder };
}

/** What the "Older rounds" button shows. */
export interface OlderRounds {
  /** Older rounds remain, or may: the button shows. */
  readonly shown: boolean;
  /** A page is on its way. */
  readonly loading: boolean;
  readonly failure: string | null;
}

interface RoundPickerProps {
  readonly config: GameConfig;
  /** Every round listed, newest first. */
  readonly rounds: readonly RoundSummary[];
  /** The round being checked, or null. */
  readonly current: string | null;
  /** Today, as Date.toDateString() gives it: older rounds show their date too. */
  readonly today: string;
  readonly older: OlderRounds;
  readonly onCheck: (roundId: string) => void;
  readonly onOlder: () => void;
}

/**
 * The rounds to pick from, as drawn. Each shows its id, cut to fit: the
 * whole id is there to read on hover and to copy (one click selects it).
 */
export function RoundPicker({ config, rounds, current, today, older, onCheck, onOlder }: RoundPickerProps) {
  const label = (id: string): string => config.difficulties.find((d) => d.id === id)?.label ?? id;
  if (rounds.length === 0) return <p className="hint">No finished rounds yet.</p>;
  return (
    <>
      <ul className="verify-rounds">
        {rounds.map((r) => {
          const net = r.payoutCents - r.betCents - r.patchesCents;
          return (
            <li key={r.id} data-current={current === r.id}>
              <span className="verify-round">
                <span>
                  {finishedWhen(r.finishedAt, today)} · {label(r.difficultyId)} · {r.balloonCount}{' '}
                  balloon{r.balloonCount === 1 ? '' : 's'} ·{' '}
                  <span className={net > 0 ? 'win' : 'muted'}>{formatSignedCents(net)}</span>
                </span>
                <span className="visually-hidden">Round id </span>
                <code className="verify-round-id" title={r.id}>
                  {r.id}
                </code>
              </span>
              {r.seedRevealed ? (
                <button
                  type="button"
                  className="btn btn-small"
                  aria-pressed={current === r.id}
                  onClick={() => onCheck(r.id)}
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
      {older.shown && (
        <div className="verify-older">
          <button
            type="button"
            className="btn btn-small"
            disabled={older.loading}
            aria-busy={older.loading}
            onClick={onOlder}
          >
            {older.loading ? 'Loading…' : 'Older rounds'}
          </button>
        </div>
      )}
      {older.failure !== null && (
        <p className="bet-note error" role="alert">
          {older.failure}
        </p>
      )}
    </>
  );
}

/** What the workbench checks: the round asked for, the server's record, and this browser's copy. */
export interface RoundToCheck {
  /** The round id the player asked for. */
  readonly roundId: string;
  /** The server's answer. Its id should be roundId; if not, that is a problem (copyCheck). */
  readonly record: VerifiableRound;
  /** What this browser saved before round `roundId`, or null if it has no copy. */
  readonly shown: ShownSeeds | null;
  /**
   * With no full copy for `roundId`: the copies saved under other ids with
   * the record's hash and nonce. Empty otherwise.
   */
  readonly elsewhere: readonly ShownEntry[];
}

/**
 * Puts the server's record next to this browser's copy of the round asked
 * for. The copy is looked up by `roundId`, never by `record.id`: otherwise a
 * server could send the record under another id (no copy is found, so
 * nothing is compared), or another round's record (whose copy agrees).
 *
 * With no copy of the client seed and nonce under `roundId`, it also finds
 * any copy saved with the record's hash and nonce under another id: the copy
 * of this same round if the server gave it another id while it was played.
 */
export function roundToCheck(
  roundId: string,
  record: VerifiableRound,
  storage?: HashStorage | null,
): RoundToCheck {
  const shown = shownFor(roundId, storage);
  const full = shown !== null && shown.clientSeed !== null && shown.nonce !== null;
  const elsewhere = full
    ? []
    : copiesWithSameNonce(record.serverSeedHash, record.nonce, roundId, storage);
  return { roundId, record, shown, elsewhere };
}

/**
 * Fetches one round's record, then hands it to the workbench with what this
 * browser saved before that round (hash, client seed, nonce), if anything.
 */
function RoundLoader({ client, roundId }: { readonly client: GameClient; readonly roundId: string }) {
  const [loaded, setLoaded] = useState<RoundToCheck | { readonly error: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    client.getVerifiableRound(roundId).then(
      (record) => {
        if (!cancelled) setLoaded(roundToCheck(roundId, record));
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
  return (
    <Workbench
      roundId={loaded.roundId}
      record={loaded.record}
      shown={loaded.shown}
      elsewhere={loaded.elsewhere}
    />
  );
}

/** The inputs as the player can edit them: all text. */
export interface RoundForm {
  readonly serverSeed: string;
  readonly serverSeedHash: string;
  readonly clientSeed: string;
  readonly nonce: string;
  readonly rtpBp: string;
  readonly ladder: string;
  readonly balloons: readonly { readonly bet: string; readonly topRung: string; readonly actions: string }[];
}

/**
 * The round's own inputs. The hash, client seed and nonce shown before the
 * round are this browser's own copy when it has one (`shown`), and the
 * server's record otherwise. A copy an older version of the game saved has
 * only the hash. Everything else is the server's record.
 */
export function formFrom(record: VerifiableRound, shown: ShownSeeds | null): RoundForm {
  return {
    serverSeed: record.serverSeed,
    serverSeedHash: shown?.serverSeedHash ?? record.serverSeedHash,
    clientSeed: shown?.clientSeed ?? record.clientSeed,
    nonce: String(shown?.nonce ?? record.nonce),
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

/** The round to check, built from the form, or why it can't be. */
export type BuiltRound =
  | { readonly round: VerifiableRound }
  | { readonly errors: readonly string[] };

/**
 * Builds the round to check from the edited text. What was recorded (each
 * balloon's end state, draws and reveal, and the payout cap) is kept from the
 * record: those are the claims being checked, not inputs. A record from
 * before reveals existed has no afterRound, which counts as none.
 */
export function roundFrom(form: RoundForm, record: VerifiableRound): BuiltRound {
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
      afterRound: recorded?.afterRound ?? null,
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

/**
 * Whether the inputs on the page are the round's own: the same values, once
 * read, as the form first filled in (this browser's copy where it has one,
 * the record's otherwise). Spacing and number style don't count. Both are
 * built by roundFrom from the same record, so only the inputs can differ.
 */
export function sameInputs(own: BuiltRound, built: BuiltRound): boolean {
  return 'round' in own && 'round' in built && JSON.stringify(own.round) === JSON.stringify(built.round);
}

/** The round's inputs, editable, and the check worked out from them. */
export function Workbench({ roundId, record, shown, elsewhere }: RoundToCheck) {
  const [form, setForm] = useState<RoundForm>(() => formFrom(record, shown));
  const edited = JSON.stringify(form) !== JSON.stringify(formFrom(record, shown));
  const built = useMemo(() => roundFrom(form, record), [form, record]);
  const own = useMemo(() => roundFrom(formFrom(record, shown), record), [record, shown]);
  const result = useMemo(() => ('round' in built ? check(built.round) : null), [built]);
  const note = noRecordNote(shown);

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
            <button type="button" className="btn btn-small" onClick={() => setForm(formFrom(record, shown))}>
              Reset the inputs
            </button>
          )}
        </div>
        <p className="hint">
          Round <code>{roundId}</code>, played with a payout cap of{' '}
          {formatCents(record.maxPayoutCents)} per balloon. Change any input to see that a
          different seed gives different results.
        </p>
        {note !== null && <p className="hint">{note}</p>}
        <div className="verify-grid">
          {field('v-server-seed', 'Server seed (revealed)', form.serverSeed, (v) => setForm({ ...form, serverSeed: v }), true)}
          {field('v-server-hash', hashFieldLabel(shown?.serverSeedHash ?? null), form.serverSeedHash, (v) => setForm({ ...form, serverSeedHash: v }), true)}
          {field('v-client-seed', clientSeedFieldLabel(shown?.clientSeed ?? null), form.clientSeed, (v) => setForm({ ...form, clientSeed: v }), true)}
          {field('v-nonce', nonceFieldLabel(shown?.nonce ?? null), form.nonce, (v) => setForm({ ...form, nonce: v }))}
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
        result !== null &&
        'round' in built && (
          <Results
            result={result}
            round={built.round}
            roundId={roundId}
            record={record}
            shown={shown}
            elsewhere={elsewhere}
            inputsChanged={!sameInputs(own, built)}
          />
        )
      )}
    </>
  );
}

function Results({
  result,
  round,
  roundId,
  record,
  shown,
  elsewhere,
  inputsChanged,
}: {
  readonly result: RoundCheck;
  /** The round built from the inputs on the page: what `result` checked. */
  readonly round: VerifiableRound;
  /** The round id the player asked for. */
  readonly roundId: string;
  /** The server's record of the round, as it was sent. */
  readonly record: VerifiableRound;
  /** What this browser saved before the round, or null if it has no copy. */
  readonly shown: ShownSeeds | null;
  /** Copies saved under other ids with the record's hash and nonce (see roundToCheck). */
  readonly elsewhere: readonly ShownEntry[];
  /** Some input on the page is not the round's own. */
  readonly inputsChanged: boolean;
}) {
  const computedHash = isServerSeed(round.serverSeed) ? hashServerSeed(round.serverSeed) : null;
  const anyReveal = result.balloons.some((b) => b.afterRound !== null);
  const shownHash = shown?.serverSeedHash ?? null;
  // What this device's screen showed and the record disagrees with: a top
  // rung, or a reveal line the seeds do not give. verifyRound checks the
  // record against itself; only this device knows what it showed.
  const screenProblems = result.balloons.flatMap((b) => {
    const top = topScreenProblem(b, round);
    const screen = screenCheck(b, round);
    if (screen === null || screen.agrees) return top === null ? [] : [top];
    const truth =
      b.afterRound === null
        ? 'the seeds give it no reveal'
        : `worked out from the seeds it is “${describeReveal(b.afterRound, cashedRung(b, round), round.ladder)}”`;
    return [
      ...(top === null ? [] : [top]),
      `Balloon ${b.balloonIndex + 1}: after the round this device showed “${screen.words}”, but ${truth}.`,
    ];
  });
  // The server's record being another round's, or naming another hash,
  // client seed or nonce than this browser saved (under this round's id, or
  // with the same hash and nonce under another), is a problem with the
  // record itself, whatever the inputs say: the round never checks out then.
  const verdict = roundVerdict({
    result,
    recordProblems: recordProblems(roundId, shown, record, elsewhere),
    screenProblems,
    inputsChanged,
    anyReveal,
  });
  return (
    <>
      <section className="card panel verify-verdict" data-verdict={verdict.tone} role="status">
        <strong>{verdict.headline}</strong>
        {verdict.problems.length > 0 && (
          <ul>
            {verdict.problems.map((p) => (
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
          {hashVerdict(
            hashSource(round.serverSeedHash, shownHash, record.serverSeedHash),
            result.seedHashMatches,
          )}
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

/** One row of a draws table: the draw, the rung it tried for, and what it did. */
interface DrawRow {
  readonly draw: CheckedDraw;
  readonly targetRung: number;
  readonly result: string;
}

/**
 * Labels each recomputed draw for display: the rung it tried for (a Patch
 * save keeps the rung, so the next pump tries for the same rung again) and
 * what it did. The checking itself is verifyRound's.
 */
function labelDraws(draws: readonly CheckedDraw[], topRung: number): DrawRow[] {
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
    return { draw, targetRung, result: OUTCOME_TEXT[outcome] };
  });
}

/**
 * Labels a reveal's draws: plain pumps from the cash-out rung up, one rung
 * per draw, so draw i tries for rung cashedRung + 1 + i. Never mixed into a
 * balloon's own draws: those are real pumps, these decided nothing.
 */
function labelRevealDraws(
  draws: readonly CheckedDraw[],
  cashedRung: number,
  topRung: number,
): DrawRow[] {
  return draws.map((draw, i) => {
    const targetRung = cashedRung + 1 + i;
    const result = !draw.survived
      ? 'Would pop'
      : targetRung === topRung
        ? 'Would reach the top'
        : 'Would survive';
    return { draw, targetRung, result };
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

function onLadder(ladder: readonly number[], rung: number): boolean {
  return Number.isSafeInteger(rung) && rung >= 1 && rung <= ladder.length;
}

function multiplierText(ladder: readonly number[], rung: number): string {
  return onLadder(ladder, rung) ? ` (${formatMultiplier(multiplierAt(ladder, rung))})` : '';
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

/** What a reveal shows, in the words the game screen uses. */
interface RevealEnd {
  readonly outcome: RevealOutcome;
  readonly reachedRung: number;
  readonly draws: readonly DrawRecordView[];
}

function describeReveal(
  reveal: Pick<RevealEnd, 'outcome' | 'reachedRung'> | null,
  cashedRung: number,
  ladder: readonly number[],
): string {
  if (reveal === null) return 'nothing';
  const { outcome, reachedRung } = reveal;
  if (!onLadder(ladder, reachedRung)) {
    return `${outcome === 'top' ? 'reached the top' : 'popped'} on rung ${reachedRung}`;
  }
  return afterRoundText(cashedRung, outcome, reachedRung, multiplierAt(ladder, reachedRung));
}

/** The recorded reveal and the recomputed one say the same, draw by draw. */
function sameReveal(recorded: RevealEnd | null, recomputed: CheckedReveal | null): boolean {
  if (recorded === null || recomputed === null) return recorded === recomputed;
  return (
    recorded.outcome === recomputed.outcome &&
    recorded.reachedRung === recomputed.reachedRung &&
    recorded.draws.length === recomputed.draws.length &&
    recorded.draws.every((d, i) => {
      const r = recomputed.draws[i];
      return (
        r !== undefined &&
        d.drawIndex === r.drawIndex &&
        d.den === r.den &&
        d.num === r.num &&
        d.roll === r.roll
      );
    })
  );
}

/** The rung a balloon was cashed out on, as the record has it. */
function cashedRung(check: BalloonCheck, round: VerifiableRound): number {
  return round.balloons[check.balloonIndex]?.rung ?? check.balloon?.rung ?? 0;
}

/**
 * The reveal line this device's screen showed for a balloon, in the game's
 * words, and whether the reveal worked out from the seeds says the same.
 * Null when this device kept no line for it (another device, cleared
 * storage, or no line was shown).
 */
function screenCheck(
  check: BalloonCheck,
  round: VerifiableRound,
): { readonly words: string; readonly agrees: boolean } | null {
  const shown = shownReveals.shownOf(round.id, check.balloonIndex);
  if (shown === null) return null;
  return {
    words: describeReveal(shown, cashedRung(check, round), round.ladder),
    agrees: screenAgrees(shown, check.afterRound),
  };
}

/**
 * The top rung this device showed for a balloon during the round, said as a
 * problem when the record's bet, ladder and payout cap give another one. A
 * reveal stops at the top, so a record with a lower cap could carry a
 * shorter reveal that still checks out against itself. Null when they agree
 * or this device kept no top for the balloon.
 */
function topScreenProblem(check: BalloonCheck, round: VerifiableRound): string | null {
  const shownTop = shownReveals.topOf(round.id, check.balloonIndex);
  const replayedTop = check.balloon?.topRung ?? null;
  if (shownTop === null || replayedTop === null || topAgrees(shownTop, replayedTop)) return null;
  return (
    `Balloon ${String(check.balloonIndex + 1)}: during the round this device showed its top as ` +
    `rung ${String(shownTop)}${multiplierText(round.ladder, shownTop)}, but this record's bet, ` +
    `ladder and payout cap of ${formatCents(round.maxPayoutCents)} put its top at rung ` +
    `${String(replayedTop)}${multiplierText(round.ladder, replayedTop)}.`
  );
}

/** A table of draws, and the bytes behind each roll. */
function DrawTable({
  rows,
  round,
  messageOf,
}: {
  readonly rows: readonly DrawRow[];
  readonly round: VerifiableRound;
  readonly messageOf: (d: CheckedDraw) => string;
}) {
  return (
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
            {rows.map(({ draw: d, targetRung, result }) => (
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
                <td>{result}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="verify-bytes">
        <summary>Show the bytes behind each roll</summary>
        <ol start={rows[0]?.draw.drawIndex ?? 0}>
          {rows.map(({ draw: d }) => {
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
  );
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

  // The reveal the record holds (the server's claim, sent for checking), and
  // the one worked out again from the seeds (verifyRound's, from the
  // replayed balloon). A record from before reveals existed has none. And
  // the line this device's screen showed, if it kept one.
  const recordedReveal: RevealEnd | null = recorded.afterRound ?? null;
  const trueReveal = check.afterRound;
  const revealSame = sameReveal(recordedReveal, trueReveal);
  const recordedWords = describeReveal(recordedReveal, recorded.rung, round.ladder);
  const trueWords = describeReveal(trueReveal, check.balloon?.rung ?? recorded.rung, round.ladder);
  const screen = screenCheck(check, round);

  return (
    <section className="card panel" aria-labelledby={`verify-b${check.balloonIndex}`}>
      <h2 id={`verify-b${check.balloonIndex}`}>
        Balloon {check.balloonIndex + 1} · bet {formatCents(recorded.betCents)}
      </h2>

      {rows.length === 0 ? (
        <p className="hint">No pumps: no draw was made on this balloon.</p>
      ) : (
        <DrawTable rows={rows} round={round} messageOf={messageOf} />
      )}

      <p className="verify-line">Recorded: {describeEnd(recorded, round.ladder)}</p>
      {check.balloon !== null && (
        <p className="verify-line" data-ok={check.ok}>
          {check.ok
            ? '✓ Recomputed: the same.'
            : `✗ Recomputed: ${describeEnd(check.balloon, round.ladder)}`}
        </p>
      )}

      {(recordedReveal !== null || trueReveal !== null || screen !== null) && (
        <>
          <h3>After the round</h3>
          <p className="hint">
            Once the round was over, this balloon was played on with plain pumps (no Patch) on its
            next draws, to show where it would have popped. It decided nothing and moved no money.
          </p>
          {trueReveal !== null && check.balloon !== null && trueReveal.draws.length > 0 && (
            <DrawTable
              rows={labelRevealDraws(trueReveal.draws, check.balloon.rung, check.balloon.topRung)}
              round={round}
              messageOf={messageOf}
            />
          )}
          <p className="verify-line">Recorded: {recordedWords}</p>
          <p className="verify-line" data-ok={revealSame}>
            {revealSame
              ? '✓ Recomputed: the same.'
              : `✗ Recomputed: ${trueWords}${
                  trueWords === recordedWords ? ' (the same words, but from different draws)' : ''
                }`}
          </p>
          {screen !== null && (
            <p className="verify-line" data-ok={screen.agrees}>
              {screen.agrees
                ? `✓ This device showed “${screen.words}”, which matches the seeds.`
                : `✗ This device showed “${screen.words}”, which does not match the seeds.`}
            </p>
          )}
        </>
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
