# MAM — Simple Getting Started Guide

A plain-language guide to running and using the MAM application. No deep
technical knowledge needed. Just follow the steps in order.

---

## What is this app? (Question 5)

**MAM** stands for **Media Asset Management**. Think of it as a private,
organized library for a newsroom's video and media files.

Instead of staff emailing huge video files around or losing them on random
shared drives, everything lives in one organized place where you can:

- **Upload** video and media files (news packages, interviews, raw footage).
- **Add information** to each file — what programme it's for, which bureau
  shot it, the story type, air date, rights/licensing details, and so on.
- **Search and filter** to find any clip quickly.
- **Route files through an approval process** — a producer submits a clip,
  an editor reviews and approves or rejects it.
- **Archive** old approved clips into "cold storage" to keep the active
  library tidy, and restore them later if needed.

### What makes it special

- **Built for broadcast newsrooms**, not a generic file store. It uses real
  newsroom language (programme, bureau, story type, air date, rights window).
- **Automatic video processing.** When you upload a video, the system
  automatically makes a smaller preview version and thumbnail images so you
  can watch/preview without downloading the huge original.
- **Approval workflow built in.** Content moves through Draft → Quality
  Check → Editorial Approval → Approved, with a clear record of who did what.
- **Roles and permissions.** Producers, editors, and archivists each see and
  do only what their job needs. These rules are enforced by the system, not
  just hidden in the screen — so they can't be worked around.
- **Real cold storage archiving.** When a clip is archived, the actual video
  file physically moves from hot storage to a separate cold bucket. When
  restored, it physically moves back — no data loss, zero copies left behind.
- **Runs on your own computers/servers.** No monthly cloud subscription
  required; the organization keeps full control of its media.

---

## The five roles (people who use it)

| Role | What they do |
|------|--------------|
| **Administrator** | The "super user." Can do everything, manage users. |
| **Producer** | Uploads clips, fills in details, submits them for review. |
| **Editor** | Reviews submitted clips and approves or rejects them. |
| **Archivist** | Moves approved clips to cold storage and restores them. |

---

## 1. How to run the application

The app has **two parts** that both need to be running:

1. **The backend stack** (Nuxeo engine + PostgreSQL + Elasticsearch + MinIO
   object storage — all start together with one command via Docker Compose).
2. **The frontend** (the website you click around in — a Vite dev server).

> **Before you begin:** Make sure Docker Desktop is running on your machine.

---

### Step 1 — Build the backend Docker image

> **First time only** (or after any code change to `mam-platform`).
> This takes 5–10 minutes. After the first build it is very fast on reruns
> because Docker caches the layers.

Open PowerShell and run:

```powershell
cd D:\MaM\mam-platform

docker build `
  -f Dockerfile.integration `
  -t mam-platform/nuxeo-integration:local `
  --build-arg PG_DB=mam_nuxeo `
  --build-arg PG_USER=mam_nuxeo `
  --build-arg PG_PASSWORD=mam_nuxeo_dev_only `
  --build-arg ES_INDEX_NAME=mam_nuxeo `
  --build-arg MINIO_ROOT_USER=mam_minio_admin `
  --build-arg MINIO_ROOT_PASSWORD=mam_minio_dev_only `
  --build-arg MAM_S3_BUCKET=mam-blobs `
  --build-arg MAM_S3_COLD_BUCKET=mam-blobs-cold `
  --build-arg MAM_SMOKE_JWT_SECRET=smoke-secret-for-dev-integration-testing-1234567890 `
  .
```

You should see `Successfully tagged mam-platform/nuxeo-integration:local` at
the end.

---

### Step 2 — Start the backend stack

```powershell
cd D:\MaM\mam-platform
docker compose --env-file .env.integration -f compose.integration.yaml up -d
```

This starts **five containers**:

| Container | Purpose | Port |
|---|---|---|
| `mam-integration-nuxeo` | Nuxeo content engine | 8081 |
| `mam-integration-postgres` | PostgreSQL 16 database | (internal) |
| `mam-integration-elasticsearch` | Full-text search | (internal) |
| `mam-integration-minio` | Object storage (hot + cold) | 9000 / 9001 |
| `mam-integration-minio-init` | Creates the MinIO buckets (exits after) | — |

Wait about **60–90 seconds** for Nuxeo to fully start, then verify:

