import { useState } from 'react';
import type { FairnessView, RevealedSeed } from '../api/contract';

interface FairnessPanelProps {
  readonly fairness: FairnessView;
  readonly revealed: readonly RevealedSeed[];
  /** Seeds can't change during a round. */
  readonly locked: boolean;
  readonly onSaveClientSeed: (clientSeed: string) => Promise<boolean>;
  readonly onRotate: () => void;
}

const CLIENT_SEED = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Provably fair seeds. Before a round the player sees only the hash of the
 * server seed. Rotating retires the seed and reveals it, so every round
 * played on it can be checked.
 */
export function FairnessPanel({
  fairness,
  revealed,
  locked,
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
        key={fairness.clientSeed}
        saved={fairness.clientSeed}
        locked={locked}
        onSave={onSaveClientSeed}
      />

      <p className="hint">
        Next round uses nonce <strong>{fairness.nextNonce}</strong>. The nonce counts rounds on
        this server seed and never goes back, even if you change the client seed.
      </p>

      <button type="button" className="btn" disabled={locked} onClick={onRotate}>
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
  readonly onSave: (clientSeed: string) => Promise<boolean>;
}

function ClientSeedForm({ saved, locked, onSave }: ClientSeedFormProps) {
  const [text, setText] = useState(saved);
  const [saving, setSaving] = useState(false);
  const valid = CLIENT_SEED.test(text);

  return (
    <form
      className="client-seed"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || text === saved) return;
        setSaving(true);
        void onSave(text).finally(() => setSaving(false));
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
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <button
        type="submit"
        className="btn btn-small"
        disabled={locked || saving || !valid || text === saved}
      >
        Save
      </button>
      {!valid && <p className="bet-note error">1 to 64 of A–Z, a–z, 0–9, _ and -</p>}
    </form>
  );
}
