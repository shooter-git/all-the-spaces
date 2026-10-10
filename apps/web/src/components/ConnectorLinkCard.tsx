import { Icon } from '@ats/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { type ConnectorInfo, scopeWords, startLink } from '../lib/connectors.ts';

/**
 * Drawn by the app over a creation that asked to link the person's account at a service the
 * server's owner installed. The creation never sees this card or the service's pages: linking
 * leaves for the service (the whole page, never a pop-up) and comes back to `returnTo`.
 */
export function ConnectorLinkCard({
  connector,
  creationTitle,
  returnTo,
  onClose,
}: {
  connector: ConnectorInfo;
  creationTitle: string;
  returnTo: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const again = connector.linked;
  return (
    <div
      className="creation-link"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onClose();
      }}
    >
      <div className="creation-link-card">
        <h2 id={titleId}>
          {again
            ? `Link ${connector.displayName} again`
            : `Link your ${connector.displayName} account`}
        </h2>
        <p>
          {creationTitle} would like to use your {connector.displayName} account
          {again && connector.broken ? ', which needs linking again' : ''}. Linking lets it:
        </p>
        <ul className="creation-link-scopes">
          {connector.scopes.map((s) => (
            <li key={s}>{scopeWords(s)}</li>
          ))}
        </ul>
        <p className="ats-muted">
          You’ll go to {connector.displayName} to say yes, then come back here. You can unlink it
          any time from your account.
        </p>
        {error && (
          <p className="creation-link-error" role="alert">
            {error}
          </p>
        )}
        <div className="creation-link-actions">
          <button
            ref={first}
            type="button"
            className="ats-button ats-button--ghost"
            onClick={onClose}
            disabled={busy}
          >
            Not now
          </button>
          <button
            type="button"
            className="ats-button ats-button--primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await startLink(connector.id, returnTo);
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            <Icon name="link" size={16} />
            {busy ? 'Opening…' : 'Link account'}
          </button>
        </div>
      </div>
    </div>
  );
}
