import { Button, Icon } from '@ats/ui';
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { api, type Me } from './lib/api.ts';
import { NotificationsProvider } from './lib/notifications.tsx';

// Each page is fetched when it's first opened, so signing in or joining doesn't download the 3D
// viewer, the terminal or the live connections first.
const Account = lazy(() => import('./routes/Account.tsx').then((m) => ({ default: m.Account })));
const Activity = lazy(() => import('./routes/Activity.tsx').then((m) => ({ default: m.Activity })));
const Assistants = lazy(() =>
  import('./routes/Assistants.tsx').then((m) => ({ default: m.Assistants })),
);
const BuildReport = lazy(() =>
  import('./routes/BuildReport.tsx').then((m) => ({ default: m.BuildReport })),
);
const Creations = lazy(() =>
  import('./routes/Creations.tsx').then((m) => ({ default: m.Creations })),
);
const GroupSettings = lazy(() =>
  import('./routes/GroupSettings.tsx').then((m) => ({ default: m.GroupSettings })),
);
const Home = lazy(() => import('./routes/Home.tsx').then((m) => ({ default: m.Home })));
const Join = lazy(() => import('./routes/Join.tsx').then((m) => ({ default: m.Join })));
const NewPlace = lazy(() => import('./routes/NewPlace.tsx').then((m) => ({ default: m.NewPlace })));
const People = lazy(() => import('./routes/People.tsx').then((m) => ({ default: m.People })));
const MyRequests = lazy(() =>
  import('./routes/Requests.tsx').then((m) => ({ default: m.MyRequests })),
);
const RequestPage = lazy(() =>
  import('./routes/Requests.tsx').then((m) => ({ default: m.RequestPage })),
);
const RequestQueue = lazy(() =>
  import('./routes/Requests.tsx').then((m) => ({ default: m.RequestQueue })),
);
const RoomPrivacy = lazy(() =>
  import('./routes/RoomPrivacy.tsx').then((m) => ({ default: m.RoomPrivacy })),
);
const ServerInfo = lazy(() =>
  import('./routes/ServerInfo.tsx').then((m) => ({ default: m.ServerInfo })),
);
const Setup = lazy(() => import('./routes/Setup.tsx').then((m) => ({ default: m.Setup })));
const SignIn = lazy(() => import('./routes/SignIn.tsx').then((m) => ({ default: m.SignIn })));
const SpaceView = lazy(() =>
  import('./routes/SpaceView.tsx').then((m) => ({ default: m.SpaceView })),
);
const StudioSpace = lazy(() =>
  import('./routes/StudioSpace.tsx').then((m) => ({ default: m.StudioSpace })),
);
const TryCreation = lazy(() =>
  import('./routes/TryCreation.tsx').then((m) => ({ default: m.TryCreation })),
);
const Workspace = lazy(() =>
  import('./routes/Workspace.tsx').then((m) => ({ default: m.Workspace })),
);

const PENDING_INVITE = 'ats-pending-invite';
/** Linking an account at a connector's service, interrupted by signing in: carried on after. */
const PENDING_LINK = 'ats-pending-link';
/** Only ever the server's own link callback (it checks the rest). */
const LINK_CALLBACK = /^\/api\/connectors\/callback\?[\w.~%=&-]{1,4000}$/;

