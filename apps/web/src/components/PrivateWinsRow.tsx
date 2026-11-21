import { useEffect, useEffectEvent, useId, useReducer } from 'react';
import type { GameClient } from '../api/client';
import { send } from '../game/session';
import { askForFreshWins } from '../wins/usePublicWins';

interface PrivateWinsRowProps {
  readonly client: GameClient;
  /** Whether the settings menu is open: the choice is read afresh each time it opens. */
  readonly open: boolean;
}

/** What the row knows: the choice as the server last said it, and what is going on. */
export interface PrivateWinsState {
  /** The server's value; null until it has been read. Never a value the server has not sent. */
  readonly winsPrivate: boolean | null;
  /** Reads on their way. */
  readonly reading: number;
  readonly saving: boolean;
  /** A plain failure to show, or null. */
  readonly failure: string | null;
  /**
   * Saves started so far. A read sent before the latest save may carry the
   * value from before it, so its answer is dropped.
   */
  readonly saves: number;
}

/** What happens to the row: a request goes, or its answer comes. */
export type PrivateWinsEvent =
  | { readonly type: 'read-sent' }
  /** `savesWhenSent`: the state's `saves` when this read went. */
  | { readonly type: 'read-answered'; readonly winsPrivate: boolean; readonly savesWhenSent: number }
  | { readonly type: 'read-failed' }
  | { readonly type: 'save-sent' }
  | { readonly type: 'save-answered'; readonly winsPrivate: boolean }
  | { readonly type: 'save-failed' };

export const LOAD_FAILED = 'Could not load. Reopen settings to try again.';
export const SAVE_FAILED = 'Not saved. Try again.';

export const START_PRIVATE_WINS: PrivateWinsState = {
  winsPrivate: null,
  reading: 0,
  saving: false,
  failure: null,
  saves: 0,
};

/**
 * The row's rule, as a pure function. The value shown only ever changes to
 * one the server sent: a press is not shown until the save's answer comes,
 * and a failed save leaves the value as it was.
 */
export function privateWinsStep(state: PrivateWinsState, event: PrivateWinsEvent): PrivateWinsState {
  switch (event.type) {
    case 'read-sent':
      return { ...state, reading: state.reading + 1 };
    case 'read-answered': {
      const reading = Math.max(0, state.reading - 1);
      // Sent before a save: it may be the value from before that save.
      if (event.savesWhenSent !== state.saves) return { ...state, reading };
      return { ...state, reading, winsPrivate: event.winsPrivate, failure: null };
    }
    case 'read-failed':
      // A value read earlier still stands; only a row with none says so.
      return {
        ...state,
        reading: Math.max(0, state.reading - 1),
        failure: state.winsPrivate === null ? LOAD_FAILED : state.failure,
      };
    case 'save-sent':
      return { ...state, saving: true, failure: null, saves: state.saves + 1 };
    case 'save-answered':
      return { ...state, saving: false, winsPrivate: event.winsPrivate, failure: null };
    case 'save-failed':
      return { ...state, saving: false, failure: SAVE_FAILED };
  }
}

/** Whether a press can save now: the value is known and no save is on its way. */
export function canToggle(state: PrivateWinsState): state is PrivateWinsState & { winsPrivate: boolean } {
  return state.winsPrivate !== null && !state.saving;
}

/**
 * "Keep my wins private": one switch in the settings menu. On, none of the
 * player's wins (past ones too) is in the public lists. It reads the
 * server's value whenever the menu opens and saves each press at once with
 * PUT /api/settings. It works whether the lists are switched on or off: the
 * choice is the player's either way.
 */
export function PrivateWinsRow({ client, open }: PrivateWinsRowProps) {
  const [state, dispatch] = useReducer(privateWinsStep, START_PRIVATE_WINS);

  // Read each time the menu opens (and only then: a save does not send a
  // new read). The read is tagged with the saves made so far.
  const read = useEffectEvent((): void => {
    const savesWhenSent = state.saves;
    dispatch({ type: 'read-sent' });
    client.getSettings().then(
      (settings) =>
        dispatch({ type: 'read-answered', winsPrivate: settings.winsPrivate, savesWhenSent }),
      () => dispatch({ type: 'read-failed' }),
    );
  });
  useEffect(() => {
    if (open) read();
  }, [open]);

  const toggle = (): void => {
    if (!canToggle(state)) return;
    const wanted = !state.winsPrivate;
    dispatch({ type: 'save-sent' });
    send((key) => client.setSettings({ winsPrivate: wanted }, key)).then(
      (settings) => {
        dispatch({ type: 'save-answered', winsPrivate: settings.winsPrivate });
        // The lists show the change at their next refresh.
        askForFreshWins();
      },
      () => dispatch({ type: 'save-failed' }),
    );
  };

  return <PrivateWinsView state={state} onToggle={toggle} />;
}

/** The row as drawn, from its state alone. */
export function PrivateWinsView({
  state,
  onToggle,
}: {
  readonly state: PrivateWinsState;
  readonly onToggle: () => void;
}) {
  const labelId = useId();
  const { winsPrivate, reading, saving, failure } = state;
  return (
    <div className="card private-wins">
      <div className="settings-row">
        <span id={labelId}>Keep my wins private</span>
        {winsPrivate === null ? (
          // Not known yet, or the read failed: no switch, so a screen reader
          // never hears "off" for a value the server has not sent.
          <button
            type="button"
            className="btn btn-small"
            aria-labelledby={labelId}
            aria-busy={reading > 0}
            disabled
          >
            {reading > 0 ? '…' : '–'}
          </button>
        ) : (
          <button
            type="button"
            role="switch"
            className="btn btn-small"
            aria-labelledby={labelId}
            aria-checked={winsPrivate}
            aria-busy={saving}
            disabled={saving}
            onClick={onToggle}
          >
            {winsPrivate ? 'On' : 'Off'}
          </button>
        )}
      </div>
      {failure !== null && (
        <p className="bet-note error private-wins-failure" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
