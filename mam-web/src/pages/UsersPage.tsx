/**
 * Manage Users — administrator-only screen for creating, listing, and
 * removing user accounts and assigning them a MAM role, without leaving
 * the app or running scripts.
 *
 * Access is gated two ways:
 *   - The nav entry only appears for administrators (see `AppShell.tsx`).
 *   - This page re-checks `GET /me`'s `isAdministrator` itself and shows a
 *     "not authorized" panel to anyone who reaches the route directly, so
 *     it never relies on the nav alone.
 *
 * The real enforcement is still server-side: Nuxeo's User/Group API only
 * lets administrators create/delete users, so even a forged request from
 * a non-admin gets a 403 (surfaced here as an error). This page's own
 * check is a UX affordance, not the security boundary.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  UserPlus,
  Trash2,
  ShieldAlert,
  Users as UsersIcon,
  Loader2,
  CheckCircle2,
  X,
} from 'lucide-react';
import {
  listUsers,
  createUser,
  deleteUser,
  ensureGroup,
  groupLabel,
  MAM_GROUPS,
  type NuxeoUser,
} from '../api/usersApi';
import { getCurrentUser } from '../api/meApi';
import { NuxeoApiError } from '../api/nuxeoClient';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import './pages.css';
import './UsersPage.css';

interface CreateFormState {
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  email: string;
  group: string;
}

const EMPTY_FORM: CreateFormState = {
  username: '',
  password: '',
  firstName: '',
  lastName: '',
  email: '',
  group: MAM_GROUPS[0],
};

type Banner =
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string }
  | null;

/** Pick the MAM role a user belongs to, for the role badge. */
function primaryRole(user: NuxeoUser): string {
  const groups = user.properties.groups ?? [];
  if (user.isAdministrator || groups.includes('administrators')) return 'administrators';
  const mam = groups.find((g) => (MAM_GROUPS as readonly string[]).includes(g));
  return mam ?? '—';
}

