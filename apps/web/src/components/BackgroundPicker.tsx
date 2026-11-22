import { BACKGROUNDS, type BackgroundId } from '../background';

interface BackgroundPickerProps {
  readonly value: BackgroundId;
  readonly onChange: (id: BackgroundId) => void;
}

/**
 * Settings > Background: one small sky swatch and a one-word name per
 * scene. Plain radio buttons, so arrow keys move between them and a screen
 * reader reads "Background, Desert, 2 of 8".
 */
export function BackgroundPicker({ value, onChange }: BackgroundPickerProps) {
  return (
    <fieldset className="card bg-picker">
      <legend>Background</legend>
      <div className="bg-choices">
        {BACKGROUNDS.map((scene) => (
          <label key={scene.id} className="bg-choice">
            <input
              type="radio"
              name="background"
              value={scene.id}
              checked={value === scene.id}
              onChange={() => onChange(scene.id)}
            />
            <span
              className="bg-swatch"
              aria-hidden="true"
              style={{ background: `linear-gradient(${scene.top}, ${scene.horizon})` }}
            />
            {scene.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
