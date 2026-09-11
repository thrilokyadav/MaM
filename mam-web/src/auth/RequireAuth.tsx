/**
 * Route guard: redirects to the IdP login when the OIDC session is not
 * (yet) authenticated, and shows a minimal loading state while the
 * initial silent sign-in check or a redirect callback is in flight.
 *
 * When OIDC is not configured (`OIDC_CONFIGURED === false`, see
 * `AuthProvider.tsx`), this renders children unconditionally — matching
 * this app's original "no auth layer, trust the browser session /
 * upstream proxy" behavior, so local/mock development is unaffected.
 */
import { useEffect, type ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';
import { OIDC_CONFIGURED } from './AuthProvider';

export function RequireAuth({ children }: { children: ReactNode }) {
  if (!OIDC_CONFIGURED) {
    return <>{children}</>;
  }
  return <RequireOidcAuth>{children}</RequireOidcAuth>;
}

function RequireOidcAuth({ children }: { children: ReactNode }) {
  const auth = useAuth();

  useEffect(() => {
    if (
      !auth.isLoading &&
      !auth.isAuthenticated &&
      !auth.activeNavigator &&
      !auth.error
    ) {
      void auth.signinRedirect();
    }
  }, [auth.isLoading, auth.isAuthenticated, auth.activeNavigator, auth.error, auth]);

  if (auth.error) {
    return (
      <div className="auth-error" role="alert">
        <h1>Sign-in failed</h1>
        <p>{auth.error.message}</p>
        <button type="button" className="btn btn-primary" onClick={() => void auth.signinRedirect()}>
          Try again
        </button>
      </div>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <div className="auth-loading" role="status" aria-live="polite">
        Redirecting to sign-in…
      </div>
    );
  }

  return <>{children}</>;
}
