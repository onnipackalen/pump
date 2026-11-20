import { useEffect, useRef, type ReactNode } from 'react';

interface SettingsMenuProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}

const iconProps = {
  viewBox: '0 0 24 24',
  width: 24,
  height: 24,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const;

/**
 * The settings button and the sheet it opens.
 *
 * The button is always in the top bar: before a round, during one, while
 * auto-play runs, and while the game is still loading. Anything the next
 * tap does not need goes in the sheet, so the game screen stays bare.
 *
 * The sheet is a native modal dialog: it traps focus, Esc closes it, and
 * the game behind it cannot be clicked while it is open.
 */
export function SettingsMenu({ open, onOpenChange, children }: SettingsMenuProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="btn icon-btn"
        aria-label="Settings"
        aria-haspopup="dialog"
        title="Settings"
        onClick={() => onOpenChange(true)}
      >
        <svg {...iconProps}>
          <path d="M10.40 5.08L10.73 2.38L13.27 2.38L13.60 5.08L15.76 5.98L17.90 4.30L19.70 6.10L18.02 8.24L18.92 10.40L21.62 10.73L21.62 13.27L18.92 13.60L18.02 15.76L19.70 17.90L17.90 19.70L15.76 18.02L13.60 18.92L13.27 21.62L10.73 21.62L10.40 18.92L8.24 18.02L6.10 19.70L4.30 17.90L5.98 15.76L5.08 13.60L2.38 13.27L2.38 10.73L5.08 10.40L5.98 8.24L4.30 6.10L6.10 4.30L8.24 5.98Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>

      <dialog
        ref={dialogRef}
        className="settings"
        aria-label="Settings"
        onClose={() => onOpenChange(false)}
        onClick={(event) => {
          // A click on the dimmed area outside the sheet lands on the dialog itself.
          if (event.target === event.currentTarget) onOpenChange(false);
        }}
      >
        <header className="settings-head">
          <h2>Settings</h2>
          <button
            type="button"
            className="btn icon-btn"
            aria-label="Close settings"
            onClick={() => onOpenChange(false)}
          >
            <svg {...iconProps}>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <div className="settings-body">{children}</div>
      </dialog>
    </>
  );
}
