import type { CSSProperties } from 'react';
import { stepAnchor, stepRow, type StepRowInput } from '../game/stepRow';
import '../steps.css';

interface StepRowProps extends StepRowInput {
  /** 1, 2 or 3: the row's current step takes that balloon's colour. */
  readonly slot: number;
  /**
   * How many characters the two lines under the balloon hold. On an upright
   * screen the row runs left and right of those lines and leaves a gap that
   * wide for them (see steps.css).
   */
  readonly mainChars: number;
  readonly subChars: number;
}

/**
 * A balloon's multiplier steps, scrolling along as it climbs. Where the row
 * goes is up to the screen (steps.css): along the top of the balloon's slot
 * on a computer, beside the amount under the balloon on an upright phone,
 * and nowhere on a screen with no room for it.
 */
export function StepRow({ slot, mainChars, subChars, ...input }: StepRowProps) {
  const steps = stepRow(input);
  const anchor = stepAnchor(input);
  // How many steps lie before the one in view.
  const lead = Math.max(0, anchor - 1);
  const style = {
    '--lead': lead,
    '--steps': steps.length,
    '--main-chars': mainChars,
    '--sub-chars': subChars,
  } as CSSProperties;
  return (
    // data-lead: a row along the top that has moved on from its start fades
    // at the left too, and how soon it moves depends on its width (steps.css).
    <div
      className="steps"
      data-slot={slot}
      data-lead={lead === 0 ? '0' : lead === 1 ? '1' : 'more'}
      style={style}
    >
      <ol className="steps-track" aria-label={`Balloon ${slot}: multiplier steps`}>
        {/* Before the first pump the balloon is on no step: this empty place
            stands where its step will be. */}
        {anchor === 0 && <li className="step step-start" data-anchor="true" aria-hidden="true" />}
        {steps.map((step) => (
          <li
            key={step.rung}
            className="step"
            data-step={step.state}
            data-anchor={step.rung === anchor ? 'true' : undefined}
            aria-current={step.state === 'current' ? 'step' : undefined}
            aria-label={
              step.state === 'locked'
                ? `${step.text}, out of reach at this bet`
                : step.state === 'popped'
                  ? `${step.text}, popped`
                  : undefined
            }
            style={{ '--chars': step.text.length } as CSSProperties}
          >
            {step.text}
          </li>
        ))}
      </ol>
    </div>
  );
}
