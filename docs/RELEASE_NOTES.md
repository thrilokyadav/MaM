# MAM Platform — Release Notes

**Version:** 1.0.0
**Release Date:** September 2026
**Audience:** Client Leadership, Program Sponsors

---

## Executive Overview

The MAM Platform delivers a self-hosted Media Asset Management system purpose-built for broadcast operations. It replaces ad-hoc file shares and third-party SaaS media tools with a single, governed system of record for broadcast video assets, metadata, and editorial workflow.

The platform was built on three core value propositions:

- **Cost Reduction** — The stack runs entirely on open-source and self-managed infrastructure (PostgreSQL, Elasticsearch, MinIO/S3, Redis), avoiding recurring per-seat or per-GB SaaS licensing fees typical of commercial MAM products.
- **Infrastructure Sovereignty** — The entire platform is deployable on client-owned or client-selected infrastructure via Docker Compose, with no mandatory dependency on a third-party vendor's cloud. Storage (MinIO or AWS S3), search (Elasticsearch), and identity (any OIDC-compliant provider) are all client-controlled.
- **Native Broadcast DNA** — The content model, terminology, and workflow are modeled directly on broadcast newsroom operations, not adapted from a generic digital asset management (DAM) product. Assets are typed as `BroadcastAsset` and `BroadcastVideo`, with metadata fields for programme, episode, bureau, story type, air date, and rights windows.

## Key Features Delivered

- **Broadcast Content Model** — Dedicated `BroadcastAsset` and `BroadcastVideo` document types with a custom `broadcast` metadata schema covering editorial identity (`programme`, `episode`, `bureau`, `storyType`, `slug`), scheduling (`airDate`, `embargoUntil`), and rights management (`rightsHolder`, `rightsTerritory`, `rightsStart`, `rightsEnd`).
- **Video Ingest and Proxy Generation** — `BroadcastVideo` assets use Nuxeo's built-in video pipeline (via the `Video`, `HasStoryboard`, and `HasVideoPreview` facets) to automatically generate playback proxies, storyboard thumbnails, and poster frames on upload of MXF/MP4 masters.
- **Full-Text and Faceted Search** — A dedicated Elasticsearch-backed search page provider (`MAM_BROADCAST_ASSET_SEARCH`) powers the Asset Search page, with faceted filtering on story type, bureau, and editorial status.
- **Editorial Review Workflow** — A structured five-node approval workflow (`MAM_EDITORIAL_APPROVAL`) moves assets through Draft → Quality Control → Editorial Approval → Approved/Rejected, with task assignment to the `mam-editors` group and full audit history.
- **Server-Enforced Archive Governance** — Cold storage transitions (`broadcast:archiveState`) are enforced server-side, not just in the UI, by a dedicated security listener that restricts the action to Administrators and members of `mam-archivists`, and automatically stamps immutable audit fields.
- **Immutable Archive Audit Trail** — Every archive and restore action is automatically recorded with `archiveDate`/`archivedBy` and `restoreDate`/`restoredBy`, with no code path allowing a caller to set these fields directly.
- **Modern Web Client** — A React/TypeScript single-page application covering upload, search, review queue, asset detail/metadata editing, and archive management, tailored to each user persona.
- **Production-Ready Deployment** — A complete Docker Compose stack with Nginx TLS termination, automated database and search backup scripts, and a documented restore runbook.

## Architecture Highlights

| Layer | Technology |
|---|---|
| Application Server | Nuxeo Platform 2025.21 LTS (JDK 21) |
| Relational Database | PostgreSQL 16 |
| Search & Indexing | Elasticsearch 8.15 |
| Object Storage | MinIO (S3-compatible), with AWS S3 supported as a drop-in replacement |
| Cache/Session Layer | Redis 7 (provisioned for future use; not yet consumed by any code path) |
| Frontend | React 18 + TypeScript, built with Vite |
| Reverse Proxy / TLS | Nginx 1.27 |
| Identity | OIDC-compliant provider (client-supplied) |

The system is delivered as a set of Docker Compose services, with Nginx as the sole public-facing entry point, terminating TLS 1.2/1.3 and routing traffic to the Nuxeo application server and the static web client build.

## Security Posture

- **Authentication**: The platform authenticates API and web client traffic using OIDC/JWT Bearer tokens. A custom authentication plugin (`JWT_BEARER_AUTH`) verifies incoming bearer tokens against the client's OIDC provider, supporting both RS256 (JWKS endpoint) and HS256 (shared secret, non-production use) signing, with strict issuer and audience validation.
- **Just-in-Time Provisioning**: User accounts are created or synchronized automatically on first authenticated request, with group membership derived from the identity provider's claims — there is no local password for OIDC-authenticated users.
- **Server-Enforced RBAC**: Role separation is modeled through four broadcast-specific role bundles — `MAM_ProducerAccess`, `MAM_EditorAccess`, `MAM_ArchivistAccess`, and `MAM_PublisherAccess` — mapped to the identity provider groups `mam-producers`, `mam-editors`, `mam-archivists`, and `mam-publishers` respectively.
- **Archive Governance**: Transitions of an asset's archive state are enforced at the server layer regardless of client (REST, automation, or UI), with unauthorized attempts rejected with an HTTP 403 and the operation rolled back — this cannot be bypassed by calling the API directly.
- **Transport Security**: All public traffic is served over TLS 1.2/1.3 with HSTS, and production deployments disable legacy Basic Authentication in favor of OIDC and bearer tokens.

## Known Limitations

To set accurate expectations for operations and future scope planning:

- Redis is provisioned and health-checked in the production stack but is not yet used by any application code path.
- Cold storage is implemented via the custom `archiveState` audit mechanism described above; the upstream Nuxeo Cold Storage marketplace package is not installed.
- Elasticsearch is deployed as a single node in this release; a multi-node cluster should be planned before relying on it as a sole source of search availability.
- MinIO/S3 binary object storage is not covered by the included backup script and must be protected via storage-layer replication or volume snapshots.

---
*For deployment and operations guidance, see `ADMIN_GUIDE.md`. For end-user instructions, see `USER_GUIDES.md`. For developer/API integration, see `API_OVERVIEW.md`.*
