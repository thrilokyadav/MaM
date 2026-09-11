# MAM — Production Readiness & Storage Concept

Plain-language answers to two questions:
1. What's ready for production, and what isn't?
2. Where does everything actually get saved — originals, proxies,
   thumbnails, and archived files?

---

## Part 1 — What's ready, what's not

### ✅ Ready for production

| Area | Status |
|------|--------|
| **Core media workflow** | Upload, metadata, preview, search, review/approve, archive/restore all work. |
| **Video processing** | Automatic proxy (preview) + thumbnail + storyboard generation on upload. |
| **Real login (OIDC/SSO)** | Production sign-in via your company's identity provider (Keycloak, Auth0, Azure AD, etc.). Fully wired. |
| **Role-based permissions** | Producer / Editor / Archivist / Publisher roles, enforced by the server (not just hidden in the UI). |
| **Editorial approval governance** | The review status of a clip (draft → QC → editorial → approved/rejected) can now **only** move forward through the real approval steps, enforced by the server. A producer cannot skip review and self-approve their own upload — closed as of this update (see "Recently closed" below). |
| **Manage Users screen** | Administrators can create, list, and remove users and assign roles directly in the app — no scripts or separate admin panel needed. |
| **Secure transport** | HTTPS/TLS termination via Nginx, security headers, HTTP→HTTPS redirect. |
| **Proper database** | PostgreSQL 16 for all metadata. |
| **Real search engine** | Elasticsearch 8 for full-text and faceted search. |
| **Object storage for media** | S3-compatible storage (MinIO out of the box, or real AWS S3). |
| **Backups** | Scripts to back up the database + search index, with scheduling instructions. |
| **Deployment** | One-command Docker Compose stack for the whole system. |

### 🔒 Recently closed: editorial status governance gap

An earlier version of this platform let anyone with basic edit access set
a clip's review status directly (e.g. jump straight to "approved" without
an editor ever reviewing it) — the same way `archiveState` used to be
unprotected before the archive guard was added. This has now been fixed
with a matching server-side guard: changing a clip's editorial status now
requires the *specific* permission for that step (submit, approve, or
reject), checked by the server on every request — not just hidden behind
a disabled button in the interface. A producer can no longer approve their
own submission by any means, including calling the API directly. The real
approval workflow (Submit → QC → Editorial Approval → Approved/Rejected)
is unaffected and continues to work exactly as before.

### ⚠️ Needs attention before / soon after go-live

| Area | Status | What to do |
|------|--------|------------|
| **Physical cold-storage tiering** | **Partially done.** Archiving currently *marks* a file as "cold" and records who/when, but does **not yet physically move the file's bytes** to the cheaper cold bucket. See Part 2 for the full explanation — this is the most important gap to understand. | Install the cold-storage add-on package (the configuration is already wired; the package just isn't bundled yet). |
| **Search high availability** | Elasticsearch runs as a **single node** — fine for launch, but no automatic failover. | Plan a multi-node cluster before treating search as mission-critical. |
| **Media file backups** | The backup scripts cover the database + search index, but **not** the media files themselves. | Rely on the object storage's own replication/versioning, or snapshot that storage separately. |
| **Redis** | Installed and running but **not yet used** by any feature. | Harmless; reserved for future caching. |
| **Secrets/passwords** | The example config has blank placeholders. | Generate real strong secrets before deploying (the deployment guide shows how). |

### The honest one-line summary

**The application itself is production-ready.** The one concept you must
understand before promising "cold storage saves money" to anyone is that
**archiving today is a label + audit record, not yet a physical byte-move
to cheaper storage.** That final piece is a package install away, and the
plumbing for it is already in place. Details below.

---

## Part 2 — Where does everything get saved? (The storage concept)

This is the heart of a Media Asset Management system, so here it is in
full, in plain terms.

### The two kinds of storage

Think of it like your own office:

- **A database** = the filing cabinet of **index cards**. Small text
  records: this clip's title, programme, bureau, story type, status, who
  approved it, when it was archived. **Never** the video itself.
- **Object storage (S3 / MinIO)** = the **warehouse** where the actual big
  video files physically sit.

Metadata (index cards) → **PostgreSQL database.**
Actual media bytes (the heavy files) → **S3/MinIO object storage.**

### What happens when a producer uploads one video

Say a producer uploads `evening-news.mp4`. Here's every file that gets
created and where each one lands:

