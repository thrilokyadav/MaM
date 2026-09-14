import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { LoadingState } from './components/LoadingState';
import { RequireAuth } from './auth/RequireAuth';
import { SigninCallbackPage } from './auth/SigninCallbackPage';
import { SilentRenewPage } from './auth/SilentRenewPage';
import { RequireDevAuth } from './auth/DevAuthProvider';

// Route-level code splitting: each page is loaded on demand rather than
// bundled into the initial download, so first paint pulls only the shell +
// the page you actually land on. React.lazy + Suspense is the standard
// react-router v6 idiom for this; the pages are unchanged.
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const AssetSearchPage = lazy(() => import('./pages/AssetSearchPage').then((m) => ({ default: m.AssetSearchPage })));
const AssetDetailPage = lazy(() => import('./pages/AssetDetailPage').then((m) => ({ default: m.AssetDetailPage })));
const UploadPage = lazy(() => import('./pages/UploadPage').then((m) => ({ default: m.UploadPage })));
const ReviewQueuePage = lazy(() => import('./pages/ReviewQueuePage').then((m) => ({ default: m.ReviewQueuePage })));
const ArchivePage = lazy(() => import('./pages/ArchivePage').then((m) => ({ default: m.ArchivePage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const UsersPage = lazy(() => import('./pages/UsersPage').then((m) => ({ default: m.UsersPage })));

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
          <Route
            index
            element={
              <Suspense fallback={<LoadingState rows={3} label="Loading" />}>
                <DashboardPage />
              </Suspense>
            }
          />
          <Route
            path="assets"
            element={
              <Suspense fallback={<LoadingState rows={3} label="Loading" />}>
                <AssetSearchPage />
              </Suspense>
            }
          />
          <Route
            path="asset/:uid"
            element={
              <Suspense fallback={<LoadingState rows={3} label="Loading" />}>
                <AssetDetailPage />
              </Suspense>
            }
          />
          <Route
            path="upload"
            element={
              <Suspense fallback={<LoadingState rows={3} label="Loading" />}>
                <UploadPage />
              </Suspense>
            }
          />
          <Route
            path="review"
            element={
              <Suspense fallback={<LoadingState rows={3} label="Loading" />}>
                <ReviewQueuePage />
              </Suspense>
            }
          />
          <Route
            path="archive"
            element={
              <Suspense fallback={<LoadingState rows={3} label="Loading" />}>
                <ArchivePage />
              </Suspense>
            }
          />
          <Route
            path="users"
            element={
              <Suspense fallback={<LoadingState rows={3} label="Loading" />}>
                <UsersPage />
              </Suspense>
            }
          />
          <Route
            path="settings"
            element={
              <Suspense fallback={<LoadingState rows={3} label="Loading" />}>
                <SettingsPage />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
