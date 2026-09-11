# MAM Web

Custom MAM front-end. React + TypeScript + Vite. Talks to the Nuxeo
backend at `D:\MaM\mam-platform` through Nuxeo's standard REST API. No
Nuxeo Web UI, no LitElement / Polymer, no JSF.

## Stack

- React 18.3
- react-router-dom 6.28
- lucide-react 0.469 (icon set)
- TypeScript 5.6 (`strict`, `noUncheckedIndexedAccess`, `noEmit`)
- Vite 5.4 (`@vitejs/plugin-react`)
- Semantic HTML, plain CSS, design tokens in `src/styles/tokens.css`
- Runtime dependencies: **4** (`react`, `react-dom`, `react-router-dom`, `lucide-react`)

## Design system

Newsroom console: deep-navy sidebar, warm off-white canvas, white cards,
one indigo accent. No gradients. One subtle shadow tier
(`--shadow-1`). Consistent button variants (`btn-primary`,
`btn-secondary`, `btn-quiet`, `btn-danger`), consistent badge kinds
(Draft, QC, Approved, Rejected, Hot, Warm, Cold), consistent card
radii (12–16 px), accessible focus rings.

## Screens

| Route                | Purpose                                                      |
|----------------------|--------------------------------------------------------------|
| `/`                  | Dashboard: hero, primary Upload / Browse actions, four live metric cards, recent assets, first-run onboarding when the index is empty. |
| `/assets`            | Full search UI over `MAM_BROADCAST_ASSET_SEARCH`. Chip filters for status, story type, archive tier. Clear-filters, sort label, pagination. URL-backed state. |
| `/asset/:uid`        | Single-asset view. Media plate, action buttons (Edit metadata / Submit for review / Approve / Reject / Archive) that reflect the current status **and** the caller's permissions (fetched via Nuxeo's `permissions` enricher). Grouped Editorial / Broadcast / Rights / Processing / System sections. |
| `/upload`            | Drag-and-drop zone plus honest "Upload integration coming next" notice; staged files stay in memory and are **not** transmitted. |
| `/review`            | Editor's queue: assets currently in QC. |
| `/archive`           | Storage-tier tabs (Hot / Warm / Cold). |
| `/settings`          | Read-only view of the backend connection and identity model. |

## Local setup

```
cd D:\MaM\mam-web
npm install
cp .env.example .env.local     # then edit — see "Environment variables" below
npm run dev
```

The dev server listens on `http://localhost:5173` (Vite picks the next
free port, e.g. `5174`, if something else already holds 5173 — check the
terminal output for the actual URL). Every request to `/nuxeo/**` is
proxied to `VITE_NUXEO_PROXY_TARGET` (defaults to `http://localhost:8080`),
so the browser always sees same-origin traffic and CORS never enters the
picture in development.

You also need a running Nuxeo backend for anything beyond mock mode — see
**"End-to-end testing"** below for the full setup, including which backend
stack to run and how to authenticate against it.

Other scripts:

- `npm run typecheck` — TypeScript project check, no emit.
- `npm run build`     — production build to `dist/`.
- `npm run preview`   — serve the production build locally.

## Environment variables

All environment variables are read by Vite at build time. Never commit a
`.env` or `.env.local` file that contains real credentials.

| Variable                           | Purpose                                                            | Default                     |
|-------------------------------------|--------------------------------------------------------------------|-----------------------------|
| `VITE_NUXEO_BASE_URL`               | Browser-facing base for the Nuxeo REST API.                        | `/nuxeo`                    |
| `VITE_NUXEO_PROXY_TARGET`           | Upstream URL the **dev** proxy forwards `/nuxeo/*` to. Dev only.   | `http://localhost:8080`     |
| `VITE_OIDC_ISSUER`                  | Production auth: OIDC issuer/authority URL. Empty disables OIDC.   | *(empty)*                   |
| `VITE_OIDC_CLIENT_ID`               | Production auth: public SPA client id registered with the IdP.    | *(empty)*                   |
| `VITE_OIDC_SCOPE`                   | OIDC scopes requested. Must include the groups/roles claim scope. | `openid profile email groups` |
| `VITE_DEV_AUTH_ENABLED`             | Local dev only. If `true` **and OIDC is not configured**, the app itself attaches `Authorization: Basic <user:password>` to every request, so you never see the browser's native Basic-auth prompt. | `false` |
| `VITE_DEV_AUTH_USER`                | Dev-only Basic auth username (e.g. `Administrator`, or one of the test users below). | *(empty)* |
| `VITE_DEV_AUTH_PASSWORD`            | Dev-only Basic auth password.                                      | *(empty)*                   |
| `VITE_MOCK_MODE`                    | If `true`, use an in-memory mock backend. No Nuxeo needed. UI work only. | `false`                 |
| `VITE_MAM_INGEST_PATH`              | Parent path new assets are created under via Upload.               | `/default-domain/workspaces` |

