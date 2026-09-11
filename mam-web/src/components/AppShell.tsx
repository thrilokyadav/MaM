import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Film,
  Upload,
  ClipboardCheck,
  Archive,
  Settings,
  Search,
  Bell,
  Menu,
  X,
  ChevronRight,
  LogOut,
  Users as UsersIcon,
} from 'lucide-react';
import { useCurrentUserDisplay } from '../auth/useCurrentUserDisplay';
import { getCurrentUser } from '../api/meApi';
import './AppShell.css';

interface NavEntry {
  to: string;
  label: string;
  Icon: typeof LayoutDashboard;
  end?: boolean;
  /** When true, the entry only shows for administrators. */
  adminOnly?: boolean;
}

const NAV: NavEntry[] = [
  { to: '/',        label: 'Dashboard',    Icon: LayoutDashboard, end: true },
  { to: '/assets',  label: 'Assets',       Icon: Film },
  { to: '/upload',  label: 'Upload media', Icon: Upload },
  { to: '/review',  label: 'Review queue', Icon: ClipboardCheck },
  { to: '/archive', label: 'Archive',      Icon: Archive },
  { to: '/users',   label: 'Manage users', Icon: UsersIcon, adminOnly: true },
  { to: '/settings',label: 'Settings',     Icon: Settings },
];

/**
 * Whether the current principal is an administrator, from `GET /me`.
 * Used only to decide whether the admin-only nav entries are shown; the
 * pages behind them re-check server-side, so this is a UX affordance, not
 * the security boundary. Undefined until the first `/me` resolves.
 */
function useIsAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then((me) => {
        if (cancelled) return;
        setIsAdmin(me.isAdministrator || (me.properties.groups ?? []).includes('administrators'));
      })
      .catch(() => {
        /* not signed in / unreachable — leave admin nav hidden. */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return isAdmin;
}

/** Titles used in the top-bar breadcrumb. Not tied to route params. */
const ROUTE_TITLES: Array<{ match: RegExp; crumb: string; parent?: string }> = [
  { match: /^\/$/,          crumb: 'Dashboard' },
  { match: /^\/assets$/,    crumb: 'Assets' },
  { match: /^\/upload$/,    crumb: 'Upload media' },
  { match: /^\/review$/,    crumb: 'Review queue' },
  { match: /^\/archive$/,   crumb: 'Archive' },
  { match: /^\/users$/,     crumb: 'Manage users' },
  { match: /^\/settings$/,  crumb: 'Settings' },
  { match: /^\/asset\/.+$/, crumb: 'Asset detail', parent: 'Assets' },
];

function resolveBreadcrumb(pathname: string): { crumb: string; parent?: string } {
  for (const r of ROUTE_TITLES) {
    if (r.match.test(pathname)) return { crumb: r.crumb, parent: r.parent };
  }
  return { crumb: 'MAM' };
}

export function AppShell() {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const currentUser = useCurrentUserDisplay();
  const isAdmin = useIsAdmin();
  const navEntries = NAV.filter((n) => !n.adminOnly || isAdmin);

  // Close the mobile sidebar on route change.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const { crumb, parent } = resolveBreadcrumb(location.pathname);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  return (
    <div className={`shell${mobileOpen ? ' shell-mobile-open' : ''}`}>
      <a href="#main" className="skip-link">Skip to main content</a>

      {/* Mobile-only backdrop; clicking closes the drawer. */}
      <button
        type="button"
        className="shell-scrim"
        aria-hidden={!mobileOpen}
        tabIndex={-1}
        onClick={closeMobile}
      />

      <aside className="sidebar" aria-label="Primary">
        <div className="sidebar-brand">
          <span className="sidebar-mark" aria-hidden="true" />
          <div className="sidebar-brand-text">
            <span className="sidebar-brand-name">MAM</span>
            <span className="sidebar-brand-sub">Newsroom</span>
          </div>
          <button
            type="button"
            className="sidebar-close btn btn-quiet btn-icon"
            onClick={closeMobile}
            aria-label="Close menu"
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="Primary navigation">
          {navEntries.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `sidebar-link${isActive ? ' sidebar-link-active' : ''}`
              }
            >
              <span className="sidebar-link-rail" aria-hidden="true" />
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-avatar" aria-hidden="true">
              <span>{currentUser.initials}</span>
            </div>
            <div className="sidebar-user-text">
              <span className="sidebar-user-name">Newsroom desk</span>
              <span className="sidebar-user-sub">Signed in as {currentUser.name}</span>
            </div>
            {currentUser.signOut ? (
              <button
                type="button"
                className="btn btn-quiet btn-icon"
                onClick={currentUser.signOut}
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
      </aside>

      <div className="stage">
        <header className="topbar" role="banner">
          <button
            type="button"
            className="topbar-menu btn btn-quiet btn-icon"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu aria-hidden="true" />
          </button>
          <nav className="topbar-crumbs" aria-label="Breadcrumb">
            {parent ? (
              <>
                <span className="topbar-crumb topbar-crumb-parent">{parent}</span>
                <ChevronRight aria-hidden="true" className="topbar-crumb-sep" />
              </>
            ) : null}
            <span className="topbar-crumb topbar-crumb-current">{crumb}</span>
          </nav>

          <div className="topbar-actions">
            <div className="topbar-search input-with-icon" role="search">
              <Search aria-hidden="true" />
              <input
                className="input"
                type="search"
                placeholder="Search assets, slugs, programmes…"
                aria-label="Global search"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const target = e.currentTarget.value.trim();
                    if (target) {
                      const url = new URL(window.location.href);
                      url.pathname = '/assets';
                      url.search = `?q=${encodeURIComponent(target)}`;
                      window.location.assign(url.toString());
                    }
                  }
                }}
              />
            </div>
            <button
              type="button"
              className="btn btn-quiet btn-icon"
              aria-label="Notifications"
              title="Notifications"
            >
              <Bell aria-hidden="true" />
              <span className="topbar-dot" aria-hidden="true" />
            </button>
            <div className="topbar-account">
              <button
                type="button"
                className="topbar-avatar"
                aria-label="Account menu"
                title={`Signed in as ${currentUser.name}`}
              >
                {currentUser.initials}
              </button>
              <span className="topbar-account-name">Logged in as: {currentUser.name}</span>
              {currentUser.signOut ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm topbar-signout"
                  onClick={currentUser.signOut}
                >
                  <LogOut aria-hidden="true" />
                  Sign out
                </button>
              ) : null}
            </div>
          </div>
        </header>

        <main id="main" className="stage-main" role="main">
          <div className="stage-content">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
