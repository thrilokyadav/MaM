/**
 * Shared CSRF-Token handshake helper.
 *
 * Background: Nuxeo's `NuxeoCorsCsrfFilter` can require a `CSRF-Token`
 * header on every state-changing request (POST/PUT/PATCH/DELETE) when
 * `nuxeo.csrf.token.enabled=true` — which is the case on the local
 * smoke/integration dev images (`Dockerfile.smoke`/`Dockerfile.integration`)
 * AND on production (`deploy/nuxeo/Dockerfile.prod`). The token is fetched
 * via `GET /nuxeo` with header `CSRF-Token: fetch`, tied to a session
 * cookie the server also sets on that response.
 *
 * This app is intentionally Bearer-token-first (see `nuxeoClient.ts`'s own
 * docstring) — a real OIDC access token is immune to CSRF by construction,
 * since it's never attached ambiently by the browser the way a cookie is.
 * *However*, local development authenticates with a `Basic` header
 * instead (via `DevAuthProvider`/`tokenStore.ts`, since there is no real
 * IdP running locally) — and Basic auth, like a cookie, IS something a
 * browser could be tricked into sending, so the CSRF filter does not
 * exempt it. Verified directly against the running smoke stack: a write
 * with `Authorization: Basic ...` and no `CSRF-Token` header is rejected
 * with HTTP 403.
 *
 * Rather than duplicate this per API module, every state-changing request
 * in this app goes through `withCsrfToken` (used by `nuxeoClient.ts`'s
 * `nuxeoRequest` and `uploadApi.ts`'s raw XHR calls). It fetches a token
 * before every write and attaches it if the server returned one; if the
 * server doesn't emit a token (CSRF disabled, or a deployment that only
 * ever sees genuine Bearer traffic), the fetch is harmless no-op overhead
 * and the write proceeds exactly as before.
 */

import { bearerAuthHeader } from '../auth/tokenStore';

/**
 * Base path Nuxeo is reached at. Resolved independently from
 * `nuxeoClient.ts`'s own `NUXEO_BASE_URL` (same env var, same fallback)
 * to avoid a circular import between the two modules — `nuxeoClient.ts`
 * calls into this file for every write, so this file must not import
 * back from it.
 */
function nuxeoBaseUrl(): string {
  const raw = (import.meta.env.VITE_NUXEO_BASE_URL as string | undefined) ?? '/nuxeo';
  return raw.replace(/\/+$/, '');
}

/**
 * Fetches a fresh CSRF token bound to the current session, or `null` if
 * the server doesn't emit one. Best-effort: network/parse failures also
 * resolve to `null` rather than throwing, so a CSRF-disabled deployment
 * (or a momentary network hiccup) never blocks the caller's real request
 * from being attempted.
 */
export async function fetchCsrfToken(): Promise<string | null> {
  try {
    const res = await fetch(nuxeoBaseUrl(), {
      method: 'GET',
      headers: { ...bearerAuthHeader(), 'CSRF-Token': 'fetch' },
      credentials: 'include',
    });
    return res.headers.get('CSRF-Token');
  } catch {
    return null;
  }
}

/** HTTP methods that Nuxeo's CSRF filter actually checks. */
const CSRF_GUARDED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function methodNeedsCsrf(method: string): boolean {
  return CSRF_GUARDED_METHODS.has(method.toUpperCase());
}
