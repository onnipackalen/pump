import { GAME_CONFIG } from '@pump/engine';
import { useEffect, useRef, useState } from 'react';
import { gameClient } from './api';
import type { RoundView } from './api/contract';
import { AutoPlayPanel } from './components/AutoPlayPanel';
import { BalloonCard, PreviewCard } from './components/BalloonCard';
import { BetPanel } from './components/BetPanel';
import { FairnessPanel } from './components/FairnessPanel';
import { GameInfo } from './components/GameInfo';
import { History } from './components/History';
import { RoundControls } from './components/RoundControls';
import { SettingsMenu } from './components/SettingsMenu';
import { SoundToggle } from './components/SoundToggle';
import { VerifyPage } from './components/VerifyPage';
import type { AutoPlaySettings } from './game/autoPlay';
import { checkBets, type BetSetup } from './game/betSetup';
import { controlTarget, panelActivity, showOwnPump, SWITCH_PAUSE_MS } from './game/controls';
import { useAutoPlay } from './game/useAutoPlay';
import { useGame, type GameEvent } from './game/useGame';
import { useHoldPump } from './game/useHoldPump';
import { useSetUpFrom } from './game/setUp';
import { useSessionClock } from './game/useSessionClock';
import {
  roundPayoutCents,
  roundRefundedCents,
  roundStakeCents,
  roundWinTier,
} from './game/winTier';
import { market } from './market';
import { formatCents, formatElapsed, formatSignedCents, parseDollarsToCents } from './money';
import { useMotionSetting } from './motion';
import { shownReveals } from './verify/shownReveals';
import { cuesFor } from './sound/cues';
import { soundBoard } from './sound/SoundBoard';
import { StatsPage } from './stats/StatsPage';

const config = GAME_CONFIG;

/** How the next round is played: by hand, or by auto-play. */
type Mode = 'manual' | 'auto';

/** Which screen is showing. The verify page lives at #verify, the stats at #stats. */
type View = 'game' | 'verify' | 'stats';

function viewFromHash(): View {
  if (window.location.hash === '#verify') return 'verify';
  if (window.location.hash === '#stats') return 'stats';
  return 'game';
}

/** Every game event goes to the speaker; cuesFor decides what it sounds like. */
function playEventSound(event: GameEvent): void {
  for (const toPlay of cuesFor(event)) soundBoard.play(toPlay.cue, toPlay.height, toPlay.delay);
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/** A focused control handles Space and Enter itself: they press it. */
function isControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('button, summary, a[href], [role="button"], [role="radio"], [role="switch"]') !==
      null
  );
}

/** True when nothing on the page has focus, so Enter can mean "bet". */
function nothingFocused(target: EventTarget | null): boolean {
  return target === document.body || target === document.documentElement;
}

/** Taps unlock sound when the finger lifts; mouse and keys unlock it at once. */
const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;

/**
 * The whole game on one screen that never scrolls: a top bar, the balloons,
 * and one control panel. The panel shows only what the next tap needs: the
 * bet before a round, the picked balloon's buttons during one, and Stop
 * while auto-play runs. Everything else is in settings.
 */
