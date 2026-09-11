import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { DevAuthProvider } from './auth/DevAuthProvider';
import './styles/global.css';

/**
 * Top-level auth provider: `DevAuthProvider` in a dev server build,
 * `AuthProvider` (real OIDC) otherwise. Mirrors the `Guard` choice in
 * `App.tsx` — the two must always agree, since `RequireDevAuth` reads
 * from `DevAuthProvider`'s context and `RequireAuth` reads from
 * `AuthProvider`'s (react-oidc-context). `import.meta.env.DEV` is a
 * Vite build-time constant, so the branch not taken is tree-shaken out
 * of the production bundle entirely — no dev-auth code ships to prod.
 */
function RootAuthProvider({ children }: { children: ReactNode }) {
  if (import.meta.env.DEV) {
    return <DevAuthProvider>{children}</DevAuthProvider>;
  }
  return <AuthProvider>{children}</AuthProvider>;
}

// Dev-only test hook: expose the CSRF-aware API modules on `window` so
// end-to-end scripts can exercise workflow/action helpers without adding
// throwaway UI buttons. Never included in production bundles because Vite
// tree-shakes `import.meta.env.DEV === false` branches.
if (import.meta.env.DEV) {
  Promise.all([
    import('./api/nuxeoClient'),
    import('./api/uploadApi'),
    import('./api/actionsApi'),
  ]).then(([client, upload, actions]) => {
    (window as unknown as { __mam: unknown }).__mam = { ...client, ...upload, ...actions };
  });
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found in index.html');

createRoot(rootEl).render(
  <StrictMode>
    <RootAuthProvider>
      <App />
    </RootAuthProvider>
  </StrictMode>,
);