function remember(key: string, value: string | null) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // Storage can be blocked (private mode); the flow still works, just without the reminder.
  }
}
function recall(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function Loading() {
  return (
    <main className="ats-screen">
      <div className="ats-center">
        <p className="ats-muted">Loading…</p>
      </div>
    </main>
  );
}

/** Why the app couldn't start: no network at all, or the server didn't answer. */
type StartFailure = 'offline' | 'unreachable';

function StartFailed({
  failure,
  retrying,
  onRetry,
}: {
  failure: StartFailure;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <main className="ats-screen">
      <div className="ats-center">
        <div
          className="ats-container ats-stack"
          style={{ textAlign: 'center', alignItems: 'center' }}
          role="alert"
        >
          {failure === 'offline' ? (
            <>
              <h1>You're offline</h1>
              <p className="ats-muted">
                Your space opens as soon as this device is connected again.
              </p>
            </>
          ) : (
            <>
              <h1>Can't reach the server</h1>
              <p className="ats-muted">
                It may be restarting or being updated. Trying again in a moment usually works.
              </p>
            </>
          )}
          <Button variant="primary" onClick={onRetry} disabled={retrying}>
            <Icon name="refresh" size={16} />
            {retrying ? 'Trying again…' : 'Retry'}
          </Button>
        </div>
      </div>
    </main>
  );
}

export function App() {
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [failure, setFailure] = useState<StartFailure | null>(null);
  const [retrying, setRetrying] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const refresh = useCallback(async () => {
    const [status, who] = await Promise.all([
      api<{ setupComplete: boolean }>('/api/setup/status'),
      api<Me>('/api/me'),
    ]);
    setSetupComplete(status.setupComplete);
    setMe(who);
  }, []);

  // Starting needs the server: when it can't be reached (offline, or the server restarting), say so
  // and try again by hand, when the device comes back online, or when the app is opened again.
  const start = useCallback(async () => {
    setRetrying(true);
    try {
      await refresh();
      setFailure(null);
    } catch {
      setFailure(navigator.onLine === false ? 'offline' : 'unreachable');
    } finally {
      setRetrying(false);
    }
  }, [refresh]);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    if (!failure) return;
    const again = () => {
      if (document.visibilityState === 'visible') void start();
    };
    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('online', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [failure, start]);

  // Back from a connector's service while signed out: sign in, then finish linking.
  useEffect(() => {
    if (location.pathname !== '/sign-in') return;
    const resume = new URLSearchParams(window.location.search).get('resume');
    if (resume && LINK_CALLBACK.test(resume)) remember(PENDING_LINK, resume);
  }, [location.pathname]);

  // Keep an invite token across "I already have an account → sign in".
  useEffect(() => {
    if (location.pathname === '/join' && window.location.hash.length > 1)
      remember(PENDING_INVITE, window.location.hash.slice(1));
  }, [location.pathname]);

  if (setupComplete === null || me === null) {
    if (failure) {
      return <StartFailed failure={failure} retrying={retrying} onRetry={() => void start()} />;
    }
    return <Loading />;
  }

  const signedIn = Boolean(me.user);
  // Running the group is for its Architects; anyone else lands on their own account.
  const architect = (page: ReactNode) =>
    !signedIn ? (
      <Navigate to="/sign-in" replace />
    ) : me.groups[0]?.role === 'architect' ? (
      page
    ) : (
      <Navigate to="/account" replace />
    );
  const afterSignIn = async () => {
    await refresh();
    const link = recall(PENDING_LINK);
    if (link && LINK_CALLBACK.test(link)) {
      remember(PENDING_LINK, null);
      window.location.assign(link);
      return;
    }
    const pending = recall(PENDING_INVITE);
    if (pending) {
      remember(PENDING_INVITE, null);
      navigate(`/join#${pending}`, { replace: true });
    } else {
      navigate('/', { replace: true });
    }
  };

  const routes = (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route
          path="/setup"
          element={setupComplete ? <Navigate to="/" replace /> : <Setup onComplete={refresh} />}
        />
        <Route path="/join" element={<Join me={me} onJoined={refresh} />} />
        <Route
          path="/space/:spaceId"
          element={signedIn ? <SpaceView me={me} /> : <Navigate to="/sign-in" replace />}
        />
        <Route
          path="/space/:spaceId/privacy"
          element={signedIn ? <RoomPrivacy /> : <Navigate to="/sign-in" replace />}
        />
        <Route
          path="/space/:spaceId/creations"
          element={signedIn ? <Creations /> : <Navigate to="/sign-in" replace />}
        />
        <Route
          path="/space/:spaceId/studio"
          element={signedIn ? <StudioSpace /> : <Navigate to="/sign-in" replace />}
        />
        <Route
          path="/space/:spaceId/studio/:workspaceId"
          element={signedIn ? <Workspace me={me} /> : <Navigate to="/sign-in" replace />}
        />
        <Route
          path="/studio/new-place"
          element={signedIn ? <NewPlace /> : <Navigate to="/sign-in" replace />}
        />
        <Route path="/studio/assistants" element={architect(<Assistants me={me} />)} />
        <Route path="/group/people" element={architect(<People me={me} />)} />
        <Route
          path="/group/settings"
          element={architect(<GroupSettings me={me} onChanged={refresh} />)}
        />
        <Route path="/group/activity" element={architect(<Activity me={me} />)} />
        <Route path="/group/server" element={architect(<ServerInfo me={me} />)} />
        <Route
          path="/account"
          element={
            signedIn ? <Account me={me} onChanged={refresh} /> : <Navigate to="/sign-in" replace />
          }
        />
        <Route
          path="/space/:spaceId/builds/:buildId"
          element={signedIn ? <BuildReport /> : <Navigate to="/sign-in" replace />}
        />
        <Route
          path="/space/:spaceId/creations/:creationId/try/:versionId"
          element={signedIn ? <TryCreation me={me} /> : <Navigate to="/sign-in" replace />}
        />
        <Route
          path="/requests"
          element={signedIn ? <MyRequests /> : <Navigate to="/sign-in" replace />}
        />
        <Route
          path="/requests/:requestId"
          element={signedIn ? <RequestPage /> : <Navigate to="/sign-in" replace />}
        />
        <Route
          path="/studio/requests"
          element={signedIn ? <RequestQueue /> : <Navigate to="/sign-in" replace />}
        />
        <Route
          path="/space/:spaceId/requests/:requestId"
          element={signedIn ? <RequestPage /> : <Navigate to="/sign-in" replace />}
        />
        <Route
          path="/sign-in"
          element={
            !setupComplete ? (
              <Navigate to="/setup" replace />
            ) : signedIn ? (
              <Navigate to="/" replace />
            ) : (
              <SignIn onSignedIn={afterSignIn} />
            )
          }
        />
        <Route
          path="*"
          element={
            !setupComplete ? (
              <Navigate to="/setup" replace />
            ) : !signedIn ? (
              <Navigate to="/sign-in" replace />
            ) : (
              <Home
                me={me}
                onSignedOut={() =>
                  refresh().then(
                    () => navigate('/sign-in', { replace: true }),
                    // Signed out, but the server didn't answer after: start again from scratch.
                    () => window.location.replace('/sign-in'),
                  )
                }
              />
            )
          }
        />
      </Routes>
    </Suspense>
  );
  // Notifications follow a signed-in person from page to page.
  return signedIn ? (
    <NotificationsProvider key={me.user?.id}>{routes}</NotificationsProvider>
  ) : (
    routes
  );
}