export function App() {
  // The balloon the player picked. The controls act on it while it is in
  // play, then move on to the next one (see controlTarget).
  const [chosen, setChosen] = useState(0);
  // True for a moment after the controls moved on (SWITCH_PAUSE_MS).
  const [switchPause, setSwitchPause] = useState(false);
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pauseTimer.current), []);

  const onGameEvent = (event: GameEvent): void => {
    playEventSound(event);
    // The picked balloon just popped or cashed out: move the controls to the
    // next one still in play, and pause them for a moment.
    if (event.kind !== 'pump' && event.kind !== 'cash-out') return;
    if (event.balloon.status === 'active' || event.balloon.index !== chosen) return;
    const next = controlTarget(event.round, chosen);
    if (next === null) return;
    setChosen(next);
    clearTimeout(pauseTimer.current);
    setSwitchPause(true);
    pauseTimer.current = setTimeout(() => setSwitchPause(false), SWITCH_PAUSE_MS);
  };

  const game = useGame(gameClient, onGameEvent);
  const { state } = game;
  const autoPlay = useAutoPlay(game.actions);
  const [setup, setSetup] = useState<BetSetup>({
    difficultyId: config.difficulties[0]?.id ?? '',
    bets: ['1.00'],
  });
  const [mode, setMode] = useState<Mode>('manual');
  const [muted, setMuted] = useState(soundBoard.muted);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<View>(viewFromHash);
  const [verifyRoundId, setVerifyRoundId] = useState<string | null>(null);
  const motion = useMotionSetting();
  const sessionMs = useSessionClock(state.session?.startedAt ?? null);

  const round = state.round;
  // How the balloons before this round ended, so each new pump sets up
  // from the picture that was in its place (game/setUp.ts).
  const setUp = useSetUpFrom(round);
  const roundActive = round?.status === 'active';
  const roundWin = round ? roundWinTier(round) : null;
  // Where each cashed-out balloon would have popped: only once the round is
  // over and every balloon's last motion has finished, so it never shows
  // during play or over a pop, cash-out or win.
  const afterRoundShown =
    round?.status === 'finished' &&
    state.beats.every((beat) => beat === 'idle') &&
    !state.pending.some(Boolean);
  // Keep the lines as they go on screen, so the verify page can check later
  // that the round's record says the same.
  useEffect(() => {
    if (afterRoundShown) shownReveals.remember(round);
  }, [afterRoundShown, round]);
  // And each balloon's top rung as the screen first shows the round: a
  // reveal stops there, so the verify page checks the record's top against it.
  useEffect(() => {
    if (round) shownReveals.rememberTops(round);
  }, [round]);
  // Net position since this visit began (UK RTS 2E). No deposits happen
  // here, so it is the change in balance.
  const sessionNet =
    state.wallet && state.session
      ? state.wallet.balanceCents - state.session.startBalanceCents
      : null;
  const autoRunning = autoPlay.status.running;
  const balance = state.wallet?.balanceCents ?? 0;
  const check = checkBets(setup, config.limits, balance);
  const target = autoRunning ? null : controlTarget(round, chosen);
  const targetBalloon = target === null ? null : (round?.balloons[target] ?? null);
  const setupDifficulty =
    config.difficulties.find((d) => d.id === setup.difficultyId) ?? config.difficulties[0];
  const autoOffered = market.autoPlay && setupDifficulty !== undefined && state.phase === 'ready';
  // Whether auto-play may change the bets after a win or a loss (market.ts).
  const autoBetSizing = market.autoPlay && market.autoBetSizing;
  // What the panel shows: Stop while auto-play runs, the round's buttons
  // during a round played by hand, and the bet otherwise.
  const panel = autoRunning ? 'auto-running' : roundActive ? 'round' : 'bet';
  // The balloons still in play in a round played by hand.
  const live =
    panel === 'round' && round
      ? round.balloons.filter((b) => b.status === 'active').map((b) => b.index)
      : [];
  // Holding a Pump button, Space or A keeps pumping.
  const hold = useHoldPump(round, state.pending, game.pump, panel === 'round');

  /**
   * Pump all: one ordinary pump per balloon still in play, each its own
   * draw. A balloon whose last pump is still on its way is left out.
   */
  const pumpAll = (): void => {
    for (const index of live) game.pump(index, false);
  };

  /**
   * Cash out all: ends any hold first, so a held Pump all cannot pump again,
   * then cashes out each balloon in play that has a cash-out value. One whose
   * pump is still on its way cashes out once that answer is in, if it is
   * still in play (useGame queues it).
   */
  const cashOutAll = (): void => {
    hold.stop();
    if (!round) return;
    for (const balloon of round.balloons) {
      if (balloon.status === 'active' && balloon.cashOutCents !== null) {
        game.cashOut(balloon.index);
      }
    }
  };

  /**
   * Cash out (the button or C): ends any hold first, so the hold cannot pump
   * this balloon again. If its pump is still on its way, the cash-out goes
   * once that answer is in and its motion has played, if it is still in
   * play. During a balloon's first pump there is nothing to cash out yet, so
   * this only ends the hold (the button shows no amount then either).
   */
  const cashOutTarget = (): void => {
    hold.stop();
    if (target !== null) game.cashOut(target);
  };

  const holdOne = (index: number): void => {
    if (round) hold.start({ kind: 'one', roundId: round.id, index }, 'pointer');
  };
  const holdAll = (): void => {
    if (round) hold.start({ kind: 'all', roundId: round.id }, 'pointer');
  };

  const start = (): void => {
    if (!check.betsCents || autoRunning) return;
    setChosen(0);
    game.startRound(setup.difficultyId, check.betsCents);
  };

  const startAutoPlay = (settings: AutoPlaySettings): void => {
    if (!check.betsCents || roundActive || autoRunning || state.starting) return;
    setChosen(0);
    autoPlay.start({
      settings,
      difficultyId: setup.difficultyId,
      betsCents: check.betsCents,
      balanceCents: balance,
      limits: config.limits,
    });
  };

  /**
   * The player's own Cash out while auto-play runs. It goes through
   * auto-play, which sends it as the balloon's next step, so the balloon
   * never gets a pump or a second cash-out after it.
   */
  const autoCashOut = (indexes: readonly number[]): void => {
    if (round && autoRunning) autoPlay.cashOut(round, indexes);
  };

  /** Opens the verify page, on a round if one is given. Back returns to the game. */
  const openVerify = (roundId: string | null): void => {
    setVerifyRoundId(roundId);
    setSettingsOpen(false);
    window.location.hash = 'verify';
  };
  const closeVerify = (): void => {
    window.location.hash = '';
  };
  /** Opens the stats page. Back returns to the game. */
  const openStats = (): void => {
    setSettingsOpen(false);
    window.location.hash = 'stats';
  };

  // The browser's own Back and Forward move between the game, #verify and #stats.
  useEffect(() => {
    const onHashChange = (): void => setView(viewFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const toggleSound = (): void => {
    soundBoard.setMuted(!muted);
    setMuted(!muted);
  };

  // Browsers only allow sound after a gesture. Listen in the capture phase so
  // this runs before any button's own handler.
  useEffect(() => {
    const unlock = (): void => soundBoard.unlock();
    for (const name of UNLOCK_EVENTS) window.addEventListener(name, unlock, true);
    return () => {
      for (const name of UNLOCK_EVENTS) window.removeEventListener(name, unlock, true);
    };
  }, []);

  // Keyboard play. The keyboard's own repeats are ignored: one press is one
  // action, except that holding Space or A keeps pumping (the hold sends
  // each pump after the last answer, like holding a Pump button). The key
  // coming up ends the hold. Space, Shift+P and C wait out the pause after the
  // controls move to another balloon.
  // While auto-play runs, only Esc (stop) and M (sound) do anything.
  // While settings is open, no key plays the game: Esc closes the sheet.
  useEffect(() => {
    function onKeyUp(event: KeyboardEvent): void {
      if (event.key === ' ' || event.key === 'a' || event.key === 'A') hold.stop();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (settingsOpen) return;
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === 'Escape') {
        if (autoRunning) autoPlay.stop();
        return;
      }
      // The verify and stats pages are for reading: no key there plays the game.
      if (view !== 'game') return;
      if (event.key === 'm' || event.key === 'M') {
        if (!event.repeat) toggleSound();
        return;
      }
      // Space and Enter on a focused button press that button (Stop, Sound,
      // Cash out...), never something else.
      if ((event.key === ' ' || event.key === 'Enter') && isControl(event.target)) return;
      if (autoRunning) {
        if (event.key === ' ') event.preventDefault();
        return;
      }
      switch (event.key) {
        case ' ':
          event.preventDefault();
          if (!event.repeat && target !== null && !switchPause && round) {
            hold.start({ kind: 'one', roundId: round.id, index: target }, 'key');
          }
          break;
        case 'p':
        case 'P':
          // A Patch spends money, late on many times the bet, so a stray P
          // must not buy one: it takes Shift+P.
          if (!event.shiftKey) break;
          if (!event.repeat && target !== null && !switchPause) game.pump(target, true);
          break;
        case 'c':
        case 'C':
          // C always ends a hold, even when there is nothing to cash out.
          if (event.repeat || switchPause) hold.stop();
          else cashOutTarget();
          break;
        case 'a':
        case 'A':
          if (!event.repeat && round) hold.start({ kind: 'all', roundId: round.id }, 'key');
          break;
        case '1':
        case '2':
        case '3':
          // Drop focus from any button (say, Cash out, just clicked for
          // another balloon), so the next Space acts on the balloon just picked.
          if (document.activeElement instanceof HTMLElement && isControl(document.activeElement)) {
            document.activeElement.blur();
          }
          setChosen(Number(event.key) - 1);
          break;
        case 'Enter':
          // Only with nothing focused, so a stray Enter after using a form or
          // a panel never places a bet.
          if (!nothingFocused(event.target)) return;
          // Enter bets by hand. It never starts auto-play.
          if (!event.repeat && !roundActive && mode === 'manual' && state.phase === 'ready') {
            start();
          }
          break;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  });

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="wordmark">PUMP</span>
          {gameClient.isDemo && (
            <span
              className="badge"
              title="No server yet: rounds are played in this browser, are not provably fair, and reset on refresh."
            >
              Demo
            </span>
          )}
        </div>
        <div className="topbar-right">
          <div className="hud">
            {/* Quiet during auto-play, which changes it every round; the
                auto-play status line reports the net instead. */}
            <strong
              className="balance"
              aria-label="Balance"
              title="Balance"
              aria-live={autoRunning ? 'off' : 'polite'}
            >
              {state.wallet ? formatCents(state.wallet.balanceCents) : '—'}
            </strong>
            {/* Session net and time played, always on screen (UK RTS 2E, 13C). */}
            <span className="session" aria-label="This session">
              <span title="Net result this session">
                {sessionNet === null ? '—' : formatSignedCents(sessionNet)}
              </span>
              {' · '}
              <span title="Time played this session">{formatElapsed(sessionMs)}</span>
            </span>
          </div>
          <SettingsMenu open={settingsOpen} onOpenChange={setSettingsOpen}>
            <div className="card settings-row">
              <span>Sound</span>
              <SoundToggle muted={muted} onToggle={toggleSound} />
            </div>
            <div className="card settings-row">
              <span id="animations-label">Animations</span>
              {/* Off removes movement but keeps the same timing, so results
                  never show sooner (UK RTS 14E). */}
              <button
                type="button"
                className="btn btn-small"
                aria-labelledby="animations-label"
                aria-pressed={motion.animationsOn}
                onClick={motion.toggle}
              >
                {motion.animationsOn ? 'On' : 'Off'}
              </button>
            </div>
            {state.fairness && (
              <FairnessPanel
                fairness={state.fairness}
                revealed={state.revealed}
                locked={roundActive || autoRunning}
                onSaveClientSeed={game.setClientSeed}
                onRotate={game.rotateSeed}
              />
            )}
            <div className="card settings-row">
              <span>Check a round</span>
              <button type="button" className="btn btn-small" onClick={() => openVerify(null)}>
                Verify
              </button>
            </div>
            <div className="card settings-row">
              <span>Your results</span>
              <button type="button" className="btn btn-small" onClick={openStats}>
                Stats
              </button>
            </div>
            <History config={config} rounds={state.history} onVerify={openVerify} />
            <GameInfo
              config={config}
              autoPlay={market.autoPlay}
              autoBetSizing={autoBetSizing}
            />
          </SettingsMenu>
        </div>
      </header>

      {view === 'stats' ? (
        <StatsPage
          client={gameClient}
          config={config}
          latestRoundId={state.history[0]?.id ?? null}
          onVerify={openVerify}
          onBack={closeVerify}
        />
      ) : view === 'verify' ? (
        <VerifyPage
          client={gameClient}
          config={config}
          rounds={state.history}
          initialRoundId={verifyRoundId}
          canRotate={!roundActive && !autoRunning && state.phase === 'ready'}
          onRotate={game.rotateSeed}
          onBack={closeVerify}
        />
      ) : (
      <main className="layout">
        <section
          className="stage"
          aria-label="Balloons"
        >
          <div className="stage-top">
            {state.notice && (
              <div className={`notice notice-${state.notice.tone}`} role="status">
                <span>{state.notice.text}</span>
                <button type="button" className="btn btn-small" onClick={game.dismissNotice}>
                  OK
                </button>
              </div>
            )}
            {round?.status === 'finished' && <RoundResult round={round} />}
          </div>

          {state.phase === 'loading' ? (
            <p className="stage-message">Loading…</p>
          ) : (
            <div className="slots">
              {round
                ? round.balloons.map((balloon) => (
                    <BalloonCard
                      key={`${round.id}-${balloon.index}`}
                      balloon={balloon}
                      rtpBp={round.rtpBp}
                      ladder={round.ladder}
                      beat={state.beats[balloon.index] ?? 'idle'}
                      setUp={setUp[balloon.index]}
                      patched={state.patched[balloon.index] ?? false}
                      outcome={state.outcomes[balloon.index] ?? null}
                      held={state.held[balloon.index] ?? false}
                      pending={state.pending[balloon.index] ?? false}
                      winShown={state.winShownFor === round.id}
                      roundWin={roundWin}
                      quiet={autoRunning}
                      selectable={
                        panel === 'round' &&
                        round.balloons.length > 1 &&
                        balloon.status === 'active'
                      }
                      selected={
                        panel === 'round' && round.balloons.length > 1 && target === balloon.index
                      }
                      onSelect={() => setChosen(balloon.index)}
                      // Its own Pump only while two or more balloons are in
                      // play: with one left, the panel's big button is Pump.
                      canPump={panel === 'round' && showOwnPump(round, balloon)}
                      onPump={() => {
                        setChosen(balloon.index);
                        game.pump(balloon.index, false);
                      }}
                      onPumpHold={() => {
                        setChosen(balloon.index);
                        holdOne(balloon.index);
                      }}
                      afterRoundShown={afterRoundShown}
                    />
                  ))
                : setup.bets.map((text, index) => (
                    <PreviewCard
                      key={index}
                      slot={index + 1}
                      betCents={check.errors[index] === null ? parseDollarsToCents(text) : null}
                    />
                  ))}
            </div>
          )}
        </section>

        {state.phase !== 'loading' && (
          <aside className="controls" aria-label="Controls">
            {panel === 'round' && round && (
              <RoundControls
                balloon={targetBalloon}
                multi={round.balloons.length > 1}
                // The pause after the controls move on greys Cash out and
                // Patch + Pump.
                pending={switchPause}
                // What each balloon is doing. A pump on its way greys Patch +
                // Pump (a press then would be ignored), but not Cash out: it
                // shows no amount then, and waits for that answer (useGame
                // queues it).
                activity={round.balloons.map((b) =>
                  panelActivity(
                    state.pending[b.index] ?? false,
                    state.beats[b.index] ?? 'idle',
                    game.waitingCashOuts[b.index] ?? false,
                  ),
                )}
                onPump={() => {
                  if (target !== null) game.pump(target, false);
                }}
                onPumpHold={() => {
                  if (target !== null) holdOne(target);
                }}
                onPatchPump={() => {
                  if (target !== null) game.pump(target, true);
                }}
                onCashOut={cashOutTarget}
                balloons={round.balloons}
                onCashOutAll={cashOutAll}
                liveCount={live.length}
                onPumpAll={pumpAll}
                onPumpAllHold={holdAll}
              />
            )}

            {/* Always mounted, so the typed auto-play settings are kept. Before the
                bet panel, so on the Auto tab Start is the first thing in the panel. */}
            {autoOffered && (
              <div hidden={!(panel === 'auto-running' || (panel === 'bet' && mode === 'auto'))}>
                <AutoPlayPanel
                  maxPumps={setupDifficulty.ladder.length}
                  roundBetCents={check.totalCents}
                  betsValid={check.betsCents !== null}
                  limits={config.limits}
                  betSizing={autoBetSizing}
                  roundActive={roundActive && !autoRunning}
                  starting={state.starting && !autoRunning}
                  status={autoPlay.status}
                  round={autoRunning ? round : null}
                  onStart={startAutoPlay}
                  onStop={autoPlay.stop}
                  onCashOut={autoCashOut}
                />
              </div>
            )}

            {panel === 'bet' && (
              <>
                <BetPanel
                  config={config}
                  setup={setup}
                  check={check}
                  disabled={state.phase !== 'ready'}
                  starting={state.starting}
                  showBet={mode === 'manual' || !market.autoPlay}
                  onChange={setSetup}
                  onStart={start}
                />
                {/* Last in the panel: how to play is chosen once, the rest every round. */}
                {market.autoPlay && (
                  <div className="segmented" role="radiogroup" aria-label="How to play">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={mode === 'manual'}
                      className="segment"
                      onClick={() => setMode('manual')}
                    >
                      Manual
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={mode === 'auto'}
                      className="segment"
                      onClick={() => setMode('auto')}
                    >
                      Auto
                    </button>
                  </div>
                )}
              </>
            )}
          </aside>
        )}
      </main>
      )}
    </div>
  );
}

/**
 * The round's net result, shown over the stage once the round is over. A
 * refunded bet (the round was left 24 hours before that balloon was pumped)
 * is void: it is neither spent nor paid, so it is left out of the net.
 */
function RoundResult({ round }: { readonly round: RoundView }) {
  const spent = roundStakeCents(round);
  const paid = roundPayoutCents(round);
  const returned = roundRefundedCents(round);
  const net = paid - spent;
  return (
    <div
      className={net > 0 ? 'round-result win' : 'round-result'}
      role="status"
      title={`Spent ${formatCents(spent)}, paid ${formatCents(paid)}${
        returned > 0 ? `, ${formatCents(returned)} in bets returned unplayed` : ''
      }`}
    >
      Net <strong>{formatSignedCents(net)}</strong>
    </div>
  );
}
