# MAM Platform — Production Deployment Guide

This directory (`D:\MaM\deploy\`) is a turnkey production deployment
package for the MAM platform: Nuxeo application server + mam-platform
addon, PostgreSQL, Elasticsearch, Redis, MinIO (S3-compatible storage),
the mam-web SPA, and an Nginx reverse proxy — all orchestrated by a single
Docker Compose file.

Aligned with the Technical Architecture Document (sections 2.3.4 Reverse
Proxy, 2.5.2 Hardware & Capacity Baselines, 2.9.3 Backup & Disaster
Recovery, 2.10.1/2.10.3 JVM tuning) and the Nuxeo Implementation Plan
(Section 5, Deployment).

**Scope note:** this package builds its own Nuxeo image from the
`mam-platform` addon source and the `mam-web` frontend source, both of
which live in this same workspace (`D:\MaM\mam-platform`,
`D:\MaM\mam-web`) — but this guide and every file under `deploy/` only
*read* from those directories at build time; nothing here modifies them.
`D:\MaM\nuxeo` is never touched, referenced as a build context, or
required at deploy time (the mam-platform addon package and vendored
Nuxeo marketplace packages are already built artifacts by this point —
see `mam-platform/README.md` if you need to rebuild them from source).

---

## 1. Prerequisites

### Software

- **Docker Engine** 24.0+ and **Docker Compose** v2 (the `docker compose`
  subcommand, not the standalone `docker-compose` v1 binary).
- A domain name pointed at this host, if using a public TLS certificate
  (Let's Encrypt) — see [SSL/TLS Setup](#3-ssltls-setup).
- `openssl` (for generating secrets) and a POSIX shell (Bash) to run the
  backup/restore scripts. On Windows, use WSL, Git Bash, or run the
  scripts from a Linux jump host / CI runner instead.

### Hardware (per Technical Architecture Document 2.5.2)

Minimum baseline for a single-host production deployment at moderate
newsroom scale (concurrent editorial + archive traffic, not a broadcast
peak-load benchmark):

| Component                          | vCPU | RAM     | Disk                                   |
|-------------------------------------|------|---------|-----------------------------------------|
| Nuxeo application tier              | 4    | 16 GB   | 50 GB (logs, temp, local cache)         |
| PostgreSQL                          | 2    | 4 GB    | 100 GB+ (grows with document count)     |
| Elasticsearch (single-node baseline)| 2    | 4 GB    | 100 GB+ (grows with document count)     |
| Redis                               | 1    | 1 GB    | 5 GB                                    |
| MinIO / object storage              | 2    | 4 GB    | **Sized to your media library.** Broadcast masters and archives dominate storage; provision separately from the above, on its own volume/disk. |
| Nginx                               | 1    | 512 MB  | 5 GB (logs)                             |

If running everything on one host (as this compose file does by
default), total the above: **≥ 12 vCPU / ≥ 26 GB RAM** for the
application/database/cache tiers, plus however much disk your media
library needs for MinIO. For anything beyond a pilot/single-newsroom
deployment, split PostgreSQL, Elasticsearch, and MinIO onto separate
hosts (or managed services) and adjust `docker-compose.prod.yml`'s
service hostnames accordingly — the compose file's structure makes this
a hostname change, not a re-architecture.

---

## 2. Quick Start

```bash
cd D:\MaM\deploy

# 1. Copy and fill in the environment file. See the file itself for what
#    every variable does; the REQUIRED ones (empty by default) are
#    PG_PASSWORD, ELASTIC_PASSWORD, REDIS_PASSWORD, MINIO_ROOT_PASSWORD,
#    and the OIDC_* settings for your identity provider.
cp .env.prod.example .env
# Generate strong secrets, e.g.:
openssl rand -base64 24   # run once per REQUIRED password, paste into .env

# 2. Place TLS certificates (see SSL/TLS Setup below) at:
#    nginx/certs/fullchain.pem
#    nginx/certs/privkey.pem

# 3. Validate the compose file resolves cleanly against your .env
#    (catches missing/typo'd variables before anything starts):
docker compose -f docker-compose.prod.yml --env-file .env config

# 4. Build and start everything, in dependency order:
docker compose -f docker-compose.prod.yml --env-file .env up -d

# 5. Watch startup (Nuxeo's first boot — schema init, package
#    installation — can take 2-5 minutes):
docker compose -f docker-compose.prod.yml --env-file .env logs -f nuxeo

# 6. Once nuxeo reports healthy:
docker compose -f docker-compose.prod.yml --env-file .env ps
```

Open `https://<MAM_DOMAIN>/` in a browser. mam-web loads and, once you
sign in through your configured OIDC provider, you should reach the
dashboard.

### First login / initial administrator

On a fresh database, Nuxeo seeds a default `Administrator` / `Administrator`
account. **Change this password immediately after first boot** — this
package deliberately never bakes a fixed admin password into the image
(that would mean every deployment shipped the same credential).

Since `BASIC_AUTH` is disabled in this production image
(`production/basic-auth-disable-config.xml`), the only way to reach the
Nuxeo Web UI login screen is via `FORM_AUTH`, which remains enabled:

1. Browse to `https://<MAM_DOMAIN>/nuxeo/login.jsp` and sign in as
   `Administrator` / `Administrator`.
2. Open **Admin Center → Users and Groups**, select `Administrator`,
   go to the **Change Password** tab, and set a strong password.
3. Confirm the OIDC login path (the one end users actually use) also
   works before relying on it — see [Troubleshooting](#5-troubleshooting)
   if it does not.

In production, prefer signing in through your OIDC provider entirely for
day-to-day administration and reserving the local `Administrator`
account for break-glass recovery only (e.g. if the IdP is unreachable).

### Stopping / tearing down

```bash
# Stop everything, keep all data volumes:
docker compose -f docker-compose.prod.yml --env-file .env down

# Full reset (DESTROYS all data — Postgres, Elasticsearch, MinIO, Nuxeo
# working data). Only ever do this against a deployment you have already
# backed up and intend to discard:
docker compose -f docker-compose.prod.yml --env-file .env down -v
```

---

## 3. SSL/TLS Setup

`nginx/nginx.conf` expects a certificate and private key at:

```
nginx/certs/fullchain.pem
nginx/certs/privkey.pem
```

These are bind-mounted read-only into the nginx container — nothing in
this package ever needs to see or handle raw key material beyond that
mount, and `.gitignore` already excludes `nginx/certs/*` from version
control.

### Option A — Let's Encrypt (Certbot)

Run Certbot on the **host** (not inside the compose stack) using the
webroot method, since `nginx.conf` already serves
`/.well-known/acme-challenge/` from `nginx/certbot-www/`:

```bash
# One-time certificate issuance (host must already resolve MAM_DOMAIN
# and have port 80 reachable from the internet for HTTP-01 validation):
sudo certbot certonly --webroot -w ./nginx/certbot-www -d <MAM_DOMAIN>

# Copy (or symlink) the issued certificate into this package's expected
# location:
sudo cp /etc/letsencrypt/live/<MAM_DOMAIN>/fullchain.pem nginx/certs/fullchain.pem
sudo cp /etc/letsencrypt/live/<MAM_DOMAIN>/privkey.pem   nginx/certs/privkey.pem

# Reload nginx to pick up the new certificate:
docker compose -f docker-compose.prod.yml --env-file .env exec nginx nginx -s reload
```

Automate renewal with a cron entry that re-copies the certificate and
reloads nginx (Certbot renews automatically via its own systemd
timer/cron on most distros; only the copy+reload step above is
MAM-specific):

```cron
0 3 * * * certbot renew --webroot -w /path/to/deploy/nginx/certbot-www --quiet \
  && cp /etc/letsencrypt/live/<MAM_DOMAIN>/fullchain.pem /path/to/deploy/nginx/certs/fullchain.pem \
  && cp /etc/letsencrypt/live/<MAM_DOMAIN>/privkey.pem   /path/to/deploy/nginx/certs/privkey.pem \
  && docker compose -f /path/to/deploy/docker-compose.prod.yml --env-file /path/to/deploy/.env exec nginx nginx -s reload
```

### Option B — Corporate / internally-issued certificate

Place your organization's issued certificate chain and private key at
the same two paths:

```bash
cp /path/to/your-cert-chain.pem  nginx/certs/fullchain.pem
cp /path/to/your-private-key.pem nginx/certs/privkey.pem
```

`fullchain.pem` must include the full chain (leaf + intermediates), in
that order, for browsers to validate it without a manual intermediate
install.

---

## 4. Backup & Restore

Scripts live in `scripts/backup.sh` and `scripts/restore.sh`. Both read
`.env` from this directory automatically (or set `ENV_FILE=/path/to/.env`
to point elsewhere).

### Backup

```bash
./scripts/backup.sh /mnt/backups/mam
# or, relying on the BACKUP_DIR env var / the ./scripts/backups default:
BACKUP_DIR=/mnt/backups/mam ./scripts/backup.sh
```

Each run creates a timestamped directory (`YYYYMMDDTHHMMSSZ`) containing:

- `postgres-<db>-<timestamp>.sql.gz` — full logical dump via `pg_dump`.
- `es-snapshot-<timestamp>.json` — the Elasticsearch snapshot API
  response for a snapshot registered in a filesystem repository backed
  by the `mam-es-snapshots` volume.
- `manifest.txt` — a small summary `restore.sh` reads to locate the
  right dump/snapshot names.

**What is NOT backed up by this script:** MinIO/S3 binary data (video
masters, proxies, thumbnails). Object storage durability is expected to
come from the storage layer itself — enable versioning/replication on
the underlying bucket, or back up the `mam-prod-minio-data` Docker
volume with your infrastructure's own disk/volume snapshot tooling. This
mirrors standard MAM/DAM practice: databases (small, transactional,
point-in-time-recoverable) and bulk media (large, append-mostly, backed
up at the storage layer) have fundamentally different backup
economics.

### Restore

```bash
./scripts/restore.sh /mnt/backups/mam/20260910T020000Z
```

This is **destructive** — it drops and recreates the PostgreSQL schema
before loading the dump, and requires you to type the database name to
confirm. It stops the `nuxeo` container for the duration of the
PostgreSQL restore (Postgres/Elasticsearch/MinIO stay up) and restarts
it afterward.

Elasticsearch is deliberately **not** restored automatically — the
script prints the exact `curl` commands to restore the recorded snapshot
if you want the fast path, or you can trigger a full reindex from the
now-restored PostgreSQL data via Nuxeo's Admin Center ("Reindex all
documents") instead, which is slower but always self-consistent.

### Automating via cron

```cron
# Daily PostgreSQL + Elasticsearch snapshot backup, 02:00 server time
0 2 * * *  cd /path/to/deploy/scripts && ./backup.sh /mnt/backups/mam >> /var/log/mam-backup.log 2>&1

# Weekly pruning of backups older than 30 days, Sunday 03:00
0 3 * * 0  find /mnt/backups/mam -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
```

Per Technical Architecture Document 2.9.3: PostgreSQL backups should run
**daily**; a **weekly** full Elasticsearch snapshot is sufficient given
it is a rebuildable index (the cron entry above already produces one
snapshot per run of `backup.sh` — schedule `backup.sh` itself daily for
Postgres and weekly-only if you want to skip the ES snapshot on the
other six days; the script always does both by design, so the simplest
correct setup is just running it daily).

---

## 5. Troubleshooting

| Symptom | Likely cause | What to check |
|---|---|---|
| **Nuxeo fails to start / container keeps restarting** | Postgres/Elasticsearch not yet healthy, or a config/package install error | `docker compose logs nuxeo` — look for `FATAL`/`ERROR` near the top of the log (schema load errors, missing `nuxeo.conf` property). Confirm `docker compose ps` shows `postgres`, `elasticsearch`, `redis`, `minio-init` all healthy/completed *before* nuxeo started (`depends_on: condition: service_healthy` should already enforce this, but a first-boot race after a host reboot is the most common real-world cause). |
| **Elasticsearch OOM / container killed** | `ES_JAVA_OPTS` heap set larger than the container's actual memory limit, or too many indices/shards for the allotted heap | Lower `ES_JAVA_OPTS` in `.env` (2g is the documented baseline — do not exceed half the host's available RAM for this container). Check `docker stats mam-prod-elasticsearch` for actual usage, and `docker compose logs elasticsearch \| grep -i "OutOfMemory\|circuit_breaking"`. |
| **Upload fails with `413 Request Entity Too Large`** | A body size limit below the actual file size, enforced somewhere in the proxy chain | This package already sets `client_max_body_size 10G;` in `nginx/nginx.conf` for exactly this reason. If you still see 413s: (a) confirm nginx actually reloaded after any edit (`nginx -s reload` or restart the container), (b) check for **another** reverse proxy/load balancer in front of this stack (a corporate LB, Cloudflare, etc.) with its own smaller body-size limit — this package cannot control infrastructure outside itself, (c) confirm the client (mam-web) itself isn't chunking the upload in a way that trips a different limit. |
| **`docker compose up` succeeds but the browser shows a blank page / 404** | `mam-web-build` container failed or hasn't finished yet | `docker compose logs mam-web-build` — this is a one-shot container; `docker compose ps` should show it `Exited (0)`. A non-zero exit means the `npm run build` step failed (check for a Node/TypeScript error in the log) — nginx's `depends_on: condition: service_completed_successfully` should prevent nginx from serving stale content, but if you interrupted the very first `up`, re-run `docker compose up -d mam-web-build nginx`. |
| **Login redirects loop / never completes** | OIDC redirect URI mismatch between what's registered at the IdP and what mam-web actually uses | Confirm `OIDC_WEB_REDIRECT_URI` in `.env` (or its default, `https://<domain>/auth/callback`) is registered **exactly** (scheme, host, path, trailing slash) as an allowed redirect URI at your IdP. Check the browser console/network tab for the exact error the IdP returns. |
| **REST calls return `401 Not authenticated`** | JWKS URL unreachable from inside the nuxeo container, wrong issuer/audience, or clock skew | `docker compose logs nuxeo \| grep -i jwt`. Confirm `OIDC_JWKS_URL`/`OIDC_ISSUER`/`OIDC_CLIENT_ID` in `.env` exactly match your IdP's published values (`<issuer>/.well-known/openid-configuration`). Confirm the nuxeo container's clock is in sync (NTP) — JWT `exp`/`iat` validation is strict. |
| **Elasticsearch search / faceted filters return nothing, or 401s in Nuxeo logs mentioning ES** | ES password mismatch between the `elastic` superuser and what was baked into the Nuxeo image at build time | The ES password is a **build arg** (`ELASTIC_PASSWORD`), not a runtime environment variable — if you change `ELASTIC_PASSWORD` in `.env` after the nuxeo image was already built, you must `docker compose build nuxeo` again (or `up -d --build nuxeo`) for the new password to take effect. |
| **General "container X is unhealthy" during `up`** | The service's own healthcheck is failing | `docker compose logs <service>` first; then `docker inspect --format '{{json .State.Health}}' mam-prod-<service> \| jq` for the last few healthcheck attempts' actual output. |

For anything not covered here: `docker compose -f docker-compose.prod.yml --env-file .env logs --tail=200 <service>`
is the first move for every service in this stack.

---

## 6. File Reference

| File | Purpose |
|---|---|
| `docker-compose.prod.yml` | The production stack: nginx, mam-web-build, nuxeo, postgres, elasticsearch, redis, minio, minio-init. |
| `.env.prod.example` | Template for `.env` — copy and fill in real values. Never commit the resulting `.env`. |
| `nginx/nginx.conf` | Reverse proxy config: TLS termination, `/nuxeo` + `/api` proxying, large-upload support, static SPA hosting. |
| `nginx/certs/` | Bind-mount target for `fullchain.pem`/`privkey.pem`. Empty in version control (`.gitkeep` only). |
| `nginx/certbot-www/` | Webroot for Let's Encrypt HTTP-01 challenges. |
| `nuxeo/Dockerfile.prod` | Production Nuxeo image: mam-platform addon + vendored Nuxeo packages, RS256/JWKS JWT auth, BASIC_AUTH disabled, CSRF enabled. |
| `production/basic-auth-disable-config.xml` *(from mam-platform)* | Referenced by `Dockerfile.prod` to disable Basic Auth in production. Already existed in `mam-platform/deploy/production/` — copied at build time, not duplicated here. |
| `scripts/backup.sh` | PostgreSQL dump + Elasticsearch snapshot, timestamped output directory. |
| `scripts/restore.sh` | Restores a `backup.sh` run directory. Destructive; requires typed confirmation. |

---

## 7. Notes & Known Limitations

- **Redis**: provisioned per Technical Architecture Document 2.2.1 (caching/messaging tier) with a healthcheck and persistent volume, but **no code path in the current `mam-platform` addon or the base Nuxeo distribution in this workspace actually connects to it** (there is no `nuxeo-runtime-redis` module or `redis.*` nuxeo.conf template in the `D:\MaM\nuxeo` checkout this project vendors from). It is included so the infrastructure is ready the moment a caching/session-store integration is added, and so this deployment package doesn't need a second migration later — but as of this deployment, Redis runs idle. Wiring an actual consumer to it is out of scope for this infrastructure-only task and would require a `mam-platform` code change.
- **Cold storage**: `nuxeo/Dockerfile.prod` wires up the `nuxeo.coldstorage.*` properties, but — as documented in `mam-platform/README.md` — the `nuxeo-coldstorage` marketplace package itself is not vendored/installed (separate upstream repository, requires a private npm registry to build its Web UI module). The properties are inert until that package is added; see that README section for exact steps once you have a package artifact.
- **Elasticsearch topology**: single-node, per the Tech Arch 2.5.2/2.10.3 baseline sizing for an initial production deployment. For high availability, this is the one component you should plan to run as a proper multi-node cluster (or a managed Elasticsearch/OpenSearch service) before this deployment is relied upon for disaster recovery guarantees beyond "restore from last night's snapshot."
- **MinIO vs real AWS S3**: this package ships MinIO for a fully self-contained, single-host deployment. Switching to real AWS S3 is a `nuxeo.s3storage.endpoint` change (or removing it entirely) plus using real AWS credentials — see the comment in `.env.prod.example`'s MinIO/S3 section.
