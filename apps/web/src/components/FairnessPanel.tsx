import { useState } from 'react';
import type { FairnessView, RevealedSeed } from '../api/contract';
import { CLIENT_SEED_PATTERN } from '../game/clientSeed';

interface FairnessPanelProps {
  readonly fairness: FairnessView;
  readonly revealed: readonly RevealedSeed[];
  /** Seeds can't change during a round. */
  readonly locked: boolean;
  /** A seed change is on its way: Save and Rotate wait for it. */
  readonly changing: boolean;
  readonly onSaveClientSeed: (clientSeed: string) => Promise<boolean>;
  readonly onRotate: () => void;
}

/**
 * Provably fair seeds. Before a round the player sees only the hash of the
 * server seed. Rotating retires the seed and reveals it, so every round
 * played on it can be checked.
 */
export function FairnessPanel({
  fairness,
  revealed,
  locked,
  changing,
  onSaveClientSeed,
  onRotate,
}: FairnessPanelProps) {
  return (
    <details className="card panel fairness">
      <summary>Provably fair</summary>

      <h3>Server seed (SHA-256 hash)</h3>
      <code className="seed">{fairness.serverSeedHash}</code>

      {/* Keyed by the saved seed, so the box resets when it changes. */}
      <ClientSeedForm
        key={fairness.clientSeed ?? ''}
        saved={fairness.clientSeed ?? ''}
        locked={locked}
        changing={changing}
        onSave={onSaveClientSeed}
      />

      <p className="hint">
        Next round uses nonce <strong>{fairness.nextNonce}</strong>. The nonce counts rounds on
        this server seed and never goes back, even if you change the client seed.
      </p>

      <button type="button" className="btn" disabled={locked || changing} onClick={onRotate}>
        Rotate server seed
      </button>
      {locked && <p className="hint">Seeds are locked until the round ends.</p>}

      {revealed.length > 0 && (
        <>
          <h3>Revealed seeds</h3>
          <ul className="revealed">
            {revealed.map((seed) => (
              <li key={seed.serverSeedHash}>
                <span className="hint">
                  {seed.roundsPlayed} round{seed.roundsPlayed === 1 ? '' : 's'}
                </span>
                <code className="seed">{seed.serverSeed}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}

interface ClientSeedFormProps {
  readonly saved: string;
  readonly locked: boolean;
  readonly changing: boolean;
  readonly onSave: (clientSeed: string) => Promise<boolean>;
}

/** The line under the box after a save that did not go through, naming the seed still in use. */
export function notSavedText(saved: string): string {
  return saved === '' ? 'Not saved.' : `Not saved. Rounds still use “${saved}”.`;
}

function ClientSeedForm({ saved, locked, changing, onSave }: ClientSeedFormProps) {
  const [text, setText] = useState(saved);
  const [saving, setSaving] = useState(false);
  // The last save did not go through, so the box shows a seed that is not in use.
  const [notSaved, setNotSaved] = useState(false);
  const valid = CLIENT_SEED_PATTERN.test(text);

  return (
    <form
      className="client-seed"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || text === saved || changing) return;
        setSaving(true);
        setNotSaved(false);
        void onSave(text).then(
          (done) => {
            setSaving(false);
            setNotSaved(!done);
          },
          () => {
            setSaving(false);
            setNotSaved(true);
          },
        );
      }}
    >
      <label>
        <h3>Client seed</h3>
        <input
          type="text"
          value={text}
          maxLength={64}
          spellCheck={false}
          autoComplete="off"
          disabled={locked}
          aria-invalid={!valid}
          onChange={(event) => {
            setText(event.target.value);
            setNotSaved(false);
          }}
        />
      </label>
      <button
        type="submit"
        className="btn btn-small"
        disabled={locked || changing || saving || !valid || text === saved}
      >
        Save
      </button>
      {!valid && <p className="bet-note error">1 to 64 of A–Z, a–z, 0–9, _ and -</p>}
      {valid && notSaved && text !== saved && <p className="bet-note error">{notSavedText(saved)}</p>}
    </form>
  );
}