export function UsersPage() {
  const [isAdmin, setIsAdmin] = useState<boolean | undefined>(undefined);
  const [users, setUsers] = useState<NuxeoUser[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<CreateFormState>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [deletingUser, setDeletingUser] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<NuxeoUser | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await getCurrentUser();
      const admin = me.isAdministrator || (me.properties.groups ?? []).includes('administrators');
      setIsAdmin(admin);
      if (!admin) {
        setLoading(false);
        return;
      }
      // First-run convenience: make sure MAM's role groups exist, so the
      // role dropdown always assigns a real group. Idempotent.
      await Promise.all(
        MAM_GROUPS.map((g) => ensureGroup(g, groupLabel(g)).catch(() => undefined)),
      );
      const list = await listUsers('*');
      // Sort admins first, then alphabetically — a small, stable directory.
      list.sort((a, b) => a.id.localeCompare(b.id));
      setUsers(list);
    } catch (e) {
      const msg = e instanceof NuxeoApiError ? e.message : (e as Error).message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function updateField<K extends keyof CreateFormState>(key: K, value: CreateFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const canSubmit = useMemo(
    () => form.username.trim().length > 0 && form.password.length >= 4 && !creating,
    [form.username, form.password, creating],
  );

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    setCreating(true);
    setBanner(null);
    try {
      await createUser({
        username: form.username.trim(),
        password: form.password,
        firstName: form.firstName.trim() || form.username.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        groups: [form.group],
      });
      setBanner({ kind: 'success', message: `Created "${form.username.trim()}" as ${groupLabel(form.group)}.` });
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      const msg = err instanceof NuxeoApiError ? err.message : (err as Error).message;
      setBanner({ kind: 'error', message: msg });
    } finally {
      setCreating(false);
    }
  }

  async function onDeleteConfirmed(user: NuxeoUser) {
    setConfirmDelete(null);
    setDeletingUser(user.id);
    setBanner(null);
    try {
      await deleteUser(user.id);
      setBanner({ kind: 'success', message: `Removed "${user.id}".` });
      await load();
    } catch (err) {
      const msg = err instanceof NuxeoApiError ? err.message : (err as Error).message;
      setBanner({ kind: 'error', message: msg });
    } finally {
      setDeletingUser(null);
    }
  }

  // ---- Access states -------------------------------------------------

  if (loading) {
    return (
      <div className="page stack-6">
        <PageHeader />
        <LoadingState rows={4} label="Loading users" />
      </div>
    );
  }

  if (isAdmin === false) {
    return (
      <div className="page stack-6">
        <PageHeader />
        <ErrorState
          title="Administrators only"
          message="Managing users requires an administrator account. Sign in as an administrator to use this screen."
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page stack-6">
        <PageHeader />
        <ErrorState
          message={error}
          action={
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
              Retry
            </button>
          }
        />
      </div>
    );
  }

  // ---- Main -----------------------------------------------------------

  return (
    <div className="page stack-6">
      <PageHeader />

      {banner ? <ResultBanner banner={banner} onDismiss={() => setBanner(null)} /> : null}

      <section className="card card-body stack" aria-label="Create user">
        <h2 className="section-title">Add a user</h2>
        <form className="users-create-form" onSubmit={onCreate} noValidate>
          <label className="field">
            <span className="field-label">Username *</span>
            <input
              className="input"
              type="text"
              autoComplete="off"
              required
              value={form.username}
              onChange={(e) => updateField('username', e.currentTarget.value)}
              placeholder="jsmith"
            />
          </label>
          <label className="field">
            <span className="field-label">Password *</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              required
              value={form.password}
              onChange={(e) => updateField('password', e.currentTarget.value)}
              placeholder="At least 4 characters"
            />
          </label>
          <label className="field">
            <span className="field-label">Role *</span>
            <select
              className="select"
              value={form.group}
              onChange={(e) => updateField('group', e.currentTarget.value)}
            >
              {MAM_GROUPS.map((g) => (
                <option key={g} value={g}>{groupLabel(g)}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">First name</span>
            <input
              className="input"
              type="text"
              value={form.firstName}
              onChange={(e) => updateField('firstName', e.currentTarget.value)}
              placeholder="Jane"
            />
          </label>
          <label className="field">
            <span className="field-label">Last name</span>
            <input
              className="input"
              type="text"
              value={form.lastName}
              onChange={(e) => updateField('lastName', e.currentTarget.value)}
              placeholder="Smith"
            />
          </label>
          <label className="field">
            <span className="field-label">Email</span>
            <input
              className="input"
              type="email"
              value={form.email}
              onChange={(e) => updateField('email', e.currentTarget.value)}
              placeholder="jane.smith@example.com"
            />
          </label>
          <div className="users-create-actions">
            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
              {creating ? <Loader2 className="users-spin" aria-hidden="true" /> : <UserPlus aria-hidden="true" />}
              {creating ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </form>
      </section>

      <section className="card stack" aria-label="Existing users">
        <div className="users-list-head">
          <h2 className="section-title">Users</h2>
          <span className="results-count">{users?.length ?? 0} total</span>
        </div>

        {!users || users.length === 0 ? (
          <EmptyState
            Icon={UsersIcon}
            title="No users yet"
            description="Create the first user with the form above."
          />
        ) : (
          <table className="users-table">
            <thead>
              <tr>
                <th scope="col">Username</th>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Email</th>
                <th scope="col" className="users-col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const role = primaryRole(u);
                const fullName = [u.properties.firstName, u.properties.lastName]
                  .filter(Boolean)
                  .join(' ');
                const isBusy = deletingUser === u.id;
                return (
                  <tr key={u.id}>
                    <td className="users-username">{u.id}</td>
                    <td>{fullName || '—'}</td>
                    <td>
                      <span className={`role-badge role-${role}`}>{groupLabel(role)}</span>
                    </td>
                    <td className="users-email">{u.properties.email || '—'}</td>
                    <td className="users-col-actions">
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => setConfirmDelete(u)}
                        disabled={isBusy || role === 'administrators'}
                        title={role === 'administrators' ? 'Administrator accounts cannot be removed here.' : 'Remove user'}
                      >
                        {isBusy ? <Loader2 className="users-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {confirmDelete ? (
        <ConfirmDialog
          user={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void onDeleteConfirmed(confirmDelete)}
        />
      ) : null}
    </div>
  );
}

function PageHeader() {
  return (
    <header className="page-header">
      <div>
        <h1 className="page-title">Manage users</h1>
        <p className="page-subtitle">
          Create accounts, assign a role, and remove users. Roles decide
          what each person can do — Producers upload and submit, Editors
          approve or reject, Archivists move assets to cold storage.
        </p>
      </div>
    </header>
  );
}

function ResultBanner({ banner, onDismiss }: { banner: NonNullable<Banner>; onDismiss: () => void }) {
  const Icon = banner.kind === 'success' ? CheckCircle2 : ShieldAlert;
  return (
    <div className={`users-banner users-banner-${banner.kind}`} role={banner.kind === 'success' ? 'status' : 'alert'}>
      <Icon aria-hidden="true" />
      <span>{banner.message}</span>
      <button type="button" className="btn btn-quiet btn-sm users-banner-dismiss" onClick={onDismiss} aria-label="Dismiss">
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

function ConfirmDialog({
  user,
  onCancel,
  onConfirm,
}: {
  user: NuxeoUser;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className="modal-panel card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="users-delete-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="users-delete-title" className="section-title">Remove user</h2>
          <button type="button" className="btn btn-quiet btn-icon" onClick={onCancel} aria-label="Close">
            <X aria-hidden="true" />
          </button>
        </div>
        <p className="modal-body-text">
          Remove <strong>{user.id}</strong>? They will lose access
          immediately. This cannot be undone from here.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>
            <Trash2 aria-hidden="true" /> Remove user
          </button>
        </div>
      </div>
    </div>
  );
}
