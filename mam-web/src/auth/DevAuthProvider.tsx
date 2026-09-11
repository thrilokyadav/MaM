/**
 * Local-development-only auth provider.
 *
 * Context: production auth is OIDC (`AuthProvider.tsx`), which requires a
 * real Identity Provider to redirect to. There is no IdP running in local
 * dev, so mounting the OIDC provider there just spins forever waiting on
 * a `signinRedirect()` that has nowhere real to go. `DevAuthProvider` is
 * a completely separate code path — swapped in by `App.tsx` only when
 * `import.meta.env.DEV` is true — that never touches OIDC at all.
 *
 * How it authenticates ("Option B" from the task: verified Basic auth,
 * not a locally-minted fake JWT)
 * ---------------------------------------------------------------------
 * A JWT "minted" entirely in the browser would be worthless as an actual
 * credential: `mam-security`'s `JwtBearerAuthenticator` verifies RS256
 * tokens against a real JWKS endpoint, or HS256 tokens against a shared
 * secret (`mam.jwt.hmac.secret`) that only exists inside the disposable
 * smoke/integration Nuxeo *container* (generated fresh per run by
 * `smoke-test.ps1`/`integration-test.ps1`, never written to a file this
 * frontend could read, and never the same value twice). There is no way
 * for this browser bundle to legitimately know that secret, so signing a
 * token here would either fail verification or require hardcoding a
 * secret that immediately stops matching the backend after the next
 * `docker compose up`.
 *
 * Basic auth against the Nuxeo container's real seeded users (the
 * `Administrator`/`Administrator` account, or any of the persona test
 * users created per the README's "End-to-end testing" section) is the
 * credential that's actually guaranteed to be valid right now. This
 * provider's `login()` calls `GET /api/v1/me` with the submitted
 * credentials *before* accepting them — a wrong password gets a real
 * 401 back from Nuxeo and is shown as "Invalid credentials", not
 * silently accepted.
 *
 * Once verified, the resulting `Authorization: Basic <...>` header is
 * pushed into `tokenStore.ts` via `setDevSessionAuthHeader`, which is
 * exactly the same sink `nuxeoClient.ts`/`uploadApi.ts` already read from
 * for every other auth mode — no changes needed there. The session is
 * cached in `localStorage` (dev-only convenience, mirrors what a real
 * cookie/token session would do) so a page refresh doesn't force a
 * re-login; it is re-verified against the backend on every app load
 * rather than trusted blindly, so a stale/rotated credential is caught
 * immediately instead of silently sending bad requests.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { LoginPage } from '../pages/LoginPage';
import { setDevSessionAuthHeader } from './tokenStore';
import { DEV_AUTH_USER, DEV_AUTH_PASSWORD, DEV_AUTH_ENABLED } from './tokenStore';
import { clearCurrentUserCache } from '../api/meApi';

const STORAGE_KEY = 'mam.devAuth.session.v1';

interface StoredSession {
  username: string;
  authHeader: string; // "Basic <base64>"
}

export interface DevAuthUser {
  username: string;
  groups: string[];
  isAdministrator: boolean;
}

interface DevAuthContextValue {
  /** `undefined` while the stored session (if any) is still being verified. */
  user: DevAuthUser | null | undefined;
  error: string | null;
  loggingIn: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const DevAuthContext = createContext<DevAuthContextValue | null>(null);

function readStoredSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (!parsed.username || !parsed.authHeader) return null;
    return { username: parsed.username, authHeader: parsed.authHeader };
  } catch {
    return null;
  }
}

function writeStoredSession(session: StoredSession | null): void {
  try {
    if (session) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* localStorage unavailable (private mode, quota) — session just won't persist. */
  }
}

/** Base path used to reach Nuxeo — same resolution `nuxeoClient.ts` uses. */
function restRoot(): string {
  const raw = (import.meta.env.VITE_NUXEO_BASE_URL as string | undefined) ?? '/nuxeo';
  return `${raw.replace(/\/+$/, '')}/api/v1`;
}

interface NxMeResponse {
  id: string;
  properties?: { groups?: string[] };
  isAdministrator?: boolean;
}

/**
 * Verifies a Basic-auth credential against the real backend by calling
 * `GET /me` (the same endpoint `meApi.ts` uses elsewhere in the app).
 * Throws with a user-readable message on any failure (wrong credentials,
 * network error, backend down).
 */