```powershell
curl.exe -s http://127.0.0.1:8081/nuxeo/runningstatus
```

You should see:
```json
{"runtimeStatus":"ok","ldapDirectories":"ok","repositoryStatus":"ok","streamStatus":"ok"}
```

> **Tip:** You only need to run `up -d` once per work session. Nuxeo
> survives machine reboots — your data is safe in Docker volumes.

---

### Step 3 — Start the frontend

Open a **second** PowerShell window:

```powershell
cd D:\MaM\mam-web
npm run dev
```

You'll see:

```
  ➜  Local:   http://localhost:5173/
```

---

### Step 4 — Open it in your browser

Go to **http://localhost:5173**

You'll see a **Sign in** page — that means everything is working.

> **Important:** The frontend is configured to proxy API calls to the
> backend on port **8081**. If you see a "Could not reach the backend"
> error, confirm the backend containers are up and that you used
> `compose.integration.yaml`, **not** `compose.smoke.yaml`.

---

### Optional: View the MinIO storage console

Open **http://localhost:9001** in your browser.

- Username: `mam_minio_admin`
- Password: `mam_minio_dev_only`

Here you can see the two buckets:

| Bucket | Purpose |
|---|---|
| `mam-blobs` | **Hot storage** — active video files |
| `mam-blobs-cold` | **Cold storage** — archived video files |

When you archive an asset, you'll see its file disappear from `mam-blobs`
and appear in `mam-blobs-cold`. When you restore, it moves back.

---

### Stopping the app

```powershell
# Stop containers but KEEP all data (safe — use this normally)
docker compose --env-file .env.integration -f compose.integration.yaml down

# Stop AND delete all stored data (WARNING: irreversible)
docker compose --env-file .env.integration -f compose.integration.yaml down -v
```

---

## 2. How to create users

There is 1 default seeded administrator account ready to use immediately:

| Username | Password | Role | Notes |
|----------|----------|------|-------|
| `Administrator` | `Administrator` | Administrator | **Default account** (Full access, works out-of-the-box) |

> [!NOTE]
> Accounts like `mam_producer1`, `mam_editor1`, or `mam_archivist1` are custom persona accounts. If you want to use them, log in as `Administrator` first or create them in Nuxeo user management.

Just type **`Administrator`** / **`Administrator`** into the Sign in page to start.

### If you need to create MORE users

Right now there is **no "Add User" screen inside the app** — users are
created behind the scenes. The simplest way:

**Ask me (or run a short script) to create them**

Tell me the usernames and which role each should have, and I'll create them
in one step. Under the hood this uses the system's user API to make the
account and put it in the right group (`mam-producers`, `mam-editors`, or
`mam-archivists`) — the group is what decides what the person is allowed to
do.

> **Heads-up:** In this simple local test setup, the engine's own visual
> admin screen (the full "Nuxeo Web UI") is **not installed**, so there
> isn't a click-through user-management page available here. User management
> is done via the API for now.

---

## 3. What you can do as an administrator

An **Administrator** account can do everything a producer, editor, and
archivist can do, all in one login — plus behind-the-scenes management like
creating users and assigning roles.

In this simple local test setup, there is **no separate visual admin
dashboard** (the engine's full admin UI isn't installed here). So as an
administrator you have two things available:

1. **Our own app** at **http://localhost:5173** — sign in as `Administrator`
   and you can upload, review, approve, archive, and search everything,
   because an admin bypasses all the role restrictions.
2. **Behind-the-scenes management** (creating users, assigning roles,
   rebuilding the search index) — done via the system API. Ask me to run
   these for you, or see section 2 for user creation.

> In a full production deployment, a richer visual admin dashboard can be
> added. For local testing, the app itself plus the occasional script covers
> everything you need.

---

## 4. Where is everything stored?

Everything you upload and enter is saved **on your own machine**, inside
Docker-managed volumes and MinIO object storage. Nothing goes to the public
internet or a third-party cloud in this local setup.

| What | Where it lives | Plain meaning |
|------|----------------|----------------|
| The actual video / media files | MinIO `mam-blobs` bucket | Hot storage — active, playable files |
| Archived video files | MinIO `mam-blobs-cold` bucket | Cold storage — moved here when archived |
| Document metadata (title, programme, status…) | PostgreSQL database | The "index card" details for each file |
| Full-text search index | Elasticsearch | Powers the search/filter UI |
| Logs | `mam-integration-nuxeo-logs` Docker volume | Diagnostic records |

