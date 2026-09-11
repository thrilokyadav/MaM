import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { DashboardPage } from './pages/DashboardPage';
import { AssetSearchPage } from './pages/AssetSearchPage';
import { AssetDetailPage } from './pages/AssetDetailPage';
import { UploadPage } from './pages/UploadPage';
import { ReviewQueuePage } from './pages/ReviewQueuePage';
import { ArchivePage } from './pages/ArchivePage';
import { SettingsPage } from './pages/SettingsPage';
import { UsersPage } from './pages/UsersPage';
import { RequireAuth } from './auth/RequireAuth';
import { SigninCallbackPage } from './auth/SigninCallbackPage';
import { SilentRenewPage } from './auth/SilentRenewPage';
import { RequireDevAuth } from './auth/DevAuthProvider';

/**
 * Auth guard used around the authenticated route tree. In a dev server
 * (`import.meta.env.DEV`), this is `RequireDevAuth` (backed by
 * `DevAuthProvider`, mounted in `main.tsx` — see that file and
 * `DevAuthProvider.tsx` for why: there is no real OIDC Identity Provider
 * available locally, so the production `RequireAuth`/`AuthProvider` pair
 * would otherwise redirect forever with nowhere to land). In a production
 * build this constant folds to `RequireAuth` and the dev-only module is
 * tree-shaken out entirely.
 */
const Guard = import.meta.env.DEV ? RequireDevAuth : RequireAuth;

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* OIDC redirect targets: never wrapped in the auth guard, since
            the whole point is to run before the user is authenticated.
            Unused (but harmless) when DevAuthProvider is active. */}
        <Route path="auth/callback" element={<SigninCallbackPage />} />
        <Route path="auth/silent-renew" element={<SilentRenewPage />} />

        <Route
          element={
            <Guard>
              <AppShell />
            </Guard>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="assets" element={<AssetSearchPage />} />
          <Route path="asset/:uid" element={<AssetDetailPage />} />
          <Route path="upload" element={<UploadPage />} />
          <Route path="review" element={<ReviewQueuePage />} />
          <Route path="archive" element={<ArchivePage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
