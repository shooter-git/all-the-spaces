import { BrandMark } from '@ats/ui';

export function BrandHeader({ subtitle }: { subtitle?: string }) {
  return (
    <header className="ats-row" style={{ gap: 10, justifyContent: 'center' }}>
      <BrandMark size={32} />
      <span style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>All the Spaces</span>
      {subtitle && <span className="ats-muted">· {subtitle}</span>}
    </header>
  );
}