Key points:

- **Your data survives restarts.** Stopping or restarting Docker does **not**
  delete anything — data lives in named volumes and MinIO's bucket storage.
- **Data is only wiped with `down -v`** (the `-v` flag). Plain `down` stops
  the app but keeps all data.
- **Archive is real, not just a flag.** When you archive a clip, the video
  file physically moves from `mam-blobs` → `mam-blobs-cold`. When you
  restore it, it physically moves back. You can verify this live in the
  MinIO console at `http://localhost:9001`.
- **In production** (on the HP ProLiant servers), the hot and cold MinIO
  instances will run on separate physical machines: 600 GB SAS for hot,
  48 TB SAS (8 TB × 6) for cold. Just update the endpoint IPs in
  `.env.integration` — no code changes needed.

---

## 5. A complete end-to-end test (try the whole thing)

This walks one clip through the entire newsroom process. Sign out and back
in between roles using the **Sign out** button in the top-right.

**As a Producer** (`mam_producer1` / `Producer!2026`)

1. Open **http://localhost:5173** and sign in.
2. Click **Upload media** in the left menu.
3. Drag in a video file, give it a **Title**, fill in details like Programme
   and Story type, then click **Upload asset**.
   > Note: After uploading, Nuxeo runs FFmpeg in the background to create a
   > preview proxy and thumbnail. Wait ~30 seconds before the thumbnail
   > appears — this is normal on local CPU.
4. You'll see the clip's detail page. Click **Submit for review**.

**As an Editor** (`mam_editor1` / `Editor!2026`)

5. Sign out, sign back in as the editor.
6. Click **Review queue** — your submitted clip is waiting there.
7. Review it, then **Approve** (or **Reject** with a reason).

**As an Archivist** (`mam_archivist1` / `Archivist!2026`)

8. Sign out, sign back in as the archivist.
9. Click **Archive** — only approved clips appear here.
10. Click **Archive** on the clip.
    - A cold-storage banner appears on the asset detail page.
    - The download button is disabled (file is in cold storage).
    - In the MinIO console (`http://localhost:9001`), you can see the file
      appear in `mam-blobs-cold` and disappear from `mam-blobs`.
11. Click **Restore** to bring the clip back to hot storage.
    - The button shows **Restoring…** while the background job runs.
    - After a few seconds the banner clears and download re-enables.
    - In the MinIO console, the file is back in `mam-blobs`.

**Check search (any user)**

12. Click **Assets** to see all clips. Use the filter chips (story type,
    status, storage tier) to narrow the list.

That's the full lifecycle: **upload → review → approve → archive → restore**.

---

## Quick troubleshooting

| Problem | Fix |
|---------|-----|
| Login says "Could not reach the backend" | Backend isn't running, or you're on the wrong stack. Run `docker compose --env-file .env.integration -f compose.integration.yaml up -d` and wait for Nuxeo to be healthy (`curl.exe http://127.0.0.1:8081/nuxeo/runningstatus`). |
| Sign in says "Invalid credentials" | Wrong username/password. Use one from the table in section 2. |
| A button is greyed out with a lock icon | Your current role isn't allowed to do that. Sign in as the right role. |
| Thumbnail shows a broken image after upload | FFmpeg is still processing. Wait 20–30 seconds and refresh the page — this is normal on local CPU. |
| Archive gives a 500 error | Make sure you're using the **integration stack** (port 8081), not the smoke stack (port 8080). The smoke stack has no MinIO and archive won't work. |
| MinIO console shows nothing in `mam-blobs` | You're uploading via the smoke stack. Switch to the integration stack (`compose.integration.yaml`). |
| Everything seems broken | Restart both parts: backend (`docker compose --env-file .env.integration -f compose.integration.yaml up -d`) and frontend (`npm run dev`). |
| Need to rebuild after a code change | Run the `docker build ...` command from Step 1 again, then `docker compose ... up -d --force-recreate nuxeo`. |

---

*For the deeper technical version of all this, see `mam-web/README.md`
(section "End-to-end testing") and the other documents in this `docs/`
folder.*

