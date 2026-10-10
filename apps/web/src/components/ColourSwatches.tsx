/** The soft colours a group can take, with the names a screen reader says. */
export const GROUP_COLOURS = [
  { value: '#D3DDE8', name: 'Sky' },
  { value: '#CFD8C2', name: 'Moss' },
  { value: '#DDD7CC', name: 'Stone' },
  { value: '#EFE8DC', name: 'Silk' },
  { value: '#BCC8D8', name: 'Indigo mist' },
  { value: '#E6C3C9', name: 'Sakura' },
] as const;

export const DEFAULT_GROUP_COLOUR: string = GROUP_COLOURS[0].value;

/** Picking the group's colour: one swatch per colour, each a named radio button. */
export function ColourSwatches({
  name,
  value,
  onChange,
}: {
  /** The radio group's name (unique on the page). */
  name: string;
  value: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <div className="ats-row" role="radiogroup" aria-label="Colour">
      {GROUP_COLOURS.map((c) => (
        <label key={c.value} className="ats-swatch" style={{ background: c.value }} title={c.name}>
          <input
            type="radio"
            name={name}
            value={c.value}
            checked={value === c.value}
            onChange={() => onChange(c.value)}
            aria-label={c.name}
          />
        </label>
      ))}
    </div>
  );
}