`VITE_DEV_AUTH_*` only takes effect when OIDC is **not** configured
(`VITE_OIDC_ISSUER`/`VITE_OIDC_CLIENT_ID` empty). It has no effect on the
production build's recommended posture — production should still terminate
auth via OIDC or an SSO reverse proxy in front of `/nuxeo/**` (see
**Security** below).

## End-to-end testing (manual, user-facing)

This walks through testing the whole application as a real user would use
it — from starting the backend through exercising every screen and every
persona's permission boundaries. Nothing here requires Java/Maven; it uses
the pre-built Nuxeo smoke stack that already ships with `mam-platform`.

### 1. Start the backend

From `D:\MaM\mam-platform`:

```powershell
copy .env.smoke.example .env.smoke      # first time only
docker compose --env-file .env.smoke -f compose.smoke.yaml up -d
```

Wait until it reports healthy (first boot takes 2–5 minutes):

```powershell
docker compose -f compose.smoke.yaml ps
```

You should see `mam-smoke-nuxeo` as `Up (healthy)` on port `8080`. Confirm
the addon is actually loaded:

```powershell
curl.exe http://localhost:8080/nuxeo/runningstatus
curl.exe -u Administrator:Administrator http://localhost:8080/nuxeo/api/v1/config/types/BroadcastAsset
```

The second call should return a JSON body naming `BroadcastAsset` — if it
404s, the MAM package didn't install; rebuild with
`mvn -DskipTests package` in `mam-platform` and recreate the stack.

The smoke stack's seeded admin account is `Administrator` / `Administrator`
(see `.env.smoke`'s `SMOKE_ADMIN_USER`/`SMOKE_ADMIN_PASSWORD`).

### 2. Create one test user per persona

The addon does not provision the `mam-producers` / `mam-editors` /
`mam-archivists` groups itself (they're expected to come from an identity
provider in production) — for local testing, create them and one user in
each via the REST API. Nuxeo's CSRF protection requires a fresh
`CSRF-Token` per write, fetched from a plain `GET /nuxeo`:

```powershell
$basicAuth = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("Administrator:Administrator"))

function New-MamCsrfSession {
    $headerText = curl.exe -s -D - -o nul "http://localhost:8080/nuxeo" `
        -H "Authorization: Basic $basicAuth" -H "CSRF-Token: fetch" -c "$env:TEMP\mam-cookies.txt"
    ($headerText | Select-String "CSRF-Token: (.+)").Matches[0].Groups[1].Value.Trim()
}

function New-MamGroup($groupname, $label) {
    $csrf = New-MamCsrfSession
    $body = @{ 'entity-type' = 'group'; groupname = $groupname; grouplabel = $label } | ConvertTo-Json
    $body | Out-File -Encoding utf8 "$env:TEMP\mam-group.json"
    curl.exe -s -w "`nSTATUS:%{http_code}`n" -X POST "http://localhost:8080/nuxeo/api/v1/group" `
        -H "Authorization: Basic $basicAuth" -H "Content-Type: application/json" -H "CSRF-Token: $csrf" `
        -b "$env:TEMP\mam-cookies.txt" --data-binary "@$env:TEMP\mam-group.json"
}

function New-MamUser($username, $password, $group) {
    $csrf = New-MamCsrfSession
    $body = @{
        'entity-type' = 'user'
        properties = @{ username = $username; firstName = $username; lastName = 'MamTest'
                         email = "$username@example.test"; password = $password; groups = @($group) }
    } | ConvertTo-Json -Depth 5
    $body | Out-File -Encoding utf8 "$env:TEMP\mam-user.json"
    curl.exe -s -w "`nSTATUS:%{http_code}`n" -X POST "http://localhost:8080/nuxeo/api/v1/user" `
        -H "Authorization: Basic $basicAuth" -H "Content-Type: application/json" -H "CSRF-Token: $csrf" `
        -b "$env:TEMP\mam-cookies.txt" --data-binary "@$env:TEMP\mam-user.json"
}

