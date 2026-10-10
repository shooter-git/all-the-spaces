import { Button, Icon } from '@ats/ui';
import { useUpdateReady } from '../lib/pwa.ts';

export function UpdateBanner() {
  const { ready, apply } = useUpdateReady();
  if (!ready) return null;
  return (
    <div className="ats-notice ats-row" role="status" style={{ justifyContent: 'space-between' }}>
      <span>A new version is ready.</span>
      <Button variant="primary" onClick={() => apply()}>
        <Icon name="refresh" size={16} />
        Refresh
      </Button>
    </div>
  );
}
