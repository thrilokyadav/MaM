/**
 * Thin fetch wrapper for the Nuxeo REST API.
 *
 * - Base URL comes from `VITE_NUXEO_BASE_URL` (default `/nuxeo`).
 * - No credentials, tokens, or CLIDs live in this file.
 * - Authentication is OIDC/OAuth2 JWT Bearer: the access token issued by
 *   the IdP (see `src/auth/AuthProvider.tsx`) is read from
 *   `src/auth/tokenStore.ts` and attached as `Authorization: Bearer
 *   <token>` on every request. If no user is signed in (OIDC not
 *   configured, or not yet authenticated), no `Authorization` header is
 *   sent at all.
 *
 * CSRF handling
 * -------------
 * Nuxeo's CSRF protection (`NuxeoCorsCsrfFilter`,
 * `nuxeo.csrf.token.enabled`) defends against a cookie-based session
 * being ridden by a third-party site — it is not applicable to Bearer
 * tokens, which are never attached ambiently by the browser the way a
 * cookie is (a cross-origin page has no way to read this app's in-memory
 * access token and attach it to a forged request). Accordingly this
 * client never performs the `CSRF-Token: fetch` handshake, never sends a
 * `CSRF-Token` header, and never sends `credentials` (no Nuxeo session
 * cookie is established or relied upon for Bearer-authenticated calls).
 * See mam-security's mam-jwt-auth-contrib.xml for the server-side
 * rationale.
 */

import type { NuxeoErrorPayload } from '../types/nuxeo';
import { bearerAuthHeader } from '../auth/tokenStore';
import { fetchCsrfToken, methodNeedsCsrf } from './csrf';

const rawBase = (import.meta.env.VITE_NUXEO_BASE_URL as string | undefined) ?? '/nuxeo';
export const NUXEO_BASE_URL: string = rawBase.replace(/\/+$/, '');
export const REST_ROOT: string = `${NUXEO_BASE_URL}/api/v1`;

export const IS_MOCK_MODE: boolean =
  String(import.meta.env.VITE_MOCK_MODE ?? '').toLowerCase() === 'true';

/**
 * `Authorization: Bearer <token>` header for the current OIDC session,
 * or `{}` if not signed in. Exported (in addition to being used
 * internally by `nuxeoRequest`) because `uploadApi.ts`'s raw XHR upload
 * path needs to attach the same header outside of `nuxeoRequest`.
 */
export function authHeader(): Record<string, string> {
  return bearerAuthHeader();
}

export class NuxeoApiError extends Error {
  public readonly status: number;
  public readonly payload?: NuxeoErrorPayload | string;
  constructor(message: string, status: number, payload?: NuxeoErrorPayload | string) {
    super(message);
    this.name = 'NuxeoApiError';
    this.status = status;
    this.payload = payload;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Query-string parameters. `undefined`/`null` values are omitted. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Extra request headers. Never put credentials here from calling code. */
  headers?: Record<string, string>;
  /** Body payload for POST/PUT. Serialized as JSON. */
  body?: unknown;
  /** Abort signal. */
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(
    `${REST_ROOT}${path.startsWith('/') ? path : `/${path}`}`,
    // relative base for /nuxeo — resolve against current origin
    window.location.origin,
  );
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Some Nuxeo servlet-level rejections (e.g. `WebSecurityException` thrown
 * from a WebObject before Nuxeo's own JSON exception mapper is reached)
 * fall through to Tomcat's default HTML error page instead of the usual
 * `{"entity-type":"exception",...}` envelope. Extract the `<h1>` — Tomcat's
 * canonical "HTTP Status NNN – Reason" line — so the UI shows a short,
 * readable message instead of a raw HTML blob. Falls back to the raw text
 * if the shape doesn't match.
 */
function extractHtmlErrorMessage(html: string, status: number): string {
  const h1 = /<h1[^>]*>(.*?)<\/h1>/is.exec(html);
  const captured = h1?.[1];
  if (captured) {
    // Tomcat encodes the en dash as "–"; strip the leading "HTTP Status NNN"
    // prefix so the message reads naturally next to our own status prefix.
    return captured.replace(/^HTTP Status \d+\s*[–-]?\s*/i, '').trim() || `HTTP ${status}`;
  }
  return html.slice(0, 200) || `HTTP ${status}`;
}

async function parseError(res: Response): Promise<NuxeoApiError> {
  const contentType = res.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = (await res.json()) as NuxeoErrorPayload;
      return new NuxeoApiError(body?.message ?? res.statusText, res.status, body);
    }
    const text = await res.text();
    const message = contentType.includes('text/html')
      ? extractHtmlErrorMessage(text, res.status)
      : text || res.statusText;
    return new NuxeoApiError(message, res.status, text);
  } catch {
    return new NuxeoApiError(res.statusText, res.status);
  }
}

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

async function doFetch(url: string, method: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, method });
}

/** Low-level typed request. Throws `NuxeoApiError` on non-2xx. */
export async function nuxeoRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, opts.query);
  const method = opts.method ?? 'GET';

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...authHeader(),
    ...(opts.headers ?? {}),
  };
  // Nuxeo's CSRF filter guards state-changing methods. A real OIDC Bearer
  // token is immune to CSRF by construction, but the local dev-auth Basic
  // header is not, and the dev/prod images both enable this filter — see
  // `csrf.ts`'s docstring. Fetching a token is a no-op (returns null) on
  // any deployment that doesn't require one, so this is safe everywhere.
  if (methodNeedsCsrf(method)) {
    const csrf = await fetchCsrfToken();
    if (csrf) headers['CSRF-Token'] = csrf;
  }
  const init: RequestInit = {
    headers,
    credentials: 'include',
    signal: opts.signal,
  };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  const res = await doFetch(url, method, init);

  if (!res.ok) {
    if (res.status === 401) {
      throw new NuxeoApiError('Not authenticated', 401);
    }
    throw await parseError(res);
  }
  if (res.status === 204) return undefined as T;
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return (await res.text()) as unknown as T;
  }
  return (await res.json()) as T;
}