# mam-editors and mam-archivists already exist after any smoke-test.ps1
# run; mam-producers/mam-publishers usually do not and need creating.
New-MamGroup -groupname "mam-producers"  -label "MAM Producers"
New-MamGroup -groupname "mam-publishers" -label "MAM Publishers"

New-MamUser -username "mam_producer1"  -password "Producer!2026"  -group "mam-producers"
New-MamUser -username "mam_editor1"    -password "Editor!2026"    -group "mam-editors"
New-MamUser -username "mam_archivist1" -password "Archivist!2026" -group "mam-archivists"
```

If a group/user already exists you'll get a `409` or `403` — that's fine,
it means it's already there from a previous run. Verify with:

```powershell
curl.exe -u Administrator:Administrator http://localhost:8080/nuxeo/api/v1/user/mam_producer1
```

### 2b. Grant the role bundles on the ingest folder (required — do not skip)

Creating the groups above is **not enough by itself**. `mam-security`
registers four permission bundles (`MAM_ProducerAccess`,
`MAM_EditorAccess`, `MAM_ArchivistAccess`, `MAM_PublisherAccess`) but does
**not** grant them anywhere — that grant is a deployment-time step this
addon deliberately leaves to whoever owns the content tree, since in
production it might be a different folder structure entirely. On a fresh
smoke stack, the default `/default-domain/workspaces` folder only has
`Administrator: Everything` and `members: Read` — meaning every
non-admin user gets `403 Forbidden` on every read AND every upload/write,
until this step is done:

```powershell
$basicAuth = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("Administrator:Administrator"))

