/**
 * User & group administration against Nuxeo's REST User/Group API
 * (`/api/v1/user`, `/api/v1/group`, `/api/v1/user/search`,
 * `/api/v1/group/{name}/@users`). Backs the in-app "Manage users" admin
 * screen (`pages/UsersPage.tsx`).
 *
 * Why this doesn't just use `nuxeoClient.nuxeoRequest`
 * -----------------------------------------------------
 * `nuxeoClient.ts` is deliberately Bearer-only and does NOT perform
 * Nuxeo's CSRF-Token handshake — its docstring explains that Bearer
 * tokens are immune to CSRF, so for the production OIDC path that's
 * correct and these writes will go straight through. BUT in local
 * development the app authenticates with a `Basic` header (via
 * `DevAuthProvider`/`tokenStore`), and the dev smoke/integration Nuxeo
 * images enable `nuxeo.csrf.token.enabled=true`. A state-changing request
 * (POST/DELETE a user) carrying a `Basic`/cookie credential but no
 * CSRF token is rejected with HTTP 403 by `NuxeoCorsCsrfFilter` — verified
 * directly against the running smoke stack.
 *
 * So this module performs the documented handshake for its own writes:
 * `GET /nuxeo` with header `CSRF-Token: fetch` (the server returns a
 * per-session `CSRF-Token` response header, tied to the `JSESSIONID`
 * cookie it also sets), then replays that token on the write. It uses
 * `credentials: 'include'` so the browser carries that session cookie.
 * Reads (`GET`) need none of this. When a real Bearer token is present
 * (production OIDC), the CSRF fetch is simply harmless overhead the server
 * ignores — the token still works either way.
 */

import { REST_ROOT, authHeader, NuxeoApiError } from './nuxeoClient';
import { fetchCsrfToken } from './csrf';

/** MAM's four role groups plus the built-in admin group. */
export const MAM_GROUPS = [
  'mam-producers',
  'mam-editors',
  'mam-archivists',
  'mam-publishers',
] as const;
export type MamGroup = (typeof MAM_GROUPS)[number];

export interface NuxeoUser {
  'entity-type': 'user';
  id: string;
  properties: {
    username: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    groups?: string[];
  };
  isAdministrator?: boolean;
}

interface NuxeoUserListResult {
  'entity-type': 'users';
  entries: NuxeoUser[];
  resultsCount?: number;
  numberOfPages?: number;
  currentPageIndex?: number;
}

export interface CreateUserInput {
  username: string;
  password: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  groups: string[];
}

// ---------------------------------------------------------------------------
// Request helpers (CSRF handshake for writes lives in `csrf.ts`, shared
// with `nuxeoClient.ts` and `uploadApi.ts` — see module docstring)
// ---------------------------------------------------------------------------

async function readError(res: Response): Promise<NuxeoApiError> {
  const ct = res.headers.get('content-type') ?? '';
  try {
    if (ct.includes('application/json')) {
      const body = (await res.json()) as { message?: string };
      return new NuxeoApiError(body?.message ?? res.statusText, res.status, body as never);
    }
    const text = await res.text();
    return new NuxeoApiError(text || res.statusText, res.status, text);
  } catch {
    return new NuxeoApiError(res.statusText, res.status);
  }
}

/** GET helper — no CSRF needed for reads. */
async function getJson<T>(path: string, query?: Record<string, string>): Promise<T> {
  const url = new URL(`${REST_ROOT}${path}`, window.location.origin);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json', ...authHeader() },
    credentials: 'include',
  });
  if (!res.ok) {
    if (res.status === 401) throw new NuxeoApiError('Not authenticated', 401);
    if (res.status === 403) throw new NuxeoApiError('You are not allowed to manage users.', 403);
    throw await readError(res);
  }
  return (await res.json()) as T;
}

/** Write helper (POST/PUT/DELETE) — performs the CSRF handshake first. */
async function writeJson<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const csrf = await fetchCsrfToken();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...authHeader(),
  };
  if (csrf) headers['CSRF-Token'] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${REST_ROOT}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    if (res.status === 401) throw new NuxeoApiError('Not authenticated', 401);
    if (res.status === 403) {
      throw new NuxeoApiError(
        'Not allowed. Only administrators can manage users.',
        403,
      );
    }
    if (res.status === 409) {
      throw new NuxeoApiError('A user with that username already exists.', 409);
    }
    throw await readError(res);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List users. Nuxeo's `/user/search` requires a query; `*` matches all.
 * Page size is capped generously — a newsroom user directory is small.
 */
export async function listUsers(query = '*', signal?: AbortSignal): Promise<NuxeoUser[]> {
  void signal; // fetch abort omitted for brevity; directory is tiny and fast.
  const result = await getJson<NuxeoUserListResult>('/user/search', {
    q: query || '*',
    pageSize: '200',
  });
  return result.entries ?? [];
}

/** Create a user in the given group(s). */
export async function createUser(input: CreateUserInput): Promise<NuxeoUser> {
  const body = {
    'entity-type': 'user',
    properties: {
      username: input.username,
      firstName: input.firstName ?? input.username,
      lastName: input.lastName ?? '',
      email: input.email ?? '',
      password: input.password,
      groups: input.groups,
    },
  };
  return writeJson<NuxeoUser>('POST', '/user', body);
}

/** Delete a user by username. */
export async function deleteUser(username: string): Promise<void> {
  await writeJson<void>('DELETE', `/user/${encodeURIComponent(username)}`);
}

/**
 * Ensure a group exists (idempotent). Nuxeo returns 409 if it already
 * exists, which we swallow — the goal is just "make sure it's there".
 * Used to auto-provision MAM's role groups the first time an admin opens
 * the Users screen, since the addon itself doesn't create them.
 */
export async function ensureGroup(groupname: string, label: string): Promise<void> {
  try {
    await writeJson<unknown>('POST', '/group', {
      'entity-type': 'group',
      groupname,
      grouplabel: label,
    });
  } catch (e) {
    if (e instanceof NuxeoApiError && (e.status === 409 || e.status === 500)) return;
    throw e;
  }
}

/** Human-readable label for a MAM group id. */
export function groupLabel(group: string): string {
  switch (group) {
    case 'mam-producers':
      return 'Producer';
    case 'mam-editors':
      return 'Editor';
    case 'mam-archivists':
      return 'Archivist';
    case 'mam-publishers':
      return 'Publisher';
    case 'administrators':
      return 'Administrator';
    default:
      return group;
  }
}
