import { GAME_CONFIG } from '@pump/engine';
import { useEffect, useState } from 'react';
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
import type { AutoPlaySettings } from './game/autoPlay';
import { checkBets, type BetSetup } from './game/betSetup';
import { useAutoPlay } from './game/useAutoPlay';
import { useGame, type GameEvent } from './game/useGame';
import { useSessionClock } from './game/useSessionClock';
import { roundWinTier } from './game/winTier';
import { market } from './market';
import { formatCents, formatElapsed, formatSignedCents, parseDollarsToCents } from './money';
import { useMotionSetting } from './motion';
import { cuesFor } from './sound/cues';
import { soundBoard } from './sound/SoundBoard';

const config = GAME_CONFIG;

/** How the next round is played: by hand, or by auto-play. */
type Mode = 'manual' | 'auto';

/** Every game event goes to the speaker; cuesFor decides what it sounds like. */
function playEventSound(event: GameEvent): void {
  for (const toPlay of cuesFor(event)) soundBoard.play(toPlay.cue, toPlay.height, toPlay.delay);
}

/**
 * The balloon the buttons and keys act on: the one the player picked, if it
 * is still in play. It never jumps to another balloon by itself; otherwise
 * a tap or a Space meant for a balloon that just popped would pump a
 * different one.
 */
function keyboardTarget(round: RoundView | null, chosen: number): number | null {
  if (!round || round.status !== 'active') return null;
  return round.balloons[chosen]?.status === 'active' ? chosen : null;
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
  const game = useGame(gameClient, playEventSound);
  const { state } = game;
  const autoPlay = useAutoPlay(game.actions);
  const [setup, setSetup] = useState<BetSetup>({
    difficultyId: config.difficulties[0]?.id ?? '',
    bets: ['1.00'],
  });
  const [mode, setMode] = useState<Mode>('manual');
  const [chosen, setChosen] = useState(0);
  const [muted, setMuted] = useState(soundBoard.muted);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const motion = useMotionSetting();
  const sessionMs = useSessionClock(state.session?.startedAt ?? null);

  const round = state.round;
  const roundActive = round?.status === 'active';
  const roundWin = round ? roundWinTier(round) : null;
  // Net position since this visit began (UK RTS 2E). No deposits happen
  // here, so it is the change in balance.
  const sessionNet =
    state.wallet && state.session
      ? state.wallet.balanceCents - state.session.startBalanceCents
      : null;
  const autoRunning = autoPlay.status.running;
  const balance = state.wallet?.balanceCents ?? 0;
  const check = checkBets(setup, config.limits, balance);
  const target = autoRunning ? null : keyboardTarget(round, chosen);
  const targetBalloon = target === null ? null : (round?.balloons[target] ?? null);
  const setupDifficulty =
    config.difficulties.find((d) => d.id === setup.difficultyId) ?? config.difficulties[0];
  const autoOffered = market.autoPlay && setupDifficulty !== undefined && state.phase === 'ready';
  // What the panel shows: Stop while auto-play runs, the round's buttons
  // during a round played by hand, and the bet otherwise.
  const panel = autoRunning ? 'auto-running' : roundActive ? 'round' : 'bet';

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
    });
  };

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

  // Keyboard play. Held keys don't repeat: one press is one action.
  // While auto-play runs, only Esc (stop) and M (sound) do anything.
  // While settings is open, no key plays the game: Esc closes the sheet.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (settingsOpen) return;
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === 'Escape') {
        if (autoRunning) autoPlay.stop();
        return;
      }
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
          if (!event.repeat && target !== null) game.pump(target, false);
          break;
        case 'p':
        case 'P':
          if (!event.repeat && target !== null) game.pump(target, true);
          break;
        case 'c':
        case 'C':
          if (!event.repeat && target !== null) game.cashOut(target);
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
    return () => window.removeEventListener('keydown', onKeyDown);
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
            <History config={config} rounds={state.history} />
            <GameInfo config={config} autoPlay={market.autoPlay} />
          </SettingsMenu>
        </div>
      </header>

      <main className="layout">
        <section className="stage" aria-label="Balloons">
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
                      ladder={round.ladder}
                      beat={state.beats[balloon.index] ?? 'idle'}
                      patched={state.patched[balloon.index] ?? false}
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
                pending={target !== null && (state.pending[target] ?? false)}
                onPump={() => {
                  if (target !== null) game.pump(target, false);
                }}
                onPatchPump={() => {
                  if (target !== null) game.pump(target, true);
                }}
                onCashOut={() => {
                  if (target !== null) game.cashOut(target);
                }}
              />
            )}

            {panel === 'bet' && (
              <>
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
              </>
            )}

            {/* Always mounted, so the typed auto-play settings are kept. */}
            {autoOffered && (
              <div hidden={!(panel === 'auto-running' || (panel === 'bet' && mode === 'auto'))}>
                <AutoPlayPanel
                  maxPumps={setupDifficulty.ladder.length}
                  roundBetCents={check.totalCents}
                  betsValid={check.betsCents !== null}
                  roundActive={roundActive && !autoRunning}
                  starting={state.starting && !autoRunning}
                  status={autoPlay.status}
                  onStart={startAutoPlay}
                  onStop={autoPlay.stop}
                />
              </div>
            )}
          </aside>
        )}
      </main>
    </div>
  );
}

/** The round's net result, shown over the stage once the round is over. */
function RoundResult({ round }: { readonly round: RoundView }) {
  const spent = round.balloons.reduce((sum, b) => sum + b.betCents + b.patchesCents, 0);
  const paid = round.balloons.reduce((sum, b) => sum + b.payoutCents, 0);
  const net = paid - spent;
  return (
    <div
      className={net > 0 ? 'round-result win' : 'round-result'}
      role="status"
      title={`Spent ${formatCents(spent)}, paid ${formatCents(paid)}`}
    >
      Net <strong>{formatSignedCents(net)}</strong>
    </div>
  );
}
