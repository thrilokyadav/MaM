# MAM Platform — Production Go-Live Checklist

A step-by-step checklist for deploying the MAM platform onto the two
refurbished HP ProLiant DL380 G9 servers. Work top to bottom; the
**BLOCKER** items must all be done before the platform is usable, the
**RECOMMENDED** items should be done before you rely on it, and the
**OPTIONAL** items are tuning you can revisit later.

This complements `README-DEPLOYMENT.md` (the full reference). This file is
the condensed, hardware-specific "do these in order" list.

---

## 0. Target hardware & role split

You have two machines. Use them as a **compute node** and a **storage
node** — do not run everything on one.

| | Server 1 — COMPUTE | Server 2 — STORAGE |
|---|---|---|
| Model | HP ProLiant DL380 G9 | HP ProLiant DL380 G9 |
| CPU | 2× Xeon 2.4 GHz | 2× Xeon 2.4 GHz |
| RAM | 128 GB DDR4 | 128 GB DDR4 |
| OS disk | 2× 256 GB SSD (RAID 1) | 2× 256 GB SSD (RAID 1) |
| Data disk | 1× 600 GB SAS | 6× 8 TB SAS 10K = 48 TB raw |
| Runs | Nuxeo, PostgreSQL, Elasticsearch, Redis, Nginx, mam-web | MinIO (all media: hot + cold buckets) |

Rationale: Nuxeo + Postgres + Elasticsearch are CPU/RAM-bound and fit
comfortably in the compute node's 128 GB. The 48 TB of SAS spindles is
purpose-built to be the object store. Keeping media I/O on its own box
means a big archive/restore or transcode burst never starves the database
or search.

**Network:** put a dedicated link (ideally 10 GbE) between the two nodes.
All media bytes — uploads landing in MinIO, transcode reads, archive/
restore copies between hot and cold — cross this link. Gigabit works;
10 GbE makes large-file operations dramatically faster. See §6.

---

## 1. BLOCKER — must be done before anyone can log in

### 1.1 Provision the storage node's MinIO with erasure coding

Do **not** run the 6× 8 TB drives as a single JBOD pool — one disk failure
would lose data. Run MinIO in **erasure-coding** mode across all six
drives so it survives drive failures.

- Mount each of the 6 drives on the storage node (e.g. `/mnt/disk1` …
  `/mnt/disk6`), each its own filesystem (XFS recommended), **not** a
  hardware-RAID volume — MinIO does its own erasure coding and should see
  raw individual drives.
- Point MinIO at all six: the server command becomes
  `minio server http://<storage-host>/mnt/disk{1...6}/minio`.
- With 6 drives, MinIO uses EC:2 or EC:3 parity by default → **~32 TB
  usable** (survives 2–3 drive failures). This is the right trade for
  broadcast media; do not disable it to reclaim the space.
- The bundled `docker-compose.prod.yml` runs a **single-volume** MinIO
  (fine for a pilot). For the real 6-drive erasure setup you either:
  (a) run MinIO directly on the storage node (systemd service) pointed at
  the 6 mounts, and point Nuxeo at it via `nuxeo.s3storage.endpoint`, or
  (b) adapt the `minio` service in the compose file to mount all six drives
  and use the `server .../disk{1...6}/...` command form.
  Option (a) is cleaner for a two-box split — MinIO on the storage node,
  everything else via compose on the compute node.

> Both the **hot** (`mam-blobs`) and **cold** (`mam-blobs-cold`) buckets
> live in this same 48 TB pool. See §4 for what hot/cold actually does.

### 1.2 Fill in the production `.env`

```bash
cd deploy
cp .env.prod.example .env
```

Set every **REQUIRED** value (all blank in the template):

- [ ] `PG_PASSWORD` — `openssl rand -base64 24`
- [ ] `ELASTIC_PASSWORD` — `openssl rand -base64 24`
- [ ] `REDIS_PASSWORD` — `openssl rand -base64 24`
- [ ] `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` — real generated secret (≥ 8 chars)
- [ ] `MAM_DOMAIN` — the public hostname
- [ ] `MAM_VERSION` — bump on every new build so `up -d` uses the new image

Never commit `.env` (already git-ignored).

### 1.3 Configure the OIDC identity provider (REQUIRED — no login without it)

Production auth is **JWT/OIDC only** (Basic auth is disabled in the prod
image; the dev login you tested locally does not exist here). You must
have a real IdP (Keycloak, Azure AD / Entra ID, Okta, Auth0, etc.).

- [ ] Register the `mam-web` SPA as a **public client** (Authorization Code
      + PKCE, no client secret).
- [ ] Register the redirect URI `https://<MAM_DOMAIN>/auth/callback`
      **exactly** (scheme, host, path).
