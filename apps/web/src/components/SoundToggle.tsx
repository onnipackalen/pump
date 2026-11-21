interface SoundToggleProps {
  readonly muted: boolean;
  readonly onToggle: () => void;
}

/** The sound on/off button. Its two icons (sound on, sound off) are drawn here; this is their original. */
export function SoundToggle({ muted, onToggle }: SoundToggleProps) {
  return (
    <button
      type="button"
      className="btn icon-btn"
      aria-label="Sound"
      aria-pressed={!muted}
      title={muted ? 'Sound is off (M)' : 'Sound is on (M)'}
      onClick={onToggle}
    >
      <svg
        viewBox="0 0 24 24"
        width="24"
        height="24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M11 5L6.5 9H3.5v6h3L11 19z" />
        {muted ? (
          <path d="M16 9.5l5 5M21 9.5l-5 5" />
        ) : (
          <>
            <path d="M15.5 9a4.2 4.2 0 0 1 0 6" />
            <path d="M18.5 6a8.5 8.5 0 0 1 0 12" />
          </>
        )}
      </svg>
    </button>
  );
}
