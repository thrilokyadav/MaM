/**
 * Landing page for `VITE_OIDC_SILENT_REDIRECT_URI` (default
 * `/auth/silent-renew`), loaded inside the hidden iframe oidc-client-ts
 * creates for `automaticSilentRenew`. `react-oidc-context`'s
 * `AuthProvider` (mounted at the app root, which this iframe also loads
 * since it's just a normal client-side route) does all the actual work
 * of completing the silent renew against the IdP; this page renders
 * nothing visible and never needs to redirect anywhere.
 */
export function SilentRenewPage() {
  return null;
}