- [ ] Ensure the IdP emits a **groups/roles claim** whose values include
      `mam-producers`, `mam-editors`, `mam-archivists`, `mam-publishers`,
      and `administrators` (or map them — see next box).
- [ ] Fill in `.env`:
  - `OIDC_ISSUER` — the IdP authority URL
  - `OIDC_CLIENT_ID` — the registered client id (also the token `aud`)
  - `OIDC_JWKS_URL` — usually `<issuer>/.well-known/jwks.json`
  - `OIDC_GROUPS_CLAIM` — the claim carrying group membership (default `groups`)
- [ ] If your IdP names groups differently, edit the
      `mam.jwt.group.map.*` properties in `deploy/nuxeo/Dockerfile.prod`
      (left side = MAM group, right side = your IdP's value).

> **Break-glass:** the local `Administrator` account still works via
> `FORM_AUTH` at `https://<MAM_DOMAIN>/nuxeo/login.jsp` for recovery when
> the IdP is unreachable. Change its password immediately (§1.5).

### 1.4 TLS certificate

- [ ] Place the cert chain and key at:
  - `deploy/nginx/certs/fullchain.pem` (leaf + intermediates, in order)
  - `deploy/nginx/certs/privkey.pem`
- [ ] Let's Encrypt path: see README-DEPLOYMENT.md §3 Option A.
- [ ] Corporate cert path: README-DEPLOYMENT.md §3 Option B.

### 1.5 First boot & change the default admin password

```bash
cd deploy
docker compose -f docker-compose.prod.yml --env-file .env config   # validate
docker compose -f docker-compose.prod.yml --env-file .env up -d
docker compose -f docker-compose.prod.yml --env-file .env logs -f nuxeo   # 2–5 min first boot
```

- [ ] Confirm all services healthy: `docker compose ... ps`
- [ ] Log in as `Administrator` / `Administrator` at
      `https://<MAM_DOMAIN>/nuxeo/login.jsp` and **change the password
      immediately** (Admin Center → Users & Groups → Administrator →
      Change Password).
- [ ] Confirm the OIDC login (the path real users use) works end to end.

---

## 2. BLOCKER — verify core functions before handing over

Do a quick smoke test as real roles (not just Administrator):

- [ ] **Producer** can upload a video; it processes and shows an MP4
      proxy + thumbnail within a couple of minutes.
- [ ] **Producer** can "Submit for review" (button enabled, not greyed).
- [ ] **Editor** sees the item in the Review Queue and can Approve/Reject.
- [ ] **Search** finds assets by title, slug, programme, bureau, story type.
- [ ] **Archivist** can Archive an approved asset → state goes to
      "Archiving…" then "Cold"; the master blob physically moves to the
      `mam-blobs-cold` bucket (verify in MinIO console); the asset still
      shows its thumbnail/proxy.
- [ ] **Restore** moves it back to Hot.
- [ ] Creating an asset pre-set to `approved` as a non-admin is **rejected**
      (403) — confirms the workflow can't be bypassed.

---

## 3. RECOMMENDED — data protection & maintenance

### 3.1 Schedule PostgreSQL + Elasticsearch backups

The backup script already exists (`deploy/scripts/backup.sh`). Add cron on
the compute node:

```cron
# Daily DB + ES snapshot at 02:00
0 2 * * *  cd /path/to/deploy/scripts && ./backup.sh /mnt/backups/mam >> /var/log/mam-backup.log 2>&1
# Prune backups older than 30 days, Sundays 03:00
0 3 * * 0  find /mnt/backups/mam -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
```

- [ ] Cron installed and first run verified (check the log + the timestamped
      backup dir).
- [ ] **MinIO media is NOT covered by this script** (by design — bulk media
      has different backup economics). Protect it at the storage layer:
      enable MinIO bucket **versioning**, and/or snapshot the drives, and/or
      replicate the buckets to a second location. Decide and implement this.

### 3.2 Orphaned-blob garbage collection (already built-in)

Deleting an asset in the app removes its metadata but not immediately its
blob (blobs are deduplicated/shared). The platform now runs an automatic
**orphaned-binary GC** that reclaims that space.

- Default: **weekly, Sunday 03:00** server time. Runs as a background job;
  safe with concurrent uploads.
- Tunable via `nuxeo.conf` properties (no code change):
  - `mam.binaries.gc.cron` — Quartz cron, e.g. `0 0 3 ? * SUN`
  - `mam.binaries.gc.enabled` — `true` / `false`
  To change these in production, add them to a ConfigurationService XML
  fragment under `nxserver/config/` (same mechanism as the CSRF/JWT
  fragments in `Dockerfile.prod`), or append to the container's nuxeo.conf.
- On-demand run anytime: Admin Center → **"Garbage collect orphaned
  binaries"**, or fire the `mamBinariesGarbageCollect` event.
- [ ] Confirm the weekly schedule fits your maintenance window (bump to
      daily if you delete/churn a lot of media).

### 3.3 Confirm crash-recovery reconciler

The platform auto-reconciles any asset left stuck in `archive-pending` /
`restore-pending` after an unclean shutdown, on the next boot (it re-checks
the physical blob location and finalizes the state). Nothing to configure —
just be aware it exists if you ever see an asset briefly "Archiving…" after
a hard restart; it self-heals.

---

## 4. How hot/cold storage works (so you can explain it)

- **Hot** (`mam-blobs`): originals + MP4 proxies + thumbnails. Instantly
  available.
- **Cold** (`mam-blobs-cold`): when an archivist archives an approved
  asset, the heavy **master** blob is physically copied hot → cold, then
  deleted from hot. Proxies and thumbnails **stay hot**, so archived
  assets remain searchable and previewable. Restore reverses it.
- The move is **content-addressable and dedup-safe**: if two assets share
  the same file, the shared blob is only deleted from a tier when no other
  asset still needs it there. No data loss.
- Today both buckets sit on the same 48 TB pool, so archiving is about
  **operational separation and future flexibility**, not immediate disk
  savings. When you later want cold on genuinely cheaper/remote storage
  (e.g. AWS S3 Glacier), point `nuxeo.coldstorage.endpoint` at it — no app
  change.

---

## 5. Future capacity — adding disks

MinIO does **not** grow an existing erasure set by adding one disk. To add
capacity you add a **new server pool** (a new set of drives):

- Add the new drives to the storage node, mount them
  (e.g. `/mnt/disk7 … /mnt/diskN`).
- Extend the MinIO server command with the new pool, e.g.
  `minio server http://host/mnt/disk{1...6}/minio http://host/mnt/disk{7...12}/minio`.
- Restart MinIO. It spreads **new** writes across pools; existing data
  stays where it is.
- Prefer adding drives in **matching groups** (same size/count as the first
  pool) for balanced erasure coding.

This is a planned ops procedure (config + restart), not a hot-plug GUI
action, but it requires **no application/database change**.

- [ ] Document your chosen expansion plan (how many drives per future pool)
      so whoever adds capacity later follows the pool model, not a JBOD add.

---

## 6. Performance expectations & tuning

On this hardware, for newsroom-scale usage:

- **Search:** sub-second (Elasticsearch on 128 GB RAM).
- **UI:** fast — serve the **production build** (the compose `mam-web-build`
  container already does `npm run build`; do not run the Vite dev server in
  production).
- **Upload:** limited by the network, not the servers. Over the LAN a few
  hundred MB is seconds. (The multi-minute uploads seen in local dev were
  the dev machine's network, not the platform.)
- **Proxy/thumbnail:** MP4/H.264, generated async in seconds-to-minutes;
  never blocks the UI. Dual Xeon handles concurrent transcodes.
- **Archive/restore:** bounded by the compute↔storage link bandwidth.

Tuning levers already exposed in `.env`:

- [ ] `NUXEO_JVM_ARGS` — default `-Xms4096m -Xmx8192m`. With 128 GB on the
      compute node you can raise the max heap (e.g. `-Xmx16384m`) if you see
      GC pressure under load; leave plenty for the OS page cache.
- [ ] `ES_JAVA_OPTS` — default `-Xms2g -Xmx2g`. Raise for large libraries,
      but **never above half** the container's RAM.
- [ ] **10 GbE between the two nodes** — the single biggest lever for
      large-file (upload/archive/restore/transcode) throughput.

---

## 7. Elasticsearch HA note (before DR-critical reliance)

The default is a **single-node** Elasticsearch. It's fine to launch with,
and it's fully rebuildable from PostgreSQL (Admin Center → "Reindex all
documents"). But it is a single point of failure for search availability.

- [ ] For real HA, plan to run Elasticsearch as a multi-node cluster (or a
      managed OpenSearch/Elasticsearch service) — a hostname/URL change in
      the config, not a re-architecture. Not required for launch; required
      before you depend on search staying up through a node failure.

---

## 8. Final pre-handover sign-off

- [ ] All §1 BLOCKER items complete.
- [ ] §2 role-based smoke test passes.
- [ ] Backups scheduled and first run verified (§3.1).
- [ ] MinIO media durability strategy chosen and implemented (§3.1).
- [ ] Default `Administrator` password changed; OIDC login confirmed.
- [ ] Someone on the team knows the §5 disk-expansion procedure and the
      §3.2 GC / §3.3 reconciler behavior.

Once these are ticked, the platform is production-ready on your two
servers.
