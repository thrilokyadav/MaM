# MAM Platform — API & Integration Overview

**Audience:** External Developers, Systems Integrators

The MAM Platform's REST API is provided by the underlying Nuxeo Platform (2025.21 LTS) REST API, exposed under `/nuxeo/api/v1/`, with additional MAM-specific extensions (a custom content model, a named search provider, and an editorial workflow) layered on top. This document covers authentication and the key integration points relevant to `BroadcastAsset`/`BroadcastVideo` content.

All endpoints below are reached through the Nginx reverse proxy at `https://<MAM_DOMAIN>/nuxeo/api/v1/...` in production.

---

## Authentication

The platform authenticates API requests using OIDC/JWT Bearer tokens via a custom authentication plugin (`JWT_BEARER_AUTH`), which is prioritized ahead of legacy authentication methods on the REST API path.

### Obtaining a Token

1. Authenticate against your organization's configured OIDC provider (the same issuer configured via `OIDC_ISSUER` / `mam.jwt.issuer` on the server) using your normal OIDC flow (e.g., Authorization Code with PKCE for interactive clients, or Client Credentials for service-to-service integrations, depending on what your provider and client registration support).
2. Your OIDC provider issues a signed JWT access token. The platform accepts:
   - **RS256** tokens, verified against your provider's JWKS endpoint (recommended for production).
   - **HS256** tokens, verified against a shared secret (intended for development/smoke environments only).
3. The token must include:
   - An `iss` (issuer) claim matching the server's configured issuer exactly.
   - An `aud` (audience) claim matching the server's configured audience exactly.
   - A groups claim (default claim name `groups`) listing the caller's roles. External role names are mapped to internal MAM groups (`mam-producers`, `mam-editors`, `mam-archivists`, `mam-publishers`) via server-side configuration — a group name that isn't explicitly mapped will not carry any MAM permissions, even if present in the token.

### Using the Token

Pass the token on every request:

```
Authorization: Bearer <your-jwt-token>
```

On first successful authentication, the platform automatically provisions (or updates) a corresponding Nuxeo user account and synchronizes its group membership from the token's claims — there is no separate account creation step required.

### Example

```bash
curl -H "Authorization: Bearer $TOKEN" \
     https://mam.example.com/nuxeo/api/v1/me
```

---

## CSRF Note

Nuxeo's CSRF filter is designed to protect cookie/session-based browser flows. **Requests authenticated with an `Authorization: Bearer` header bypass the CSRF filter** — bearer tokens are not implicitly sent by the browser the way session cookies are, so they are not vulnerable to the same cross-site forgery vector. If you are integrating a server-to-server client using Bearer tokens exclusively, you do not need to acquire or send a CSRF token. This differs from the legacy cookie-based Form/Basic authentication flows, which remain subject to CSRF protection where still enabled.

---

## Key Endpoints

### 1. Uploading a File (Batch Upload API)

File uploads use Nuxeo's standard two-step batch upload protocol: upload the binary to a batch, then create (or update) a document referencing that batch.

**Step 1 — Upload the binary to a batch:**

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  -H "X-Upload-Type: normal" \
  --data-binary @newscast-segment.mp4 \
  https://mam.example.com/nuxeo/api/v1/upload/<batchId>/<fileIdx>
```

**Step 2 — Create the document from the uploaded batch:**

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "entity-type": "document",
    "name": "newscast-segment",
    "type": "BroadcastVideo",
    "properties": {
      "dc:title": "Evening Newscast Segment",
      "broadcast:programme": "Evening News",
      "broadcast:bureau": "London",
      "broadcast:storyType": "News",
      "file:content": {
        "upload-batch": "<batchId>",
        "upload-fileId": "<fileIdx>"
      }
    }
  }' \
  "https://mam.example.com/nuxeo/api/v1/path/default-domain/workspaces/newsroom"
```

Once created, `BroadcastVideo` assets are picked up automatically by Nuxeo's built-in video-conversion pipeline, which generates the playback proxy, storyboard, and poster frame in the background — no additional API call is required to trigger this.

### 2. Fetching Document Metadata

Standard Nuxeo REST document retrieval by ID:

