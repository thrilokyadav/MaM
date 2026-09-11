/**
 * OIDC/OAuth2 client integration (mam-web is the OIDC Relying Party;
 * mam-platform/Nuxeo is the Resource Server — see mam-security's
 * JwtBearerAuthenticator).
 *
 * Wraps `react-oidc-context`'s `AuthProvider` (itself backed by
 * `oidc-client-ts`'s `UserManager`) with the Authorization Code + PKCE
 * flow, configured entirely from `VITE_OIDC_*` environment variables —
 * no issuer, client id, or secret is ever hardcoded here. Public OIDC
 * clients (a browser SPA) never hold a client secret at all; only
 * `client_id` (a public identifier, not a credential) is configured.
 *
 * Responsibilities:
 *  - Redirects to the IdP's login page when the user is not
 *    authenticated (see `RequireAuth`).
 *  - Handles the redirect-back callback at `VITE_OIDC_REDIRECT_URI`'s
 *    path (see `App.tsx`'s `/auth/callback` route and `onSigninCallback`
 *    below, which strips the `code`/`state` query params from the URL
 *    once the exchange completes).
 *  - Performs silent token renewal in a hidden iframe before the access
 *    token expires (`automaticSilentRenew`), using `VITE_OIDC_SILENT_REDIRECT_URI`.
 *  - Publishes the current access token into `tokenStore` (see
 *    `tokenStore.ts`) so the plain-fetch API client can attach it as a
 *    Bearer header without needing React context.
 */
import { useEffect, type ReactNode } from 'react';
import { AuthProvider as OidcAuthProvider, useAuth } from 'react-oidc-context';
import { WebStorageStateStore } from 'oidc-client-ts';
import { setAccessToken } from './tokenStore';
import { clearCurrentUserCache } from '../api/meApi';

function readEnv(name: string): string {
  const value = (import.meta.env as Record<string, string | undefined>)[name];
  return value ?? '';
}

/** True only when every variable required for a real OIDC flow is present. */
export const OIDC_CONFIGURED: boolean = Boolean(
  readEnv('VITE_OIDC_ISSUER') && readEnv('VITE_OIDC_CLIENT_ID'),
);

const redirectUri =
  readEnv('VITE_OIDC_REDIRECT_URI') || `${window.location.origin}/auth/callback`;
const silentRedirectUri =
  readEnv('VITE_OIDC_SILENT_REDIRECT_URI') || `${window.location.origin}/auth/silent-renew`;
const postLogoutRedirectUri =
  readEnv('VITE_OIDC_POST_LOGOUT_REDIRECT_URI') || window.location.origin;
const scope = readEnv('VITE_OIDC_SCOPE') || 'openid profile email groups';

const oidcConfig = {
  authority: readEnv('VITE_OIDC_ISSUER'),
  client_id: readEnv('VITE_OIDC_CLIENT_ID'),
  redirect_uri: redirectUri,
  silent_redirect_uri: silentRedirectUri,
  post_logout_redirect_uri: postLogoutRedirectUri,
  scope,
  // Authorization Code + PKCE (no client secret, appropriate for a
  // browser SPA — see oidc-client-ts's default response_type).
  response_type: 'code',
  automaticSilentRenew: true,
  loadUserInfo: true,
  // Persist across tab reloads without leaking into third-party storage:
  // sessionStorage is per-tab and cleared on tab close, which is a
  // reasonable default for a newsroom terminal; override via
  // VITE_OIDC_PERSIST_ACROSS_TABS if the deployment wants localStorage.
  userStore: new WebStorageStateStore({
    store: readEnv('VITE_OIDC_PERSIST_ACROSS_TABS') === 'true' ? window.localStorage : window.sessionStorage,
  }),
  onSigninCallback: () => {
    // Remove the `code`/`state` query params oidc-client-ts leaves behind
    // after completing the token exchange, so a page refresh doesn't
    // resubmit them.
    window.history.replaceState({}, document.title, window.location.pathname);
  },
};

/** Keeps `tokenStore` in sync with the current OIDC user's access token. */
function TokenStoreSync({ children }: { children: ReactNode }) {
  const auth = useAuth();
  useEffect(() => {
    setAccessToken(auth.user?.access_token ?? null);
    // `meApi`'s cached `GET /me` result must be dropped whenever the
    // signed-in identity changes (login, silent renew that rotates the
    // subject, or logout) — otherwise every permission/identity check
    // elsewhere in the app keeps reading a previous session's principal.
    // Same fix as `DevAuthProvider.login()`/`logout()`.
    clearCurrentUserCache();
    return () => {
      setAccessToken(null);
      clearCurrentUserCache();
    };
  }, [auth.user]);
  return <>{children}</>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!OIDC_CONFIGURED) {
    // No IdP configured (e.g. VITE_MOCK_MODE offline UI work, or a
    // deployment that fronts Nuxeo with its own SSO reverse proxy and
    // never wants the browser to do the OIDC dance itself). Render
    // children directly with no auth wrapper; the API client then sends
    // no Authorization header at all, matching this app's pre-OIDC
    // "trust the browser session / upstream proxy" behavior.
    return <>{children}</>;
  }
  return (
    <OidcAuthProvider {...oidcConfig}>
      <TokenStoreSync>{children}</TokenStoreSync>
    </OidcAuthProvider>
  );
}
