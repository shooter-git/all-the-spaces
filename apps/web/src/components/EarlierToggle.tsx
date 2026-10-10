import { Icon } from '@ats/ui';

/** Unfolds the earlier versions folded under a newest one, and folds them away again. */
export function EarlierToggle({
  open,
  count,
  onToggle,
}: {
  open: boolean;
  count: number;
  onToggle: () => void;
}) {
  const plural = count === 1 ? '' : 's';
  return (
    <button type="button" className="studio-unfold" aria-expanded={open} onClick={onToggle}>
      <Icon name={open ? 'chevronUp' : 'chevronDown'} size={16} />
      {open ? `Hide earlier version${plural}` : `${count} earlier version${plural}`}
    </button>
  );
}
