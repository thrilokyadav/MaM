import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev-time proxy. Any request that starts with `/nuxeo` is forwarded to the
 * upstream Nuxeo server so the browser never issues cross-origin calls.
 *
 * The upstream URL is read from `VITE_NUXEO_PROXY_TARGET` (falls back to the
 * default local smoke stack). This value is DEVELOPMENT-ONLY: the built
 * bundle does not embed the target, it just issues `/nuxeo/...` relative
 * URLs and expects a same-origin gateway to route them.
 */
export default defineConfig(({ mode }) => {
  // Load .env / .env.local from the project root. `''` prefix means "all
  // vars", not just VITE_*, so we can also read VITE_NUXEO_PROXY_TARGET
  // without exposing it to the client bundle.
  const env = loadEnv(mode, '.', '');
  // Target Nuxeo instance (reads .env.local VITE_NUXEO_PROXY_TARGET, default 8081)
  const proxyTarget = env.VITE_NUXEO_PROXY_TARGET ?? 'http://127.0.0.1:8081';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: false,
      proxy: {
        '/nuxeo': {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
          // Nuxeo's NuxeoCorsCsrfFilter compares the browser Origin/Referer
          // against the request's target URI (as reconstructed via
          // VirtualHostHelper). The proper reverse-proxy behaviour — used
          // by nginx, apache and any production gateway — is to tell the
          // upstream what the client actually sees via X-Forwarded-* so
          // Nuxeo's target URI equals the browser's origin.
          //
          // The browser's real Origin/Referer are left untouched (never
          // spoofed): Nuxeo sees the same values a same-origin deployment
          // would emit.
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              const host = req.headers.host; // e.g. "localhost:5173"
              if (host) {
                proxyReq.setHeader('X-Forwarded-Host', host);
                const colon = host.lastIndexOf(':');
                if (colon > -1) {
                  proxyReq.setHeader('X-Forwarded-Port', host.slice(colon + 1));
                }
              }
              proxyReq.setHeader('X-Forwarded-Proto', 'http');
            });
          },
        },
      },
    },
    preview: {
      port: 4173,
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      target: 'es2022',
    },
  };
});
