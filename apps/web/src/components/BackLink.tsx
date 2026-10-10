import { Icon } from '@ats/ui';
import { Link, useNavigate } from 'react-router';

/** "← Your spaces": where back goes, said plainly. Without `to`, the previous page. */
export function BackLink({ to, label = 'Back' }: { to?: string; label?: string }) {
  const navigate = useNavigate();
  const inside = (
    <>
      <Icon name="back" size={16} />
      {label}
    </>
  );
  return to ? (
    <Link to={to} className="ats-back">
      {inside}
    </Link>
  ) : (
    <button type="button" className="ats-back" onClick={() => navigate(-1)}>
      {inside}
    </button>
  );
}
