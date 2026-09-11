/**
 * The authenticated principal, resolved entirely server-side.
 *
 * Endpoint: `GET /api/v1/me` (nuxeo-rest-api-server `MeObject`, `@since 9.1`).
 * Returns the `NuxeoPrincipal` bound to the current session/credentials —
 * there is no request parameter to ask for a different user. This is the
 * only source of identity this app uses for task filtering; nothing in the
 * UI accepts or forwards an arbitrary `userId`.
 */

import { nuxeoRequest } from './nuxeoClient';

export interface NuxeoMe {
  'entity-type': 'user';
  id: string;
  name: string;
  properties: {
    username: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    groups: string[];
  };
  isAdministrator: boolean;
  isAnonymous: boolean;
}

let cached: Promise<NuxeoMe> | null = null;

/**
 * Fetch the current principal. Cached for the lifetime of the *current
 * session* — every task list/action/permission check needs it, so this
 * avoids a redundant `GET /me` per call.
 *
 * Deliberately does NOT forward a caller's `AbortSignal` into the shared
 * request: this promise is shared across every caller, so one caller's
 * unmount/cleanup (e.g. React StrictMode's dev-only double-effect-invoke,
 * or a route change) must not cancel the in-flight request for every other
 * caller still awaiting it.
 */
export async function getCurrentUser(): Promise<NuxeoMe> {
  if (!cached) {
    cached = nuxeoRequest<NuxeoMe>('/me', { method: 'GET' }).catch((e) => {
      cached = null; // don't poison the cache with a failed attempt
      throw e;
    });
  }
  return cached;
}

/**
 * Clears the cached principal. MUST be called whenever the active
 * credential changes — sign-in as a different user, or sign-out — or
 * every permission/identity check in the app (the review queue, archive
 * row-level permission checks, the admin-only nav gate, etc.) keeps
 * returning the *previous* user's identity after switching accounts,
 * since this cache has no other way to know the session changed.
 *
 * Called by `DevAuthProvider.login()`/`logout()` and by `AuthProvider`'s
 * OIDC user-changed effect — see those files.
 */
export function clearCurrentUserCache(): void {
  cached = null;
}
