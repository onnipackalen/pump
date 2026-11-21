import type { CSSProperties } from 'react';
import { stepAnchor, stepRow, stepWords, type StepRowInput } from '../game/stepRow';
import '../steps.css';

interface StepRowProps extends StepRowInput {
  /** 1, 2 or 3: the row's current step takes that balloon's colour. */
  readonly slot: number;
  /**
   * How many characters the big line under the balloon holds. On an upright
   * screen the row runs left and right of that line and leaves a hole that
   * wide for it (see steps.css). Not the small line: its length changes
   * with every Patch and cash-out value, and the row must not move for it.
   */
  readonly mainChars: number;
}

/**
 * A balloon's multiplier steps, scrolling along as it climbs. Where the row
 * goes is up to the screen (steps.css): along the top of the balloon's slot
 * on a computer, beside the amount under the balloon on an upright phone,
 * and nowhere on a screen with no room for it.
 *
 * The row is a picture of the ladder, up to 32 steps for each balloon, so
 * it is hidden from screen readers. They get one short line instead: the
 * next step and the top this bet can reach. It is not in a live region, so
 * auto-play stays quiet.
 */
export function StepRow({ slot, mainChars, ...input }: StepRowProps) {
  const steps = stepRow(input);
  const anchor = stepAnchor(input);
  const words = stepWords(input);
  // How many steps lie before the one in view.
  const lead = Math.max(0, anchor - 1);
  const style = {
    // The place in view: 0 before the first pump, else the step's number.
    '--at': anchor,
    '--steps': steps.length,
    '--main-chars': mainChars,
  } as CSSProperties;
  return (
    <>
      {words !== null && <p className="visually-hidden">{words}</p>}
      {/* data-lead: a row along the top that has moved on from its start
          fades at the left too, and how soon it moves depends on its width
          (steps.css). */}
      <div
        className="steps"
        aria-hidden="true"
        data-slot={slot}
        data-lead={lead === 0 ? '0' : lead === 1 ? '1' : 'more'}
        style={style}
      >
        <ol className="steps-track">
          {/* The place before the first step: where the balloon "is" until
              its first pump. Always there, so the first pump moves the row
              one place like every other pump. */}
          <li className="step step-start" data-anchor={anchor === 0 ? 'true' : undefined} />
          {steps.map((step) => (
            <li
              key={step.rung}
              className="step"
              data-step={step.state}
              data-anchor={step.rung === anchor ? 'true' : undefined}
              style={{ '--chars': step.text.length } as CSSProperties}
            >
              {step.text}
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}
