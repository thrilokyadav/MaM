/**
 * Bridges the current session's credential into the plain, non-React API
 * client modules (`api/nuxeoClient.ts`, `api/uploadApi.ts`) that cannot
 * consume a React hook. Three independent sources feed this module, in
 * priority order:
 *
 *   1. OIDC access token — set by `AuthProvider.tsx` (real production
 *      auth) whenever the OIDC user changes (login, silent renew, logout).
 *   2. Interactive dev-auth session — set by `DevAuthProvider.tsx` after
 *      the user submits real, backend-verified credentials on
 *      `LoginPage.tsx`. Local development only; see that file.
 *   3. Static dev-auth env fallback — set once at module load from
 *      `VITE_DEV_AUTH_*`, for non-interactive/headless local dev use
 *      (e.g. the `window.__mam` scripting hook in `main.tsx`) that never
 *      goes through `DevAuthProvider`'s login flow.
 *
 * This is a deliberately tiny set of module-level singletons: nothing
 * here is persisted beyond the current page lifetime by this module
 * itself (each source handles its own persistence — oidc-client-ts's own
 * storage for #1, `localStorage` for #2 via `DevAuthProvider`); this is
 * just the last-known-value cache the fetch layer reads synchronously at
 * request-build time.
 */

function readEnv(name: string): string {
  return ((import.meta.env as Record<string, string | undefined>)[name] ?? '').toString();
}

/** True only when the static dev-auth env fallback is explicitly enabled. */
export const DEV_AUTH_ENABLED: boolean =
  readEnv('VITE_DEV_AUTH_ENABLED').toLowerCase() === 'true' && Boolean(readEnv('VITE_DEV_AUTH_USER'));

/** Exposed so UI can pre-fill the login form / show who the static fallback signs in as. */
export const DEV_AUTH_USER: string = readEnv('VITE_DEV_AUTH_USER');
export const DEV_AUTH_PASSWORD: string = readEnv('VITE_DEV_AUTH_PASSWORD');

function staticDevAuthHeader(): Record<string, string> {
  if (!DEV_AUTH_ENABLED) return {};
  // btoa is sufficient here: dev credentials are expected to be plain
  // ASCII (Nuxeo usernames/passwords), and this path is dev-only.
  const encoded = btoa(`${DEV_AUTH_USER}:${DEV_AUTH_PASSWORD}`);
  return { Authorization: `Basic ${encoded}` };
}

let currentAccessToken: string | null = null;

/** Called by `AuthProvider` whenever the OIDC user's access token changes. */
export function setAccessToken(token: string | null): void {
  currentAccessToken = token;
}

/** Read by the API client when building the `Authorization` header. */
export function getAccessToken(): string | null {
  return currentAccessToken;
}

/** Full `Authorization` header value for the current interactive dev-auth session, or `null`. */
let currentDevSessionAuthHeader: string | null = null;

/**
 * Called by `DevAuthProvider` whenever its verified session changes
 * (login / restore-from-storage / logout). The header is passed in
 * already-built (`Basic <base64>`) since `DevAuthProvider` is the only
 * thing that knows the credential shape it verified against the backend.
 */
export function setDevSessionAuthHeader(header: string | null): void {
  currentDevSessionAuthHeader = header;
}

/**
 * `Authorization` header for the current session, resolved in priority
 * order: OIDC bearer token, then an active interactive dev-auth session,
 * then the static dev-auth env fallback, then none at all.
 */
export function bearerAuthHeader(): Record<string, string> {
  if (currentAccessToken) return { Authorization: `Bearer ${currentAccessToken}` };
  if (currentDevSessionAuthHeader) return { Authorization: currentDevSessionAuthHeader };
  return staticDevAuthHeader();
}