async function verifyCredentials(username: string, password: string): Promise<DevAuthUser> {
  const authHeader = `Basic ${btoa(`${username}:${password}`)}`;
  let res: Response;
  try {
    res = await fetch(`${restRoot()}/me`, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
  } catch {
    throw new Error('Could not reach the Nuxeo backend. Is the smoke/integration stack running?');
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Invalid credentials.');
  }
  if (!res.ok) {
    throw new Error(`Backend returned HTTP ${res.status}.`);
  }
  const body = (await res.json()) as NxMeResponse;
  return {
    username: body.id,
    groups: body.properties?.groups ?? [],
    isAdministrator: Boolean(body.isAdministrator),
  };
}

export function DevAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<DevAuthUser | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  // On mount: try to restore + re-verify a stored session exactly once.
  // Re-verifying (rather than trusting the cached username blindly)
  // means a credential that stopped working — e.g. the smoke stack was
  // torn down and recreated with a fresh database — is caught here and
  // the user is sent back to the login page, instead of the app running
  // with a session that will 401 on every real request.
  useEffect(() => {
    const stored = readStoredSession();
    if (!stored) {
      setUser(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${restRoot()}/me`, {
          headers: { Authorization: stored.authHeader, Accept: 'application/json' },
        });
        if (!res.ok) throw new Error('Stored session is no longer valid.');
        const body = (await res.json()) as NxMeResponse;
        if (cancelled) return;
        setDevSessionAuthHeader(stored.authHeader);
        // Any per-session cache (e.g. `meApi`'s cached `GET /me`) must be
        // dropped here too: this effect runs once per page load, and a
        // stale cache from a *previous* page load's `import.meta.env.DEV`
        // module state would otherwise outlive this restore.
        clearCurrentUserCache();
        setUser({
          username: body.id,
          groups: body.properties?.groups ?? [],
          isAdministrator: Boolean(body.isAdministrator),
        });
      } catch {
        if (cancelled) return;
        writeStoredSession(null);
        setDevSessionAuthHeader(null);
        clearCurrentUserCache();
        setUser(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setError(null);
    setLoggingIn(true);
    try {
      const verified = await verifyCredentials(username, password);
      const authHeader = `Basic ${btoa(`${username}:${password}`)}`;
      writeStoredSession({ username: verified.username, authHeader });
      setDevSessionAuthHeader(authHeader);
      // Critical: without this, every permission/identity check elsewhere
      // in the app (review queue, archive row actions, the admin-only nav
      // gate, etc.) keeps reading whichever user's `/me` response was
      // cached from BEFORE this login — e.g. sign out as producer, sign
      // back in as editor, and the app would keep behaving like the
      // producer until a full page reload, because `meApi`'s cache had no
      // way to know the credential underneath it had changed.
      clearCurrentUserCache();
      setUser(verified);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed.');
      throw e;
    } finally {
      setLoggingIn(false);
    }
  }, []);

  const logout = useCallback(() => {
    writeStoredSession(null);
    setDevSessionAuthHeader(null);
    clearCurrentUserCache();
    setError(null);
    setUser(null);
  }, []);

  const value = useMemo<DevAuthContextValue>(
    () => ({ user, error, loggingIn, login, logout }),
    [user, error, loggingIn, login, logout],
  );

  return <DevAuthContext.Provider value={value}>{children}</DevAuthContext.Provider>;
}

export function useDevAuth(): DevAuthContextValue {
  const ctx = useContext(DevAuthContext);
  if (!ctx) {
    throw new Error('useDevAuth must be used within a DevAuthProvider');
  }
  return ctx;
}

/**
 * Route guard counterpart to `RequireAuth` (which is for the OIDC path).
 * Renders a loading state while the stored session is being verified
 * (never a redirect — there is nowhere to redirect to in dev mode, which
 * is exactly the loop the task asked to avoid), the `LoginPage` when
 * signed out, and `children` once a verified user exists.
 */
export function RequireDevAuth({ children }: { children: ReactNode }) {
  const { user } = useDevAuth();

  if (user === undefined) {
    return (
      <div className="auth-loading" role="status" aria-live="polite">
        Checking session…
      </div>
    );
  }
  if (user === null) {
    return <LoginPage />;
  }
  return <>{children}</>;
}

/** Suggested prefill for the login form, from `VITE_DEV_AUTH_*` if set. */
export function devAuthPrefill(): { username: string; password: string } | null {
  if (!DEV_AUTH_ENABLED) return null;
  return { username: DEV_AUTH_USER, password: DEV_AUTH_PASSWORD };
}
