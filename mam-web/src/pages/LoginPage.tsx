/**
 * Local-development sign-in screen, rendered by `DevAuthProvider`'s
 * `RequireDevAuth` guard when no verified session exists. Never mounted
 * in a production build (`import.meta.env.DEV` gates which provider
 * `App.tsx` uses in the first place) — this page only exists so local
 * testing doesn't require a real OIDC Identity Provider.
 *
 * Submitting the form calls `useDevAuth().login()`, which verifies the
 * credentials against the real running Nuxeo backend (`GET /me`) before
 * accepting them — see `DevAuthProvider.tsx` for why a locally-minted
 * fake JWT is not used instead.
 */
import { useId, useState, type FormEvent } from 'react';
import { Loader2, Lock, ShieldAlert, User } from 'lucide-react';
import { useDevAuth, devAuthPrefill } from '../auth/DevAuthProvider';
import './LoginPage.css';

export function LoginPage() {
  const { login, loggingIn, error } = useDevAuth();
  const prefill = devAuthPrefill();
  const [username, setUsername] = useState(prefill?.username ?? '');
  const [password, setPassword] = useState(prefill?.password ?? '');
  const [localError, setLocalError] = useState<string | null>(null);
  const usernameId = useId();
  const passwordId = useId();

  const displayedError = localError ?? error;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLocalError(null);
    if (!username.trim() || !password) {
      setLocalError('Enter both a username and password.');
      return;
    }
    try {
      await login(username.trim(), password);
    } catch {
      // useDevAuth already captured a display-ready message in `error`;
      // nothing further to do here — the form just stays on screen.
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card card">
        <div className="login-brand">
          <span className="login-mark" aria-hidden="true" />
          <div className="login-brand-text">
            <span className="login-brand-name">MAM</span>
            <span className="login-brand-sub">Newsroom</span>
          </div>
        </div>

        <div className="login-heading">
          <h1 className="login-title">Sign in</h1>
          <p className="login-subtitle">
            Local development sign-in against the Nuxeo backend.
          </p>
        </div>

        <form className="login-form" onSubmit={onSubmit} noValidate>
          {displayedError ? (
            <div className="login-error" role="alert">
              <ShieldAlert aria-hidden="true" />
              <span>{displayedError}</span>
            </div>
          ) : null}

          <label className="login-field" htmlFor={usernameId}>
            <span className="login-field-label">Username</span>
            <div className="input-with-icon">
              <User aria-hidden="true" />
              <input
                id={usernameId}
                className="input"
                type="text"
                autoComplete="username"
                autoFocus
                required
                disabled={loggingIn}
                value={username}
                onChange={(e) => setUsername(e.currentTarget.value)}
                placeholder="Administrator"
              />
            </div>
          </label>

          <label className="login-field" htmlFor={passwordId}>
            <span className="login-field-label">Password</span>
            <div className="input-with-icon">
              <Lock aria-hidden="true" />
              <input
                id={passwordId}
                className="input"
                type="password"
                autoComplete="current-password"
                required
                disabled={loggingIn}
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                placeholder="••••••••"
              />
            </div>
          </label>

          <button type="submit" className="btn btn-primary btn-lg login-submit" disabled={loggingIn}>
            {loggingIn ? <Loader2 className="spin" aria-hidden="true" /> : null}
            {loggingIn ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="login-note">
          Development mode only. Credentials are verified directly against
          the running Nuxeo backend (e.g. <code>Administrator</code> /{' '}
          <code>Administrator</code> on the smoke stack) — nothing is
          hardcoded or accepted without a real check.
        </p>
      </div>
    </div>
  );
}