| # | File created | Where it's saved | Why |
|---|--------------|------------------|-----|
| 1 | **The original** `evening-news.mp4` (full quality, large) | Object storage — **hot** bucket (`mam-blobs`) | The master copy. |
| 2 | **A proxy** (smaller, web-friendly preview version) | Object storage — **hot** bucket | So people can watch/scrub in the browser without downloading gigabytes. |
| 3 | **A thumbnail / poster image** | Object storage — **hot** bucket | The little preview picture you see in lists. |
| 4 | **A storyboard** (strip of tiny frames along the timeline) | Object storage — **hot** bucket | Lets you hover-scrub the video. |
| 5 | **The index card** (title, programme, status, etc.) | PostgreSQL database | The searchable details. |
| 6 | **A search entry** | Elasticsearch | So the clip shows up in search/filters. |

Items 2, 3, and 4 are **generated automatically** by the system (using
FFmpeg) right after upload. The producer doesn't do anything — they just
upload the original and the previews appear a minute or two later.

**All of these live in the "hot" bucket** — fast, immediately accessible
storage — because the clip is active and people are working with it.

### "Hot" vs "Cold" — the classification you asked about

The whole point of tiering is **cost**. Fast storage is expensive; slow
"cold" storage (like AWS Glacier) is cheap. Old clips nobody watches
anymore don't need to sit on expensive fast storage.

| Tier | Bucket | Meaning | Speed | Cost |
|------|--------|---------|-------|------|
| **Hot** | `mam-blobs` | Active clips people use daily | Instant | $$$ |
| **Cold** | `mam-blobs-cold` | Old, approved clips kept for the record | Slow to retrieve | $ |

An **Archivist** decides an old approved clip isn't needed day-to-day and
clicks **Archive**. The intent: move that clip's heavy files from the
expensive hot warehouse to the cheap cold warehouse. Later, if someone
needs it again, the archivist clicks **Restore** to bring it back.

### ⚠️ The important truth about archiving today

Here is exactly what happens **right now** when you click **Archive**:

- ✅ The clip is **labelled** `archiveState = cold`.
- ✅ An **audit record** is stamped: who archived it (`archivedBy`) and
  when (`archiveDate`). Restoring stamps `restoredBy` / `restoreDate`.
- ✅ This is **strictly enforced** — only archivists/administrators can do
  it, verified by the server, not bypassable.
- ❌ The actual video bytes **do NOT physically move** to the cold bucket
  yet. They stay in the hot bucket.

So today, archiving gives you **governance and an audit trail** (a
defensible record of who moved what to "cold" and when) — but **not yet
the cost saving**, because the bytes haven't actually relocated to cheap
storage.

### Why, and how to finish it

The cold bucket (`mam-blobs-cold`) is already created, and all the
configuration pointing at it is already in place in the production setup.
The one missing piece is a specific add-on package (Nuxeo's
"cold-storage" package) that does the actual byte-moving. It isn't bundled
yet because it lives in a separate repository and needs an extra build
step. **Once that package is installed, clicking Archive will physically
move the bytes to the cold bucket with no other change needed** — the
wiring is already waiting for it.

### Simple diagram of the whole thing

```
                      UPLOAD
                        │
     ┌──────────────────┼───────────────────────┐
     ▼                  ▼                         ▼
  Original          Proxy + Thumbnail          Index card
  (master)          + Storyboard               (title, status…)
     │                  │                         │
     ▼                  ▼                         ▼
  ┌──────────────────────────────┐        ┌──────────────┐
  │  OBJECT STORAGE — HOT bucket  │        │  PostgreSQL   │
  │  (mam-blobs)                  │        │  (metadata)   │
  └──────────────────────────────┘        └──────────────┘
                        │                         │
                        │                         ▼
                        │                  ┌──────────────┐
                        │                  │ Elasticsearch │
                        │                  │  (search)     │
                        │                  └──────────────┘
                        │
              Archivist clicks "Archive"
                        │
      ┌─────────────────┴──────────────────┐
      ▼                                     ▼
  TODAY:                              ONCE COLD-STORAGE
  label = cold                       PACKAGE INSTALLED:
  + audit stamp                      bytes physically move to
  (bytes stay in hot)                HOT ──▶ COLD bucket
                                     (mam-blobs-cold)
```

---

## Part 3 — Quick answer: "Is storage classified correctly?"

- **Metadata vs media are correctly separated** (database vs object
  storage). ✅
- **Hot vs cold buckets both exist and are wired** (`mam-blobs`,
  `mam-blobs-cold`). ✅
- **The archive action correctly classifies and audits** which tier a clip
  belongs to. ✅
- **The physical byte-move to cold is the one remaining step** (install the
  cold-storage package). ⚠️

If your goal is to *test the full concept end-to-end including real
byte-movement*, that package needs to be added first. If your goal is to
test the *workflow, classification, and audit trail*, that all works today.

---

*Technical deployment steps live in `deploy/README-DEPLOYMENT.md`.
Operational runbooks live in `docs/ADMIN_GUIDE.md`.*
