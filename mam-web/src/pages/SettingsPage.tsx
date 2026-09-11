import { NUXEO_BASE_URL, IS_MOCK_MODE } from '../api/nuxeoClient';
import './pages.css';

export function SettingsPage() {
  return (
    <div className="page stack-6">
      <header className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">
            Connection details and identity. Nothing on this page is
            editable in the browser — configuration lives in deployment
            environment variables.
          </p>
        </div>
      </header>

      <section className="card card-body stack">
        <h2 className="section-title">Backend</h2>
        <dl className="detail-grid">
          <div className="detail-row">
            <dt>Nuxeo base URL</dt>
            <dd className="mono">{NUXEO_BASE_URL}</dd>
          </div>
          <div className="detail-row">
            <dt>REST root</dt>
            <dd className="mono">{NUXEO_BASE_URL}/api/v1</dd>
          </div>
          <div className="detail-row">
            <dt>Named page provider</dt>
            <dd className="mono">MAM_BROADCAST_ASSET_SEARCH</dd>
          </div>
          <div className="detail-row">
            <dt>Mock mode</dt>
            <dd>{IS_MOCK_MODE ? 'On (development only)' : 'Off'}</dd>
          </div>
        </dl>
      </section>

      <section className="card card-body stack">
        <h2 className="section-title">Identity</h2>
        <p>
          In production, sign-in uses OIDC/OAuth2 (Authorization Code +
          PKCE) — see <code className="mono">VITE_OIDC_*</code> in{' '}
          <code className="mono">.env.local</code>. When OIDC is not
          configured, local development can fall back to a static
          Basic-auth header sent by the app itself (
          <code className="mono">VITE_DEV_AUTH_*</code>), so the browser's
          native login prompt never appears. If neither is configured, no
          Authorization header is sent at all and the backend is expected
          to reject requests unless a reverse proxy in front of it
          negotiates identity itself.
        </p>
        <p>
          Group membership (<code className="mono">mam-producers</code>,
          <code className="mono"> mam-editors</code>,
          <code className="mono"> mam-publishers</code>,
          <code className="mono"> mam-archivists</code>) is managed in
          the identity provider. This addon does not create groups.
        </p>
      </section>

      <section className="card card-body stack">
        <h2 className="section-title">Preferences</h2>
        <p className="detail-note">
          Preferences (defaults for search, notification channels, keyboard
          shortcuts) will land in a later milestone.
        </p>
      </section>
    </div>
  );
}