```bash
curl -H "Authorization: Bearer $TOKEN" \
     https://mam.example.com/nuxeo/api/v1/id/<uid>
```

The response includes all schemas attached to the document, including the custom `broadcast` schema fields (`broadcast:programme`, `broadcast:storyType`, `broadcast:archiveState`, `broadcast:archiveDate`, `broadcast:archivedBy`, etc.) and standard Dublin Core fields (`dc:title`, `dc:created`, `dc:modified`).

### 3. Executing a Search

Two search paths are available:

**a) MAM's named, facet-aware search provider (recommended for catalog search)** — this is what the Asset Search page in the web client uses, and is backed by Elasticsearch with aggregations for `storyType`, `bureau`, and `editorialStatus`:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://mam.example.com/nuxeo/api/v1/search/pp/MAM_BROADCAST_ASSET_SEARCH/execute?q=segment&storyType=News&editorialStatus=approved&currentPageIndex=0&pageSize=20"
```

**b) Raw NXQL search (for ad-hoc queries)** — standard Nuxeo REST API, general-purpose:

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "SELECT * FROM BroadcastVideo WHERE broadcast:archiveState = '\''cold'\'' AND broadcast:bureau = '\''London'\''"
  }' \
  https://mam.example.com/nuxeo/api/v1/search/lang/NXQL/execute
```

> Note: fulltext search (the `q` parameter) requires the production PostgreSQL + Elasticsearch backend. It is not supported against lightweight test environments using an embedded database.

### 4. Triggering a Workflow Transition

**Start the editorial approval workflow on an asset:**

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "workflowModelName": "MAM_EDITORIAL_APPROVAL",
    "attachedDocumentIds": ["<uid>"]
  }' \
  https://mam.example.com/nuxeo/api/v1/workflow
```

Starting the workflow requires the caller to hold the `MAM_SubmitForReview` permission on the target document (granted via the `MAM_ProducerAccess` role bundle, i.e. membership in `mam-producers`).

**Complete a review task** (e.g., approve, reject, or submit from QC to editorial):

```bash
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"comment": "Approved for archive."}' \
  https://mam.example.com/nuxeo/api/v1/task/<taskId>/approve
```

Valid button/action names depend on the workflow node the asset is currently in:
- At Quality Control: `submit_to_editorial`, `reject`
- At Editorial Approval: `approve`, `reject`

**Cancel a running workflow instance:**

```bash
curl -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  https://mam.example.com/nuxeo/api/v1/workflow/<workflowInstanceId>
```

---

## Reference: Content Model Field Names

When integrating directly against the `broadcast` schema, use these exact field names:

| Field | Type | Notes |
|---|---|---|
| `broadcast:slug` | string | Short editorial identifier |
| `broadcast:programme` | string | |
| `broadcast:episode` | string | |
| `broadcast:bureau` | string | |
| `broadcast:storyType` | string | |
| `broadcast:airDate` | dateTime | |
| `broadcast:embargoUntil` | dateTime | |
| `broadcast:rightsHolder` | string | |
| `broadcast:rightsTerritory` | string | |
| `broadcast:rightsStart` | dateTime | |
| `broadcast:rightsEnd` | dateTime | |
| `broadcast:editorialStatus` | string | Workflow-managed: `draft`, `qc`, `approved`, `rejected` |
| `broadcast:archiveState` | string | Server-guarded: `hot`, `cold`. Only settable by `mam-archivists`/Administrators |
| `broadcast:archiveDate` | dateTime | Read-only; auto-stamped |
| `broadcast:archivedBy` | string | Read-only; auto-stamped |
| `broadcast:restoreDate` | dateTime | Read-only; auto-stamped |
| `broadcast:restoredBy` | string | Read-only; auto-stamped |

**Important**: `broadcast:archiveState` and its four audit fields are enforced server-side. Attempting to set `archiveState` via any API call without `mam-archivists` (or Administrator) group membership will fail with HTTP 403, and the four audit fields cannot be set directly by any caller under any role — they are written only by the server's archive guard logic.

---
*For deployment and operations, see `ADMIN_GUIDE.md`. For end-user workflows, see `USER_GUIDES.md`.*
