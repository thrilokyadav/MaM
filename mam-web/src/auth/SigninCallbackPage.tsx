/**
 * Landing page for `VITE_OIDC_REDIRECT_URI` (default `/auth/callback`).
 *
 * react-oidc-context's `AuthProvider` completes the Authorization Code +
 * PKCE exchange automatically as soon as this route mounts (it inspects
 * the `code`/`state` query params via `oidc-client-ts`); this component
 * only needs to wait for that to finish and then navigate to wherever the
 * user originally intended to go.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';

export function SigninCallbackPage() {
  const auth = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (auth.isAuthenticated && !auth.isLoading) {
      navigate('/', { replace: true });
    }
  }, [auth.isAuthenticated, auth.isLoading, navigate]);

  if (auth.error) {
    return (
      <div className="auth-error" role="alert">
        <h1>Sign-in failed</h1>
        <p>{auth.error.message}</p>
      </div>
    );
  }

  return (
    <div className="auth-loading" role="status" aria-live="polite">
      Completing sign-in…
    </div>
  );
}