function New-MamCsrfSession2 {
    $headerText = curl.exe -s -D - -o nul "http://localhost:8080/nuxeo" `
        -H "Authorization: Basic $basicAuth" -H "CSRF-Token: fetch" -c "$env:TEMP\mam-cookies2.txt"
    ($headerText | Select-String "CSRF-Token: (.+)").Matches[0].Groups[1].Value.Trim()
}

function Grant-MamRoleBundle($group, $permission) {
    $csrf = New-MamCsrfSession2
    $body = @{
        input = 'doc:/default-domain/workspaces'
        params = @{ user = $group; permission = $permission; acl = 'local'; grant = $true; overwrite = $false }
    } | ConvertTo-Json -Depth 5
    $body | Out-File -Encoding utf8 "$env:TEMP\mam-ace.json"
    # overwrite MUST be $false on every call after the first, or each
    # call replaces the previous ACE instead of appending to it.
    curl.exe -s -w "`nSTATUS:%{http_code}`n" -X POST "http://localhost:8080/nuxeo/api/v1/automation/Document.AddACE" `
        -H "Authorization: Basic $basicAuth" -H "Content-Type: application/json" -H "CSRF-Token: $csrf" `
        -b "$env:TEMP\mam-cookies2.txt" --data-binary "@$env:TEMP\mam-ace.json"
}

Grant-MamRoleBundle "mam-producers"  "MAM_ProducerAccess"
Grant-MamRoleBundle "mam-editors"    "MAM_EditorAccess"
Grant-MamRoleBundle "mam-archivists" "MAM_ArchivistAccess"
Grant-MamRoleBundle "mam-publishers" "MAM_PublisherAccess"
```

Verify all four landed (should show all four `mam-*` entries under the
`local` ACL, in addition to the inherited `Administrator`/`members`
entries):

```powershell
curl.exe -u Administrator:Administrator http://localhost:8080/nuxeo/api/v1/path/default-domain/workspaces/@acl
```

> **Note:** `curl.exe`'s CSRF handling above is deliberately re-fetched
> per call — Nuxeo's CSRF token appears to be single-use/short-lived in
> this stack, so reusing one across multiple POSTs returns `403`.

### 3. Start the frontend

From `D:\MaM\mam-web`:

```
npm install
npm run dev
```

Open the URL Vite prints (`http://localhost:5173` or the next free port).
In a dev server (`npm run dev`), the app renders its own **Login Page**
(`src/pages/LoginPage.tsx`) instead of redirecting to an OIDC provider —
there is no real Identity Provider running locally, so production's OIDC
flow (`AuthProvider`/`RequireAuth`) is swapped out for a dev-only
`DevAuthProvider`/`RequireDevAuth` pair whenever `import.meta.env.DEV` is
true (see `src/main.tsx` / `src/App.tsx`). This never ships in a
production build — the branch not taken is tree-shaken out entirely.

Sign in with any real backend user — `Administrator` / `Administrator`,
or one of the persona test users from step 2. The login form calls
`GET /api/v1/me` with the submitted credentials before accepting them, so
a wrong password shows a real "Invalid credentials" error, not a fake
success. If `VITE_DEV_AUTH_USER`/`VITE_DEV_AUTH_PASSWORD` are set in
`.env.local`, the login form pre-fills with those values as a convenience
(you still have to click **Sign in**; no auto-login).

Once signed in, the top bar shows **"Logged in as: `<username>`"** with a
**Sign out** button next to it (also mirrored in the sidebar footer). The
session is cached in `localStorage` so a page refresh doesn't force a
re-login, but it's always re-verified against the backend on load — if the
stack was torn down and recreated (e.g. a fresh `docker compose up`
wiped the database), you'll be dropped back to the login page rather than
silently sending doomed requests.

### 4. Module-by-module test script

Run through each of these signed in as `Administrator` first (full access,
to confirm the feature itself works end-to-end), then **Sign out** and
sign back in as each persona-specific test user to re-run the
permission-sensitive ones — no `.env.local` edits or dev-server restarts
needed; just use the Sign out button and log back in as a different user.

**Dashboard (`/`)**
- Loads without error; metric cards show real counts (0 on a fresh stack).
- "Upload media" / "Browse assets" buttons navigate correctly.

**Upload (`/upload`) — persona: News Producer, `mam-producers`**
- Drag a small MP4 (or any file) onto the drop zone, or use "Browse files".
- Confirm the asset type auto-selects `BroadcastVideo` for video files and
  `BroadcastAsset` otherwise; you can override manually.
- Fill in Title (required) plus a few of Slug/Programme/Bureau/Story
  type/Air date/Editorial status, then click **Upload asset**.
- Watch the progress bar move through "Uploading to Nuxeo…" then
  "Creating document…", ending on a success card with the new asset's
  path/UID, auto-navigating to its detail page after ~1.5s.
- **As `mam_producer1`**: this should succeed (`mam-producers` gets `Read`,
  `Write`, `MAM_EditMetadata`, `MAM_SubmitForReview` via
  `MAM_ProducerAccess`).
- Test **Cancel** mid-upload on a larger file, and **Retry** after a
  simulated failure (e.g. stop the Nuxeo container mid-upload, restart it,
  click Retry).

**Assets (`/assets`) — search & facets, all personas**
- Confirm the asset just created appears in the list.
- Type a search term matching the title into the top search box (Enter to
  search) — full-text search (`ecm:fulltext`) does **not** work against
  the H2-backed smoke stack (`DialectH2` has no fulltext support); use the
  chip filters (story type, editorial status, archive tier) instead, which
  do work against H2's structured predicates.
- Clear filters, verify pagination controls appear once results exceed one
  page.
- Confirm the URL updates with each filter (`?storyType=...` etc.) and that
  reloading the page preserves the filtered view.

**Asset detail (`/asset/:uid`)**
- Open the asset created above. Confirm Editorial / Broadcast / Rights /
  Processing / System sections render with the values you entered.
- Click **Edit metadata**, change a field, **Save changes** — confirm the
  updated value persists after a page reload.
- If the asset is a `BroadcastVideo`, confirm a playback section appears
  (proxy may show "Processing" until Nuxeo's video pipeline finishes —
  poll by refreshing after ~30–60s).
- Click **Download original** — confirms a real authenticated blob fetch
  (not a bare `<a href>`, since the app never relies on a Nuxeo session
  cookie).
- Confirm action buttons (Submit for review / Approve / Reject / Archive)
  are enabled/disabled correctly based on both `editorialStatus` and the
  signed-in user's permissions (see the permission matrix in step 5).

**Review queue (`/review`) — persona: Content Manager/Editor, `mam-editors`**
- As the producer, first use **Submit for review** on an asset from its
  detail page (or the queue) to move it into the `MAM_EDITORIAL_APPROVAL`
  workflow — `editorialStatus` becomes `qc`.
- Sign out, then sign back in as `mam_editor1` / `Editor!2026`.
- Confirm the submitted asset now appears in **Review queue**, showing the
  correct step label (Quality Control / Editorial Approval).
- Test **Submit to Editorial** (advances QC → Editorial Approval),
  **Approve** (at the Editorial Approval step; `editorialStatus` becomes
  `approved`), **Reject** (requires a typed reason in the dialog;
  `editorialStatus` becomes `rejected`), and **Send back to draft**
  (cancels the workflow instance and resets `editorialStatus` to `draft`).
- Confirm each action shows a success/denied/error banner inline on the
  row, and the queue refreshes afterward.

**Archive (`/archive`) — persona: Media Archivist, `mam-archivists`**
- Only assets with `editorialStatus = approved` appear here by design —
  approve one via the Review Queue first if the list is empty.
- Filter by Programme/Bureau/Air date (client-side filters, applied to the
  current page) and by Story type/Archive tier (chip filters, server-side).
- **As `mam_archivist1`**: click **Archive** on a hot asset — confirm it
  succeeds and the row updates to show the `cold` tier with a **Restore**
  button. Click **Restore** — confirm it moves back to `hot`.
- **As `mam_editor1` or `mam_producer1`** (neither is in `mam-archivists`):
  confirm the Archive/Restore buttons render disabled with a lock icon and
  a tooltip explaining the required permission — this is a UX affordance
  only; the real enforcement is server-side (next step).
- **Server-enforced check (the important one):** even if a client-side
  check were bypassed, confirm the backend itself rejects the write. With
  `mam_editor1`'s credentials, attempt a direct PUT:
  ```powershell
  curl.exe -u mam_editor1:Editor!2026 -X PUT "http://localhost:8080/nuxeo/api/v1/id/<uid>" `
    -H "Content-Type: application/json" `
    -d "{\"entity-type\":\"document\",\"uid\":\"<uid>\",\"properties\":{\"broadcast:archiveState\":\"cold\"}}"
  ```
  This should return **HTTP 403** — `ArchiveStateGuardListener` rejects any
  caller who isn't Administrator or a member of `mam-archivists`,
  regardless of client. Then repeat with `mam_archivist1`'s credentials and
  confirm it succeeds (HTTP 200) and that `broadcast:archiveDate` /
  `broadcast:archivedBy` are now stamped on the document (`GET` it back and
  check).

**Editorial status server-enforced check (same idea, different field):**
`broadcast:editorialStatus` is guarded the same way by
`EditorialStatusGuardListener` (mam-security), added specifically to close
a real gap: previously any caller with `Write` could set this field to
`approved` directly, skipping the entire editorial review workflow. Verify
it's closed:
```powershell
# As mam_producer1, attempt to self-approve a draft asset directly:
curl.exe -u mam_producer1:Producer!2026 -X PUT "http://localhost:8080/nuxeo/api/v1/id/<uid>" `
  -H "Content-Type: application/json" `
  -d "{\"entity-type\":\"document\",\"uid\":\"<uid>\",\"properties\":{\"broadcast:editorialStatus\":\"approved\"}}"
```
This should return **HTTP 403** with a message naming the missing
permission (`MAM_Approve`), and the document's `editorialStatus` should
remain unchanged. Producers can still move `draft`→`qc` (they hold
`MAM_SubmitForReview`); only `mam-editors` can drive `approved`/`rejected`.
The real workflow (Submit for review → Review Queue's Submit to
Editorial/Approve/Reject, or the equivalent buttons on the Asset Detail
page) is unaffected — those write the same property, but only after the
workflow engine has already restricted the task to the correct
assignee/group, which by construction holds the matching permission.

**Settings (`/settings`)**
- Read-only page. Confirm it shows the correct Nuxeo base URL, REST root,
  named page provider, and mock-mode status matching your `.env.local`.

**Sign-out**
- Click **Sign out** in the top bar or sidebar footer. This clears the
  cached dev session (`localStorage`) and returns you to the Login Page
  immediately — no page reload needed. Sign back in as a different
  persona to test role boundaries without editing `.env.local` or
  restarting `npm run dev` at all (that env-var-swap workflow described
  above still works too, but is no longer required — signing out and back
  in with a different user's credentials is the faster path now).
- In a production build with real OIDC configured, the same button calls
  `auth.signoutRedirect()` and ends the actual IdP session instead.

### 5. Permission matrix reference

Use this to sanity-check what each test user should and shouldn't be able
to do (from `mam-security`'s role bundles):

| Action                        | `mam_producer1` | `mam_editor1` | `mam_archivist1` | `Administrator` |
|--------------------------------|:---:|:---:|:---:|:---:|
| Upload / create asset          | ✅ | ❌ | ❌ | ✅ |
| Edit metadata                  | ✅ | ❌ (Read only) | ❌ (Read only) | ✅ |
| Submit for review              | ✅ | ❌ | ❌ | ✅ |
| Approve / Reject (in queue)    | ❌ | ✅ | ❌ | ✅ |
| Archive / Restore               | ❌ | ❌ | ✅ | ✅ |

If any of these don't match — e.g. `mam_editor1` succeeds at archiving —
that's a real regression in `mam-security`, not a frontend bug; the
frontend's own `canArchive`/`canRestore` checks are UX-only, per
`archiveApi.ts`'s own comments.

### 6. Mock mode (no backend required)

To test the UI in isolation without any Nuxeo backend:

```
# .env.local
VITE_MOCK_MODE=true
```

Restart `npm run dev`. The app serves three canned documents from
`searchApi.ts`'s in-memory dataset. Upload, Review queue actions, and
Archive actions are **not** wired to the mock backend (those pages call
real endpoints directly) — mock mode is only useful for Dashboard/Assets/
Asset-detail browsing, not for testing the interactive workflows above.

### 7. Tearing down

```powershell
cd D:\MaM\mam-platform
docker compose -f compose.smoke.yaml down       # keeps volumes (data persists)
docker compose -f compose.smoke.yaml down -v    # also deletes all data — irreversible
```

## How the frontend talks to Nuxeo

- All API calls go through `src/api/nuxeoClient.ts`.
- Base URL: `${VITE_NUXEO_BASE_URL}/api/v1` (default `/nuxeo/api/v1`).
- No credentials, tokens, or CLIDs live in source. The dev-only Basic
  auth fields above are opt-in, empty by default, and never used by the
  production bundle unless the operator explicitly sets them at build
  time (which is not recommended — use an SSO reverse proxy instead).

### Verified endpoint

```
GET /api/v1/search/pp/MAM_BROADCAST_ASSET_SEARCH/execute
    ?q=&storyType=&editorialStatus=&archiveState=
    &currentPageIndex=&pageSize=
```

Wrapped by `searchAssets(...)` in `src/api/searchApi.ts`. Empty /
undefined filter parameters are dropped so Nuxeo's predicate whereClause
falls through cleanly.

## Development proxy

`vite.config.ts` proxies `/nuxeo/**` to `VITE_NUXEO_PROXY_TARGET`, which
defaults to the local Nuxeo smoke stack at `http://localhost:8080`.
To point the frontend at a different backend for a session:

```
VITE_NUXEO_PROXY_TARGET=http://localhost:18080 npm run dev
```

## Mock mode

Set `VITE_MOCK_MODE=true` in `.env.local` to run the UI against a small
in-memory dataset. The banner does not change; mock mode is transparent
to components. Useful when Nuxeo is not running. Off by default.

## Screens

- `/`         Dashboard: totals, per-status counts, recent assets.
- `/search`   Asset search: connects to `MAM_BROADCAST_ASSET_SEARCH`. All
              query state is stored in the URL so a result view is
              shareable.
- `/asset/:uid` Asset detail scaffold: reads the doc via `/api/v1/id/{uid}`
              with the `broadcast,dublincore,common` schemas materialized.

Every page renders explicit **loading**, **empty**, **no-results**, and
**error** states.

## Design tokens

Tokens are defined in `src/styles/tokens.css`. Components consume tokens
by name (`var(--space-4)`, `var(--color-accent)`, etc.); raw hex codes
never appear in component styles. If you need a new colour or spacing
step, add a token first.

## Security

- The project **must not** contain committed usernames, passwords,
  tokens, CLIDs, or API keys. Vite's `.env.local` is git-ignored on
  purpose. `.env.example` documents variable names only.
- `VITE_DEV_AUTH_*` is a convenience for local development against the
  smoke/integration stacks (e.g. `Administrator/Administrator`, or one of
  the persona test users created in "End-to-end testing" above). It only
  activates when OIDC is not configured, is off by default, and has no
  place in production. Production deployments should either configure
  real `VITE_OIDC_*` values, or terminate authentication at an SSO
  reverse proxy in front of `/nuxeo/**` and let the browser session carry
  the identity — the client sends no `Authorization` header of its own in
  that case.
- Any error message the backend returns is surfaced verbatim in the UI's
  `ErrorState` panel. Do not put secrets into Nuxeo error responses.

## Not in scope

- Task queues / workflow buttons (Editorial Approval).
- Direct ACP / permission editors.
- Uploads and rendition preview beyond the metadata view.

These are separate follow-ups; the current build is a search + browse
foundation.
