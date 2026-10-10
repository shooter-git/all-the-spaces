import { Button, Icon } from '@ats/ui';
import { Component, type ReactNode } from 'react';

/** Last-resort safety net: an unexpected error shows a calm message instead of a blank screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="ats-screen">
        <div className="ats-center">
          <div
            className="ats-container ats-stack"
            style={{ textAlign: 'center', alignItems: 'center' }}
          >
            <h1>Something went wrong</h1>
            <p className="ats-muted">
              Reloading usually fixes it. If it keeps happening, let your space's Architect know.
            </p>
            <Button variant="primary" onClick={() => window.location.assign('/')}>
              <Icon name="refresh" size={16} />
              Reload
            </Button>
          </div>
        </div>
      </main>
    );
  }
}
