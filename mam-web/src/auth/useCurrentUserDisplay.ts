/**
 * Resolves the display name / initials and sign-out action for the
 * signed-in user, for the sidebar/topbar (`AppShell.tsx`).
 *
 * Three cases, checked in order:
 *   1. Dev server + `DevAuthProvider` active (`import.meta.env.DEV`) —
 *      show the real verified username from the interactive login
 *      session, with a working `logout()` that clears it and returns to
 *      `LoginPage`.
 *   2. Production build with OIDC configured — read the OIDC user's
 *      profile claims (`react-oidc-context`) and wire `signoutRedirect`.
 *   3. Neither (mock mode / no-auth deployment) — static placeholder,
 *      no sign-out action since there is no session to end.
 */
import { useAuth } from 'react-oidc-context';
import { OIDC_CONFIGURED } from './AuthProvider';
import { useDevAuth } from './DevAuthProvider';

export interface CurrentUserDisplay {
  name: string;
  initials: string;
  signOut: (() => void) | null;
}

const FALLBACK: CurrentUserDisplay = { name: 'Administrator', initials: 'NR', signOut: null };

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'NR';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  const first = parts[0]!.charAt(0);
  const last = parts[parts.length - 1]!.charAt(0);
  return (first + last).toUpperCase();
}

export function useCurrentUserDisplay(): CurrentUserDisplay {
  // import.meta.env.DEV is a build-time constant, so exactly one branch
  // of this `if` ever exists per build — the unused hook call below
  // isn't a rules-of-hooks violation across renders of a given build.
  if (import.meta.env.DEV) {
    return useDevAuthUserDisplay();
  }
  if (!OIDC_CONFIGURED) {
    return FALLBACK;
  }
  return useOidcUserDisplay();
}

function useDevAuthUserDisplay(): CurrentUserDisplay {
  const { user, logout } = useDevAuth();
  if (!user) return FALLBACK;
  return {
    name: `${user.username} (dev)`,
    initials: initialsFor(user.username),
    signOut: logout,
  };
}

function useOidcUserDisplay(): CurrentUserDisplay {
  const auth = useAuth();
  const profile = auth.user?.profile;
  const name =
    (profile?.name as string | undefined) ??
    (profile?.preferred_username as string | undefined) ??
    (profile?.email as string | undefined) ??
    'Signed in';
  return {
    name,
    initials: initialsFor(name),
    signOut: () => void auth.signoutRedirect(),
  };
}
