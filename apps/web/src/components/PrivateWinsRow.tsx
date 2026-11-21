import { useEffect, useId, useRef, useState } from 'react';
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
  /** The server's value; null until it has been read. */
  readonly winsPrivate: boolean | null;
  readonly saving: boolean;
  /** A plain failure to show, or null. */
  readonly failure: string | null;
}

export const LOAD_FAILED = 'Could not load. Reopen settings to try again.';
export const SAVE_FAILED = 'Not saved. Try again.';

/**
 * "Keep my wins private": one switch in the settings menu. On, none of the
 * player's wins (past ones too) is in the public lists. It reads the
 * server's value whenever the menu opens and saves each press at once with
 * PUT /api/settings. It works whether the lists are switched on or off: the
 * choice is the player's either way.
 */
export function PrivateWinsRow({ client, open }: PrivateWinsRowProps) {
  const [state, setState] = useState<PrivateWinsState>({
    winsPrivate: null,
    saving: false,
    failure: null,
  });
  // Saves started so far. A read sent before the latest save may carry the
  // value from before it, so its answer is dropped.
  const saves = useRef(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const savesBefore = saves.current;
    client.getSettings().then(
      (settings) => {
        if (cancelled || saves.current !== savesBefore) return;
        setState((s) => ({ ...s, winsPrivate: settings.winsPrivate, failure: null }));
      },
      () => {
        if (cancelled) return;
        // A value read earlier still stands; only a row with none says so.
        setState((s) => (s.winsPrivate === null ? { ...s, failure: LOAD_FAILED } : s));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, client]);

  const toggle = (): void => {
    if (state.winsPrivate === null || state.saving) return;
    const wanted = !state.winsPrivate;
    saves.current += 1;
    setState((s) => ({ ...s, saving: true, failure: null }));
    send((key) => client.setSettings({ winsPrivate: wanted }, key)).then(
      (settings) => {
        setState({ winsPrivate: settings.winsPrivate, saving: false, failure: null });
        // The lists show the change at their next refresh.
        askForFreshWins();
      },
      () => setState((s) => ({ ...s, saving: false, failure: SAVE_FAILED })),
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
  const { winsPrivate, saving, failure } = state;
  return (
    <div className="card private-wins">
      <div className="settings-row">
        <span id={labelId}>Keep my wins private</span>
        <button
          type="button"
          role="switch"
          className="btn btn-small"
          aria-labelledby={labelId}
          aria-checked={winsPrivate ?? false}
          aria-busy={winsPrivate === null || saving}
          disabled={winsPrivate === null || saving}
          onClick={onToggle}
        >
          {winsPrivate === null ? '…' : winsPrivate ? 'On' : 'Off'}
        </button>
      </div>
      {failure !== null && (
        <p className="bet-note error private-wins-failure" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
