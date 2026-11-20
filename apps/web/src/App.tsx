import { GAME_CONFIG } from '@pump/engine';
import { useEffect, useState } from 'react';
import { gameClient } from './api';
import type { RoundView } from './api/contract';
import { AutoPlayPanel } from './components/AutoPlayPanel';
import { BalloonCard, PreviewCard } from './components/BalloonCard';
import { BetPanel } from './components/BetPanel';
import { FairnessPanel } from './components/FairnessPanel';
import { History } from './components/History';
import { SoundToggle } from './components/SoundToggle';
import type { AutoPlaySettings } from './game/autoPlay';
import { checkBets, type BetSetup } from './game/betSetup';
import { useAutoPlay } from './game/useAutoPlay';
import { useGame, type GameEvent } from './game/useGame';
import { market } from './market';
import { formatCents, formatSignedCents } from './money';
import { cueFor } from './sound/cues';
import { soundBoard } from './sound/SoundBoard';

const config = GAME_CONFIG;

/** Every game event goes to the speaker; cueFor decides what it sounds like. */
function playEventSound(event: GameEvent): void {
  const toPlay = cueFor(event);
  if (toPlay) soundBoard.play(toPlay.cue, toPlay.height);
}

/**
 * The balloon the keyboard acts on: the one the player picked, if it is
 * still in play. It never jumps to another balloon by itself; otherwise a
 * Space meant for a balloon that just popped would pump a different one.
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

export function App() {
  const game = useGame(gameClient, playEventSound);
  const { state } = game;
  const autoPlay = useAutoPlay(game.actions);
  const [setup, setSetup] = useState<BetSetup>({
    difficultyId: config.difficulties[0]?.id ?? '',
    bets: ['1.00'],
  });
  const [chosen, setChosen] = useState(0);
  const [muted, setMuted] = useState(soundBoard.muted);

  const round = state.round;
  const roundActive = round?.status === 'active';
  const autoRunning = autoPlay.status.running;
  const balance = state.wallet?.balanceCents ?? 0;
  const check = checkBets(setup, config.limits, balance);
  const target = autoRunning ? null : keyboardTarget(round, chosen);
  const setupDifficulty =
    config.difficulties.find((d) => d.id === setup.difficultyId) ?? config.difficulties[0];

  const start = (): void => {
    if (!check.betsCents || autoRunning) return;
    setChosen(0);
    game.startRound(setup.difficultyId, check.betsCents);
  };

  const startAutoPlay = (settings: AutoPlaySettings): void => {
    if (!check.betsCents || roundActive || autoRunning) return;
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

  // Browsers only allow sound after a click or key press, so the first one unlocks it.
  useEffect(() => {
    const unlock = (): void => soundBoard.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // Keyboard play. Held keys don't repeat: one press is one action.
  // While auto-play runs, only Esc (stop) and M (sound) do anything.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === 'Escape') {
        if (autoRunning) autoPlay.stop();
        return;
      }
      if (event.key === 'm' || event.key === 'M') {
        if (!event.repeat) toggleSound();
        return;
      }
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
          setChosen(Number(event.key) - 1);
          break;
        case 'Enter':
          // A focused button already handles Enter itself.
          if (event.target instanceof HTMLButtonElement) return;
          if (!event.repeat && !roundActive && state.phase === 'ready') start();
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
          <SoundToggle muted={muted} onToggle={toggleSound} />
          <div className="balance" aria-live="polite">
            <span className="hint">Balance</span>
            <strong>{state.wallet ? formatCents(state.wallet.balanceCents) : '—'}</strong>
          </div>
        </div>
      </header>

      {state.notice && (
        <div className={`notice notice-${state.notice.tone}`} role="status">
          <span>{state.notice.text}</span>
          <button type="button" className="btn btn-small" onClick={game.dismissNotice}>
            OK
          </button>
        </div>
      )}

      {state.phase === 'loading' && <p className="hint">Loading…</p>}

      {state.phase !== 'loading' && (
        <main className="layout">
          <section className="play" aria-label="Balloons">
            {round?.status === 'finished' && <RoundResult round={round} />}
            <div
              className="stage"
              style={{
                gridTemplateColumns: `repeat(${round?.balloons.length ?? setup.bets.length}, minmax(0, 1fr))`,
              }}
            >
              {round
                ? round.balloons.map((balloon) => (
                    <BalloonCard
                      key={`${round.id}-${balloon.index}`}
                      balloon={balloon}
                      ladder={round.ladder}
                      beat={state.beats[balloon.index] ?? 'idle'}
                      pending={state.pending[balloon.index] ?? false}
                      locked={autoRunning}
                      selected={
                        !autoRunning && chosen === balloon.index && round.balloons.length > 1
                      }
                      onSelect={() => setChosen(balloon.index)}
                      onPump={() => game.pump(balloon.index, false)}
                      onPatchPump={() => game.pump(balloon.index, true)}
                      onCashOut={() => game.cashOut(balloon.index)}
                    />
                  ))
                : setup.bets.map((_, index) => <PreviewCard key={index} slot={index + 1} />)}
            </div>
            <p className="hint keys">
              {roundActive && !autoRunning && target === null && (round?.balloons.length ?? 0) > 1
                ? 'Balloon over. Press 1–3 or click a balloon to pick the next one. '
                : ''}
              Keys: <kbd>Space</kbd> pump · <kbd>P</kbd> patch + pump · <kbd>C</kbd> cash out ·{' '}
              <kbd>1</kbd>–<kbd>3</kbd> pick balloon · <kbd>Enter</kbd> start · <kbd>M</kbd> sound
              {market.autoPlay && (
                <>
                  {' '}
                  · <kbd>Esc</kbd> stop auto-play
                </>
              )}
            </p>
          </section>

          <aside className="side">
            <BetPanel
              config={config}
              setup={setup}
              check={check}
              disabled={roundActive || autoRunning || state.phase !== 'ready'}
              starting={state.starting}
              onChange={setSetup}
              onStart={start}
            />
            {market.autoPlay && setupDifficulty && state.phase === 'ready' && (
              <AutoPlayPanel
                maxPumps={setupDifficulty.ladder.length}
                roundBetCents={check.totalCents}
                betsValid={check.betsCents !== null}
                roundActive={roundActive && !autoRunning}
                status={autoPlay.status}
                onStart={startAutoPlay}
                onStop={autoPlay.stop}
              />
            )}
            {state.fairness && (
              <FairnessPanel
                fairness={state.fairness}
                revealed={state.revealed}
                locked={roundActive || autoRunning}
                onSaveClientSeed={game.setClientSeed}
                onRotate={game.rotateSeed}
              />
            )}
          </aside>

          <History config={config} rounds={state.history} />
        </main>
      )}
    </div>
  );
}

/** The line above the balloons once a round is over. */
function RoundResult({ round }: { readonly round: RoundView }) {
  const spent = round.balloons.reduce((sum, b) => sum + b.betCents + b.patchesCents, 0);
  const paid = round.balloons.reduce((sum, b) => sum + b.payoutCents, 0);
  const net = paid - spent;
  return (
    <div className={net > 0 ? 'round-result win' : 'round-result'} role="status">
      Round over: spent {formatCents(spent)}, paid {formatCents(paid)},{' '}
      <strong>{formatSignedCents(net)}</strong>
    </div>
  );
}
