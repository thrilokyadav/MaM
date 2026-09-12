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

export interface UserRoles {
  isAdministrator: boolean;
  isProducer: boolean;
  isEditor: boolean;
  isArchivist: boolean;
  isPublisher: boolean;
  groups: string[];
}

export function useUserRoles(): { roles: UserRoles; loading: boolean } {
  const [roles, setRoles] = useState<UserRoles>({
    isAdministrator: false,
    isProducer: false,
    isEditor: false,
    isArchivist: false,
    isPublisher: false,
    groups: [],
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then((me) => {
        if (cancelled) return;
        const groups = me.properties.groups ?? [];
        const isAdministrator = Boolean(me.isAdministrator || groups.includes('administrators'));
        setRoles({
          isAdministrator,
          isProducer: groups.includes('mam-producers'),
          isEditor: groups.includes('mam-editors'),
          isArchivist: groups.includes('mam-archivists'),
          isPublisher: groups.includes('mam-publishers'),
          groups,
        });
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { roles, loading };
}

interface NavEntry {
  to: string;
  label: string;
  Icon: typeof LayoutDashboard;
  end?: boolean;
  isAllowed: (roles: UserRoles) => boolean;
}

const NAV: NavEntry[] = [
  { to: '/',        label: 'Dashboard',    Icon: LayoutDashboard, end: true, isAllowed: () => true },
  { to: '/assets',  label: 'Assets',       Icon: Film, isAllowed: () => true },
  { to: '/upload',  label: 'Upload media', Icon: Upload, isAllowed: (r) => r.isAdministrator || r.isProducer },
  { to: '/review',  label: 'Review queue', Icon: ClipboardCheck, isAllowed: (r) => r.isAdministrator || r.isProducer || r.isEditor },
  { to: '/archive', label: 'Archive',      Icon: Archive, isAllowed: (r) => r.isAdministrator || r.isArchivist },
  { to: '/users',   label: 'Manage users', Icon: UsersIcon, isAllowed: (r) => r.isAdministrator },
  { to: '/settings',label: 'Settings',     Icon: Settings, isAllowed: (r) => r.isAdministrator },
];

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
  const { roles } = useUserRoles();
  const navEntries = NAV.filter((n) => n.isAllowed(roles));

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
