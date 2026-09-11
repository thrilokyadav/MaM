# MAM Platform

Commercial Media Asset Management customization built on top of the Nuxeo
Platform 2025 LTS, delivered as an **out-of-tree Maven multi-module addon**.

> The Nuxeo core sources at `D:\MaM\nuxeo` are considered vendor code and are
> **never modified** by this project. All MAM-specific behaviour lives in
> this repository, packaged as an installable Nuxeo addon.

## Modules

| Module         | Packaging | Purpose                                                              |
|----------------|-----------|----------------------------------------------------------------------|
| `mam-core`     | jar       | Nuxeo OSGi bundle. Ships the `BroadcastAsset` doctype and the `broadcast` metadata schema. |
| `mam-security` | jar       | Nuxeo OSGi bundle. Registers MAM custom permissions and role-bundle compounds with the stock `SecurityService`. |
| `mam-workflow` | jar       | Nuxeo OSGi bundle. Ships the `MAM Editorial Approval` document route model plus its status-writer automation chains. |
| `mam-package`  | zip       | Installable Nuxeo marketplace-style addon bundling all MAM bundles. |

Additional modules (`mam-media`, `mam-ui`, `mam-integration`,
`mam-tests`) will be added in later tasks. They are intentionally not present
in this scaffold.

## Prerequisites

- **JDK 21** (Azul Zulu 21 recommended). Set `JAVA_HOME`.
- **Apache Maven 3.9.6+** (tested with 3.9.9).
- The Nuxeo `2025.21-SNAPSHOT` parent POMs must be present in the local Maven
  repository at `~/.m2/repository/org/nuxeo/`. They are not published to the
  anonymous Nuxeo public Maven repository. To install them locally:

  ```
  cd D:\MaM\nuxeo
  mvn -N -B -DskipTests install

  cd D:\MaM\nuxeo\parent
  mvn -N -B -DskipTests install
  ```

  The `-N` flag installs only the current POM without descending into the
  Nuxeo reactor. Both commands write only under `~/.m2` and never modify
  the Nuxeo checkout.

## Build

From `D:\MaM\mam-platform`:

```
mvn -B -DskipTests package
```

Expected artifacts:

- `mam-core/target/mam-core-1.0.0-SNAPSHOT.jar`
- `mam-package/target/mam-package-1.0.0-SNAPSHOT.zip`

To verify POM validity without hitting the network:

```
# Root aggregator only:
mvn -o -B -N validate

# mam-core in isolation:
mvn -o -B -f mam-core/pom.xml validate
```

A full offline **reactor** build (`mvn -o ... package` from the root) does
not work from a clean state, because `mam-package` depends on the
`mam-core` JAR and Maven cannot fetch it in offline mode until it has
been installed to the local repository. Run `mvn -B -DskipTests install`
once (online) to seed `~/.m2` with `mam-core`; after that, `mvn -o -B
-DskipTests package` succeeds against the whole reactor.

## Installation concept

The `mam-package` ZIP is an installable Nuxeo addon. On a running Nuxeo
server, install it via `nuxeoctl mp-install <path-to-zip>` or through the
Admin Center. The ZIP contains:

- `package.xml`   — addon descriptor (name, version, target platform)
- `install.xml`   — install script (copies bundles into `nxserver/bundles`)
- `install/bundles/mam-core-<version>.jar`

## Ground rules

1. **Never edit files under `D:\MaM\nuxeo`.** If you need behaviour that
   requires a Nuxeo core change, raise it upstream instead of forking.
2. All Nuxeo dependency versions are managed by the inherited
   `nuxeo-parent`. Do not declare `<version>` on any `org.nuxeo*` artifact
   inside module POMs.
3. This project uses the **Nuxeo Web UI extension model**. JSF-era APIs
   must not be reintroduced.
4. Proprietary licensing applies to all files under `D:\MaM\mam-platform`.
   Files inside `D:\MaM\nuxeo` retain their original Apache 2.0 notices.

## Current model

The `mam-core` bundle now ships the first functional MAM contribution: one
document type and one metadata schema. No Java, no lifecycle, no
permissions, no automation — those are separate features.

### Document type: `BroadcastAsset`

Extends `Document`. Deliberately media-agnostic: it can carry any file
payload (video, audio, image, script, document). Media-specific processing
(FFmpeg, thumbnails, storyboard) will be layered later as separate
contributions and will not require re-declaring this type.

Attached schemas:

| Schema        | Purpose                                  | Origin           |
|---------------|------------------------------------------|------------------|
| `common`      | Icon, size, and other common properties  | Nuxeo core       |
| `dublincore`  | Title, description, created, modified... | Nuxeo core       |
| `uid`         | UID generation slot                      | Nuxeo core       |
| `files`       | Additional attachments                   | Nuxeo core       |
| `file`        | Main content blob                        | Nuxeo core       |
| `broadcast`   | MAM broadcast metadata (this addon)      | `mam-core`       |

Facets: `Versionable`, `Commentable`.

`BroadcastAsset` is added as an allowed subtype under `Workspace`,
`Folder`, and `OrderedFolder`.

### Schema: `broadcast` (prefix `broadcast`)

Namespace: `http://www.mam-platform.com/ecm/schemas/broadcast`
Source: `mam-core/src/main/resources/schemas/broadcast.xsd`

All fields are top-level and therefore optional at the document level.

| Property                     | XML type    | Purpose                                                  |
|------------------------------|-------------|----------------------------------------------------------|
| `broadcast:slug`             | `xs:string` | Editorial story identifier                               |
| `broadcast:programme`        | `xs:string` | Programme or show name                                   |
| `broadcast:episode`          | `xs:string` | Episode, bulletin, or edition                            |
| `broadcast:bureau`           | `xs:string` | Originating bureau or newsroom                           |
| `broadcast:storyType`        | `xs:string` | News, interview, package, raw footage, etc.              |
| `broadcast:airDate`          | `xs:dateTime` | Scheduled or actual broadcast timestamp                |
| `broadcast:embargoUntil`     | `xs:dateTime` | Earliest permitted publication time                    |
| `broadcast:rightsHolder`     | `xs:string` | Rights owner                                             |
| `broadcast:rightsTerritory`  | `xs:string` | Permitted territory                                      |
| `broadcast:rightsStart`      | `xs:dateTime` | Start of rights window                                 |
| `broadcast:rightsEnd`        | `xs:dateTime` | End of rights window                                   |
| `broadcast:editorialStatus`  | `xs:string` | `draft`, `qc`, `approved`, or `rejected` — the only 4 values the `MAM_EDITORIAL_APPROVAL` workflow ever writes. Transitions are server-enforced by `EditorialStatusGuardListener` (see below); any other value is rejected outright. |
| `broadcast:archiveState`     | `xs:string` | Hot, warm, cold, restore-pending                         |
| `broadcast:archiveDate`      | `xs:dateTime` | Stamped automatically by `ArchiveStateGuardListener` when `archiveState` transitions to `cold`. Never set directly by callers. |
| `broadcast:archivedBy`       | `xs:string` | Username stamped automatically alongside `archiveDate`. |
| `broadcast:restoreDate`      | `xs:dateTime` | Stamped automatically by `ArchiveStateGuardListener` when `archiveState` transitions to `hot`. Never set directly by callers. |
| `broadcast:restoredBy`       | `xs:string` | Username stamped automatically alongside `restoreDate`. |

> **Free-text at the schema level, but no longer unenforced.**
> `editorialStatus` and `archiveState` are still plain XSD strings (no
> schema-level enum) — the controlled vocabulary and transition rules are
> enforced entirely in Java by `EditorialStatusGuardListener` and
> `ArchiveStateGuardListener` respectively (see below), not by the
> schema. `editorialStatus`'s legal value set (`draft`/`qc`/`approved`/
> `rejected`) is now the enforced source of truth server-side; do not
> assume a caller can set it to anything else and have it accepted.
> `archiveState`'s value set (`hot`/`cold`, plus `warm`/`restore-pending`
> as UI-only placeholders not yet wired to any guard rule) remains less
> strictly constrained — only the `hot`/`cold` transition path is
> currently guarded.

> **Archive audit trail (Priority 5).** `archiveDate`/`archivedBy` and
> `restoreDate`/`restoredBy` are write-once-per-transition fields owned
> entirely by `ArchiveStateGuardListener` (see below) — they are stamped
> in the same `saveDocument` call that changes `archiveState`, and are
> never cleared on a later transition (each pair records the *most
> recent* archive/restore event, and prior values from the other pair
> are preserved as history, not reset). Setting these fields directly
> via REST/automation has no special protection of its own today — the
> listener simply overwrites them again on the next real
> archive/restore transition — but there is no legitimate reason for a
> caller to set them manually.

### Document type: `BroadcastVideo`

Extends `BroadcastAsset` and adds three stock facets from
`nuxeo-platform-video`: **`Video`**, **`HasStoryboard`**, and
**`HasVideoPreview`**. The same three facets are declared on Nuxeo's
own `Video` doctype. Together they reuse Nuxeo's shipped video
pipeline unchanged: automatic MP4/WebM proxy generation, poster
thumbnail via `picture:views`, storyboard tile generation, and video
preview. This addon contributes no custom FFmpeg commands, no custom
converters, and no custom listeners.

`BroadcastVideo` is added as an allowed subtype under `Workspace`,
`Folder`, and `OrderedFolder` alongside `BroadcastAsset`.

Schemas available on a `BroadcastVideo` document:

- Everything on `BroadcastAsset`: `common`, `dublincore`, `uid`,
  `files`, `file`, `broadcast`.
- Contributed by the `Video` facet: `video` (duration, dimensions,
  frame rate, streams, transcodedVideos), `picture` (poster views).
- Marker facets `HasStoryboard` and `HasVideoPreview` are applied
  automatically by upstream listeners once conversion completes; those
  facets expose additional properties on the document (`vid:storyboard`,
  `picture:views`).

**Which subtype to use.** Use `BroadcastVideo` when the payload is a
video file that should participate in transcode, thumbnail, and
storyboard generation. Use `BroadcastAsset` for every other broadcast
payload: scripts, PDFs, still images, audio clips, packaged deliveries.
Non-video assets are left untouched by the video pipeline. Audio- and
picture-specific subtypes will be introduced later on the same pattern
if the newsroom requires them.

### FFmpeg

Nuxeo's video pipeline shells out to `ffmpeg` and `ffprobe`. The
upstream Nuxeo Docker image intentionally omits both binaries (non-free
codecs). This addon installs FFmpeg **only in the smoke image** via
`Dockerfile.smoke` (RPM Fusion free repository on Oracle Linux 9). That
layer is disposable and stays out of any production image; if and when
a production image is produced it must apply its own FFmpeg install
policy consistent with the deployment's licensing constraints.

### Verified in this task

- XML/XSD files are well-formed.
- Maven packaging places `schemas/broadcast.xsd` and the updated
  `OSGI-INF/mam-core-contrib.xml` inside the `mam-core` JAR, and the
  JAR inside `install/bundles/` of the addon ZIP.
- The smoke harness confirms end-to-end:
  1. `BroadcastAsset` and `BroadcastVideo` are both registered.
  2. Broadcast metadata (dc + broadcast fields) round-trips on both.
  3. An MP4 fixture uploaded to a `BroadcastVideo` produces a
     non-empty `video:transcodedVideos` array.
  4. `/@rendition/thumbnail` returns a non-empty image response.

## Search: `MAM_BROADCAST_ASSET_SEARCH`

The MAM search capability is a **named page provider** contributed to
Nuxeo's stock `PageProviderService`. No custom search engine, no custom
Java, no Web UI screens yet.

- **Provider name:** `MAM_BROADCAST_ASSET_SEARCH`
- **Type:** `searchServicePageProvider` (NXQL, executed through Nuxeo's
  `SearchService` abstraction rather than directly against the
  repository). This is required — not just a `coreQueryPageProvider` —
  specifically so the aggregates below are honored:
  `CoreQueryDocumentPageProvider.hasAggregateSupport()` always returns
  `false`, while `SearchServicePageProvider` delegates both query
  execution and aggregation to `SearchService`, which resolves to
  Elasticsearch/OpenSearch once `nuxeo-search-client-opensearch1` is
  installed and configured (see "PostgreSQL + Elasticsearch integration
  stack" below). The `whereClause`/predicate/`fixedPart`/sort/pageSize
  XML shape is unchanged from a plain `coreQueryPageProvider`.
- **Scope:** `SELECT * FROM BroadcastAsset` — polymorphic, so the result
  set includes `BroadcastAsset` and every subtype (currently
  `BroadcastVideo`; any future subtype is picked up automatically).
- **Fixed exclusions:** trashed, versioned, and proxy documents are
  never returned.
- **Ordering:** `dc:modified DESC` (newest modified first).
- **Default page size:** `20`. Overridable per request via `pageSize`.
- **Pagination:** driven by Nuxeo's standard `currentPageIndex` /
  `pageSize` (or `currentPageOffset` / `pageSize`) query parameters on
  the REST endpoint below.

### Request parameters

Every filter is optional. Predicates whose parameter is absent or
empty are dropped from the generated NXQL, so the same provider serves
both "list everything" and "narrow with filters" use cases.

| Query parameter        | Backing NXQL predicate                              | Purpose                                                              |
|------------------------|-----------------------------------------------------|----------------------------------------------------------------------|
| `q`                    | `ecm:fulltext = :q`                                 | Free-text search. Nuxeo's default fulltext catalog indexes all string schema properties, which covers `dc:title`, `broadcast:slug`, `broadcast:programme`, and `broadcast:bureau`. Requires a fulltext-capable backend (PostgreSQL, MongoDB, Elasticsearch/OpenSearch). See caveat below for the H2-based smoke stack. |
| `storyType`            | `broadcast:storyType = :storyType`                  | Exact filter, plus a terms facet aggregation (`storyType_agg`).      |
| `bureau`               | `broadcast:bureau = :bureau`                        | Exact filter, plus a terms facet aggregation (`bureau_agg`).         |
| `editorialStatus`      | `broadcast:editorialStatus = :editorialStatus`      | Exact filter, plus a terms facet aggregation (`editorialStatus_agg`).|
| `archiveState`         | `broadcast:archiveState = :archiveState`            | Exact filter.                                                        |

### Faceted aggregations

The response's `aggregations` object carries one terms aggregation per
facet field (`storyType_agg`, `bureau_agg`, `editorialStatus_agg`), each
with up to 20 buckets (`{ "key": ..., "docCount": ... }`), computed by
Elasticsearch. Each aggregate's `<field>` in the XML contribution
(`mam-core-contrib.xml`) MUST reference a real schema property (e.g.
`schema="broadcast" name="storyType"`) — this is not cosmetic:
`AggregateBase#getSelection()` resolves the current facet selection back
from the page provider's search document via
`searchDocument.getProperty(field.getSchema(), field.getName())`, and a
field with no schema (or a nonexistent property) throws a
`NullPointerException` as soon as any aggregate is requested, which
takes down the *entire* query — including the plain filter/full-text
predicates, not just the aggregation.

### REST endpoint

The provider is executed through Nuxeo's standard named-page-provider
endpoint (see `SearchTest` in `nuxeo-search-rest-api`):

```
GET /nuxeo/api/v1/search/pp/MAM_BROADCAST_ASSET_SEARCH/execute
    ?q=<free-text>
    &storyType=<value>
    &bureau=<value>
    &editorialStatus=<value>
    &archiveState=<value>
    &currentPageIndex=<0-based page>
    &pageSize=<override, defaults to 20>
```

### Backend caveat: H2 (smoke stack only)

The disposable smoke image (`compose.smoke.yaml`/`Dockerfile.smoke`)
runs against Nuxeo's embedded VCS on H2, with no Elasticsearch/OpenSearch
search client installed. Nuxeo's `DialectH2` explicitly refuses fulltext
search (see `nuxeo-core-storage-sql/.../dialect/DialectH2.java`, which
throws "Fulltext search cannot be enabled with H2"). Consequently,
executing `MAM_BROADCAST_ASSET_SEARCH` with a `q=` parameter on the
smoke stack fails; the exact same provider works unmodified against the
PostgreSQL + Elasticsearch integration stack described below, and
against MongoDB in a real deployment.

### Not yet in scope

- Web UI search screens (Elements/Studio designer contributions,
  saved-search UI, faceted filter widgets) are **not implemented in
  this task**. Only the server-side provider exists so far. Callers
  should drive it directly through REST until the UI layer lands.
- Controlled vocabularies for `storyType`, `editorialStatus`, and
  `archiveState` are still free-form strings (see the schema note above).

## Security: MAM permissions and role contract

`mam-security` registers MAM-specific permissions with Nuxeo's stock
`SecurityService` via its `permissions` and `permissionsVisibility`
extension points (identical mechanism used by `nuxeo-core` to declare
`Read`, `Write`, and `Everything`). No custom Java, no custom
`SecurityPolicy`. All enforcement rides on standard ACL / ACP APIs
and on `session.hasPermission(doc, name)`; Administrator continues to
pass every check thanks to Nuxeo's built-in `Everything` shortcut.

### Atomic permissions

| Permission              | Meaning                                                            |
|-------------------------|--------------------------------------------------------------------|
| `MAM_EditMetadata`      | Allowed to edit `broadcast:*` fields on a MAM asset.               |
| `MAM_SubmitForReview`   | Allowed to start the `MAM_EDITORIAL_APPROVAL` route on an asset.   |
| `MAM_Approve`           | Allowed to approve an asset in the editorial workflow.             |
| `MAM_Reject`            | Allowed to reject an asset in the editorial workflow.              |
| `MAM_Publish`           | Allowed to publish an approved asset downstream.                   |
| `MAM_Archive`           | Allowed to move an asset between `broadcast:archiveState` values.  |

None of these atomic permissions is included in `Read`, `Write`, or
`Everything`, so no user gains them silently. Administrator still
passes every MAM check via the built-in `Everything` shortcut, which
is the desired production behavior.

### Role contract (bundled compound permissions)

Each role compound is a Nuxeo permission that `<include>`s its
atomic set, so a single ACL entry grants an entire role. Compounds
are surfaced by `permissionsVisibility` for the standard permission
dropdown.

| Role                | Group identifier   | Bundled permission     | Included atomics                                  |
|---------------------|--------------------|------------------------|---------------------------------------------------|
| MAM Producer        | `mam-producers`    | `MAM_ProducerAccess`   | `Read`, `Write`, `MAM_EditMetadata`, `MAM_SubmitForReview` |
| MAM Archivist       | `mam-archivists`   | `MAM_ArchivistAccess`  | `Read`, `Write`, `MAM_EditMetadata`, `MAM_Archive`         |
| MAM Editor          | `mam-editors`      | `MAM_EditorAccess`     | `Read`, `MAM_Approve`, `MAM_Reject`                        |
| MAM Publisher       | `mam-publishers`   | `MAM_PublisherAccess`  | `Read`, `MAM_Publish`                                      |
| MAM Administrator   | `administrators`   | (Nuxeo `Everything`)   | Unchanged; every MAM check passes via `Everything`.        |

### Group identifiers are configurable, not provisioned

The four group names (`mam-producers`, `mam-archivists`, `mam-editors`,
`mam-publishers`) are **identifiers only**. This addon does not
provision them, does not create users, and does not ship any
passwords. In production these groups must be materialized by the
identity provider (LDAP / SAML / OIDC directory sync). The route
model references `mam-editors` by name via
`taskAssigneesExpr="mam-editors"`; if the deployment has not yet
provisioned that group, only Administrator can complete QC and
Editorial tasks. Membership changes require no addon rebuild.

### What is enforced today

- `MAM_SubmitForReview` is fully enforced. The route availability
  filter `filter@MAM_EDITORIAL_APPROVAL` declares
  `<permission>MAM_SubmitForReview</permission>`, and
  `DocumentRoutingServiceImpl.canCreateInstance` refuses to start the
  workflow (HTTP 400) for callers without that permission on the
  target document.
- `MAM_Approve` / `MAM_Reject` are enforced at task level. The
  `NodeEditorial` (and `NodeQC`) task actors are the `mam-editors`
  group; Nuxeo Document Routing only lets a task actor (or a member
  of an actor group) press a task button. Administrator remains able
  to complete tasks via `Everything`.
- Metadata write on a MAM asset still gates on Nuxeo's built-in
  `WriteProperties`. Granting `MAM_EditMetadata` alone is a
  contract marker: it does not by itself let a user save fields.
  This is why `MAM_ProducerAccess` and `MAM_ArchivistAccess` bundle
  `Write` alongside `MAM_EditMetadata`.

### What still requires identity-provider integration

- Provisioning of the four MAM groups and their members. LDAP /
  SAML / OIDC directory sync is out of scope for this addon.
- `MAM_Publish` and `MAM_Archive` are contract-only. No publishing
  or archival pipeline exists yet; when those pipelines land they
  must call `session.hasPermission(doc, "MAM_Publish")` /
  `... "MAM_Archive"` explicitly (or declare
  `<permission>MAM_Publish</permission>` on their own action
  filter) to make the check real.
- Web UI screens that surface role membership, task queues, or the
  MAM permission dropdown are not implemented in this task.

### Archive state guard and audit trail (Priority 5)

`ArchiveStateGuardListener` (`mam-security`) is a synchronous
`beforeDocumentModification` core listener, registered in
`mam-security-contrib.xml`, that enforces a rule ACLs alone cannot
express: **only Administrator or a member of `mam-archivists` may
change `broadcast:archiveState`**, regardless of standard
`Write`/`WriteProperties` permission. Anyone else attempting the
change gets HTTP 403 (`DocumentSecurityException`), and the property
is left unchanged.

Once the caller is authorized, the same listener call also stamps the
archive audit trail fields, in the same `saveDocument` call that
changed `archiveState` (no second save, no extra event round trip):

- `archiveState` → `"cold"`: sets `broadcast:archiveDate` to now and
  `broadcast:archivedBy` to the caller's username.
- `archiveState` → `"hot"` (restore): sets `broadcast:restoreDate` to
  now and `broadcast:restoredBy` to the caller's username.

Each pair is independent history: restoring does not clear the prior
`archiveDate`/`archivedBy`, and archiving again later overwrites only
`archiveDate`/`archivedBy` with the new event, leaving the most recent
restore stamp as-is. See `ArchiveStateGuardListenerTest` for the
runtime-verified behavior and `scripts/integration-test.ps1` step 8 for
the REST-level verification against the PostgreSQL-backed integration
stack.

### Editorial status guard

`EditorialStatusGuardListener` (`mam-security`) closes an equivalent gap
that existed for `broadcast:editorialStatus`: unlike `archiveState`, this
field previously had **no server-side protection at all** — any caller
holding plain `Write` could set it to any value, including `approved`,
completely bypassing the `MAM_EDITORIAL_APPROVAL` workflow. This was
confirmed directly against a running server (a `mam-producers` member
could self-approve their own asset with a single PUT) before this
listener was added.

The guard is structured as the same kind of synchronous
`beforeDocumentModification` core listener, registered alongside the
archive guard in `mam-security-contrib.xml`, but it cannot use the same
"allowlist one group" strategy: the workflow engine itself writes this
property under the real acting user's own `NuxeoPrincipal` (there is no
privileged/system session anywhere in `mam-workflow` — it is pure
automation-chain XML, `Document.SetProperty` with `save=true`), so "is
this the workflow" cannot be distinguished from "is this a raw PUT" by
principal alone. Instead, each transition requires the matching MAM
permission on the document, checked via
`CoreSession#hasPermission(DocumentRef, String)`:

| Target value | Required permission | Held by (via role bundle) |
|---|---|---|
| `draft`, `qc` | `MAM_SubmitForReview` | `mam-producers` (`MAM_ProducerAccess`) |
| `approved` | `MAM_Approve` | `mam-editors` (`MAM_EditorAccess`) |
| `rejected` | `MAM_Reject` | `mam-editors` (`MAM_EditorAccess`) |

Any other value is rejected outright (fail closed), including
Administrator's own writes only being exempt via the explicit
`isAdministrator()` check, not a wildcard. Because a legitimate workflow
transition only ever happens once the routing engine has restricted a
task to its assigned actor (`mam-editors` for `NodeQC`/`NodeEditorial`),
and that group already holds the matching permission via its ACL grant,
real workflow-driven writes pass this check transparently — no change to
`mam-workflow` was needed. See `EditorialStatusGuardListenerTest` for the
runtime-verified behavior, including the specific regression test for the
original bug (`producerWithoutApprovePermissionCannotSelfApprove`).

## Workflow: `MAM Editorial Approval`

The first MAM workflow reuses Nuxeo's stock **Document Routing** service.
No custom Java, no custom state machine, no UI screens yet. The route
model is shipped as a Nuxeo IO archive (identical mechanism used by
`SerialDocumentReview` / `ParallelDocumentReview` in
`nuxeo-routing-default`) and imported at repository initialization by
Nuxeo's `RouteModelsInitializator` via the
`org.nuxeo.ecm.platform.routing.service#routeModelImporter` extension
point.

- **Route model name (`workflowModelName`):** `MAM_EDITORIAL_APPROVAL`
- **Display title:** `MAM Editorial Approval`
- **Routable doctypes:** `BroadcastAsset`, `BroadcastVideo`. Enforced by
  the action filter `filter@MAM_EDITORIAL_APPROVAL`, checked by
  `DocumentRoutingServiceImpl.canCreateInstance` before any route
  instance is created.

### Stages

The route is a graph of five nodes; each maps to one stage.

| Stage | Node id | Task assignee | Buttons | On entry, `broadcast:editorialStatus` becomes |
|-------|---------|---------------|---------|-----------------------------------------------|
| Draft / submission     | `NodeDraft`     | (no task, auto-advances)  | —                                | `draft`     |
| Quality Control        | `NodeQC`        | group `mam-editors`       | `submit_to_editorial`, `reject`  | `qc`        |
| Editorial Approval     | `NodeEditorial` | group `mam-editors`       | `approve`, `reject`              | (unchanged, stays `qc`) |
| Approved (terminal)    | `NodeApproved`  | —                         | —                                | `approved`  |
| Rejected (terminal)    | `NodeRejected`  | —                         | —                                | `rejected`  |

Status writes happen inside four automation chains
(`mam_setEditorialStatus_draft`, `_qc`, `_approved`, `_rejected`) wired
into each node's `inputChain`. Each chain does `Context.FetchDocument`
then `Document.SetProperty` on `broadcast:editorialStatus` with
`save=true`, matching the pattern used by `validateDocument` and
`terminateWorkflow` in `nuxeo-routing-default`.

### Task assignment: group, not user

`NodeQC` and `NodeEditorial` set `taskAssigneesExpr="mam-editors"`.
That string is treated by Nuxeo Document Routing as a principal
identifier: users belonging to the `mam-editors` group become task
actors, and `DocumentRoutingServiceImpl.grantPermissionToTaskAssignees`
adds a routing ACL that grants them `ReadWrite` on the attached
document for the duration of the task. Administrator retains access
via `Everything`.

The `mam-editors` group is **not created by this addon**. If the
deployment has not yet provisioned it, only Administrator can complete
tasks. Refined role separation (a dedicated QC group distinct from
`mam-editors`) is deferred to when a QC role is actually needed.

### Starting and driving the workflow

```
POST /nuxeo/api/v1/workflow
Content-Type: application/json
{
  "entity-type": "workflow",
  "workflowModelName": "MAM_EDITORIAL_APPROVAL",
  "attachedDocumentIds": ["<BroadcastAsset uid>"]
}
```

Complete a task by name (button):

```
PUT /nuxeo/api/v1/task/{taskId}/{button}
Content-Type: application/json
{ "entity-type": "task", "id": "{taskId}", "variables": {} }
```

Cancel:

```
DELETE /nuxeo/api/v1/workflow/{workflowInstanceId}
```

These endpoints are covered by `WorkflowEndpointTest` in
`nuxeo-routing-rest-api` (see the `testAdapter` and
`testCreateGetAndCancelWorkflowEndpoint` methods).

### Not yet in scope

- No Web UI for starting the route or acting on tasks. Callers must
  drive it through the REST endpoints above.
- No IdP-side provisioning of the MAM groups.
- No publishing or YouTube integration on `approve`.
- No lifecycle transitions on the attached document. The `approve`
  outcome is expressed purely via `broadcast:editorialStatus`.

## Runtime smoke test (disposable)

A single-node Docker Compose harness proves the mam-package installs
into a real Nuxeo 2025 server and that `BroadcastAsset` becomes
usable via REST. **Not for production.** No database, search cluster,
or storage backend is provisioned; Nuxeo runs against its embedded VCS.

### Prerequisites

- Docker Desktop running.
- A locally built Nuxeo 2025 image tagged `nuxeo/nuxeo:2025.x` (the
  base image is loaded from the local daemon; nothing is pulled from
  a registry).
- Addon already packaged:

  ```
  mvn -B -DskipTests package
  ```

### One-time setup

Copy the sample env file and edit if needed:

```
Copy-Item .env.smoke.example .env.smoke
```

`.env.smoke` is git-ignored on purpose. Never commit credentials there.

### Run

```
scripts\smoke-test.ps1
```

The script:

1. Verifies the base image and the addon ZIP are present.
2. Builds `mam-platform/nuxeo-smoke:local` from `Dockerfile.smoke`.
3. Starts the compose stack and waits (up to 10 min) for
   `/nuxeo/runningstatus` to return 200.
4. Confirms `BroadcastAsset` is exposed by `/api/v1/config/types/BroadcastAsset`.
5. Creates one `BroadcastAsset` in `/default-domain/workspaces` with
   `dc:title`, `broadcast:slug`, `broadcast:programme`,
   `broadcast:editorialStatus`, and `broadcast:archiveState` set.
6. Fetches it back and asserts each property round-trips.
7. Deletes the test document.
8. Runs `docker compose down`.

Named volumes (`mam-smoke-nuxeo-*`) are preserved across runs. Remove
them manually with `docker volume rm` when you want a clean slate.

### On failure

The script writes the container's stdout/stderr into `logs/nuxeo-<timestamp>.log`,
stops the stack, and exits non-zero. The exact failing step is printed
in red before the script exits.

## PostgreSQL + Elasticsearch integration stack (disposable)

The smoke stack above proves the addon installs and its REST contract
works, but it runs on H2, which cannot do full-text or faceted search at
all. This second, separate disposable stack (`compose.integration.yaml`
/ `Dockerfile.integration` / `scripts/integration-test.ps1`) proves
`MAM_BROADCAST_ASSET_SEARCH` against real production-grade
infrastructure: **PostgreSQL 16** (repository backend) and
**Elasticsearch 8.x** (full-text + faceted search backend), per the
Technical Architecture Document (2.2.1) / Product Vision (Pillar 4)
requirement. It is kept as a separate compose file rather than folded
into `compose.smoke.yaml` so the fast, dependency-light smoke suite
(Upload/Workflow/Archive/JWT auth) is unaffected by this heavier stack.
**Not for production** — no TLS, no auth on Elasticsearch, disposable
volumes, throwaway credentials.

### Topology

```
                 depends_on: service_healthy
  ┌──────────┐  ────────────────────────────►  ┌───────────────┐
  │ postgres │                                 │ mam-integration│
  │  :5432   │ ◄──────── JDBC ────────────────│    -nuxeo      │
  └──────────┘                                 │   :8080→8081   │
                                                └───────┬───────┘
  ┌──────────────┐  depends_on: service_healthy        │
  │elasticsearch │ ◄────────────────────────────────────┘
  │    :9200     │        REST (search-client-opensearch1)
  └──────────────┘
```

- **postgres** (`postgres:16-alpine`) — repository backend. Health
  checked via `pg_isready`. Persistent volume `mam-integration-pg-data`.
- **elasticsearch** (`docker.elastic.co/elasticsearch/elasticsearch:8.15.3`)
  — single-node (`discovery.type=single-node`), security disabled
  (`xpack.security.enabled=false`, `xpack.security.http.ssl.enabled=false`)
  specifically to avoid auth/cert complexity in this disposable test
  harness. Health checked via `_cluster/health` (green/yellow). Persistent
  volume `mam-integration-es-data`.
- **nuxeo** (`Dockerfile.integration`, built from the same base image as
  the smoke stack) — depends on both services via
  `depends_on: condition: service_healthy`, which is what actually
  satisfies the "wait for Postgres and Elasticsearch to be healthy
  before starting Nuxeo" requirement (compose blocks the dependent
  container's start until the healthcheck passes; no extra polling
  needed for those two services in the test script). Installs, in
  order: the vendored `nuxeo-search-client-opensearch1-package` (so
  its ES REST search client and `opensearch1-search-client` nuxeo.conf
  template exist), then `mam-package`.

### The vendored search-client package

`nuxeo-search-client-opensearch1` (Nuxeo's ES/OpenSearch search client)
is not bundled in the base `nuxeo/nuxeo:2025.x` Docker image — it is an
optional marketplace package. Since `D:\MaM\nuxeo` must never be
modified, it is built from that source checkout as a **read-only build
step** (compiling and packaging only, no source files touched) and the
resulting ZIP is vendored into `mam-platform/vendor/` (gitignored — 24MB,
build-host-specific):

```powershell
cd D:\MaM\nuxeo
mvn -Pdistrib -pl packages/nuxeo-search-client-opensearch1-package `
    -am -DskipTests install
Copy-Item packages/nuxeo-search-client-opensearch1-package/target/nuxeo-search-client-opensearch1-package-2025.21-SNAPSHOT.zip `
    D:\MaM\mam-platform\vendor\
```

This is a full reactor build (`-am` pulls in ~200 upstream modules on a
cold `.m2` cache) and can take 20–25 minutes the first time; subsequent
runs are fast once `~/.m2` is warm. `scripts/integration-test.ps1` fails
fast with the exact command above if the vendored zip is missing.

**Important implementation detail:** the search-client package's own
`install.xml` carries a `<config addtemplate="opensearch1-search-client" />`
directive, but that only takes effect against an *already-existing*
`nuxeo.conf` — which does not exist yet when `install-packages.sh` runs
at Docker **build** time (the base image only moves its bundled
`bin/nuxeo.conf` into place on the container's **first boot**). Because
of this, `Dockerfile.integration`'s init script explicitly sets
`nuxeo.templates=default,opensearch1-search-client,postgresql` itself
rather than relying on the package's own directive.

### Environment

Copy `.env.integration.example` to `.env.integration` (git-ignored) and
adjust if needed — same convention as `.env.smoke`. Key variables:
`INTEGRATION_HOST_PORT` (default `8081`, deliberately different from
the smoke stack's `8080` so both can run side by side), `PG_DB`/`PG_USER`/
`PG_PASSWORD`, `ES_INDEX_NAME`.

### Run

```powershell
scripts\integration-test.ps1
```

The script:

1. Verifies the base image, `mam-package` ZIP, and the vendored
   search-client and Amazon S3 package ZIPs are present.
2. `docker compose up -d` — blocks until Postgres, Elasticsearch, and
   MinIO report healthy and the `minio-init` bucket-creation container
   completes successfully (compose's own dependency gate), then starts
   Nuxeo.
3. Waits for Nuxeo's own `/runningstatus`.
4. Verifies `BroadcastAsset` is registered against the PostgreSQL-backed
   repository.
5. **Full-text search:** creates a `BroadcastAsset` with a unique token
   in `dc:title`, polls `MAM_BROADCAST_ASSET_SEARCH?q=<token>` until
   Elasticsearch has indexed it (asynchronous indexing lag), and asserts
   it comes back. This step cannot pass against the H2-backed smoke
   stack — see the caveat above — so a pass here is direct proof
   Elasticsearch is doing the work.
6. **Faceted filtering + aggregations:** creates three `BroadcastAsset`s
   with distinct `broadcast:storyType` values, queries
   `MAM_BROADCAST_ASSET_SEARCH?storyType=breaking`, asserts only the
   matching asset comes back (not an accidental match-everything), and
   asserts the `storyType_agg` aggregation bucket is present and
   non-empty.
7. **S3 (MinIO) binary storage:** generates an FFmpeg fixture, uploads
   it through Batch Upload, creates a `BroadcastVideo`, and confirms the
   MinIO `mam-blobs` bucket's object count increased (via `mc ls -r` run
   inside the `minio` container) — direct proof the blob is physically
   stored in S3-compatible object storage, not the local filesystem.
   Then polls `vid:transcodedVideos` and fetches the thumbnail
   rendition, proving Nuxeo/FFmpeg can read the original blob back out
   of MinIO to process it.
8. Cleans up all created test documents, then `docker compose down`
   (volumes preserved).

### Cleanup / reset to a clean slate

Named volumes (`mam-integration-pg-data`, `mam-integration-es-data`,
`mam-integration-minio-data`, `mam-integration-nuxeo-data`,
`mam-integration-nuxeo-logs`, `mam-integration-nuxeo-tmp`) are
**preserved** across `docker compose down` runs, matching the smoke
stack's convention — this avoids reprovisioning Postgres/Elasticsearch/
MinIO from scratch on every run. To force a fully clean slate (fresh
repository init, fresh ES index, empty S3 bucket):

```powershell
docker compose --env-file .env.integration -f compose.integration.yaml down -v
```

or remove the named volumes individually with `docker volume rm`
(add `mam-integration-minio-data` if you only want to reset the S3
bucket contents and keep Postgres/Elasticsearch data). The built images
(`mam-platform/nuxeo-integration:local`) and the vendored package zips
are not volumes and are not affected by either command.

### On failure

The script writes Nuxeo, Postgres, and Elasticsearch container logs into
`logs/integration-{nuxeo,postgres,elasticsearch}-<timestamp>.log`, stops
the stack (volumes preserved), and exits non-zero. MinIO's own state can
be inspected afterwards with `docker logs mam-integration-minio` since
the container is not removed until `docker compose down` runs as part
of that same failure path.

### S3 (MinIO) binary storage configuration

Per the Technical Architecture Document (2.4.1 Binary Storage),
production deployments must store binary blobs in S3-compatible object
storage rather than the container's local filesystem, to enable
scalability and future cold-storage tiering. This integration stack
adds a **MinIO** service (`minio/minio`, single-node, no TLS — **not
for production**) plus a one-shot `minio-init` container that creates
the `mam-blobs` bucket (MinIO does not auto-create buckets) using the
bundled `mc` client before Nuxeo starts.

Nuxeo is configured to use the stock `S3BlobProvider` blob manager
pointed at MinIO's S3-compatible API, via `nuxeo.conf` properties set
by `Dockerfile.integration`'s init script (same idempotent
`/docker-entrypoint-initnuxeo.d` pattern used for PostgreSQL/
Elasticsearch above):

```
nuxeo.core.binarymanager=org.nuxeo.ecm.blob.s3.S3BlobProvider
nuxeo.s3storage.bucket=mam-blobs
nuxeo.s3storage.awsid=<MINIO_ROOT_USER>
nuxeo.s3storage.awssecret=<MINIO_ROOT_PASSWORD>
nuxeo.s3storage.region=us-east-1
nuxeo.s3storage.endpoint=http://minio:9000
nuxeo.s3storage.pathstyleaccess=true
```

`pathstyleaccess=true` is required because MinIO (unlike real AWS S3)
does not resolve buckets via virtual-hosted-style DNS
(`bucket.endpoint`) — it only supports path-style URLs
(`endpoint/bucket`). No MAM/Nuxeo Java code changes were needed: MinIO
is fully S3-API-compatible, so the stock `S3BlobProvider` works against
it unmodified, only pointed at a different endpoint.

#### The vendored Amazon S3 package

Like `nuxeo-search-client-opensearch1`, the `org.nuxeo.ecm.blob.s3.S3BlobProvider`
class is **not** present in the base `nuxeo/nuxeo:2025.x` image — it
ships in the optional `nuxeo-amazon-s3-package` marketplace package.
Built the same read-only way from the `D:\MaM\nuxeo` checkout (compiling
and packaging only, no source files touched) and vendored into
`mam-platform/vendor/` (gitignored):

```powershell
$env:JAVA_HOME = "<path to a JDK 21, e.g. C:\Program Files\Zulu\zulu-21>"
cd D:\MaM\nuxeo
& "<path to mvn>" -Pdistrib -pl packages/nuxeo-amazon-s3-package `
    -am -DskipTests install
Copy-Item packages/nuxeo-amazon-s3-package/target/nuxeo-amazon-s3-package-2025.21-SNAPSHOT.zip `
    D:\MaM\mam-platform\vendor\
```

`Dockerfile.integration` installs this package (via
`install-packages.sh --offline`) before `mam-package`, same ordering
rationale as the search-client package: its bundle and `nuxeo.defaults`
template properties must already be active when the S3 blob provider
extension resolves.

### Cold storage configuration (Priority 5)

Per the Product Vision (Pillar 2) and Nuxeo Implementation Plan
(4.5), production must support automated cold-storage tiering (e.g.
AWS Glacier / S3 Glacier). `Dockerfile.integration`'s S3 init script
(`12-mam-s3.sh`) appends the `nuxeo-coldstorage` addon's documented
`nuxeo.conf` properties, pointed at a **second, separate** MinIO
bucket (`mam-blobs-cold`, created by `minio-init` alongside
`mam-blobs`) standing in for AWS Glacier/S3 Cold in this disposable
test harness:

```
nuxeo.coldstorage.bucket=mam-blobs-cold
nuxeo.coldstorage.awsid=<MINIO_ROOT_USER>
nuxeo.coldstorage.awssecret=<MINIO_ROOT_PASSWORD>
nuxeo.coldstorage.endpoint=http://minio:9000
nuxeo.coldstorage.pathstyleaccess=true
nuxeo.coldstorage.numberOfDaysOfAvailability.value.default=0
```

**Important limitation: the `nuxeo-coldstorage` marketplace package
itself is NOT installed in this stack.** Unlike
`nuxeo-search-client-opensearch1` and `nuxeo-amazon-s3-package`, which
both live inside the `D:\MaM\nuxeo` monorepo checkout this project
vendors packages from, `nuxeo-coldstorage` lives in a **separate**
GitHub repository (`github.com/nuxeo/nuxeo-coldstorage`) versioned and
released independently, and its `nuxeo-coldstorage-web` module
requires an `.npmrc` pointing at a **private** `@nuxeo` npm registry
to build. Cloning and building an out-of-tree external repo against
this project's exact internal `2025.21-SNAPSHOT` build, with a
registry credential this environment does not have, is a materially
different and riskier operation than the in-tree package builds used
elsewhere in this repo — so it was not attempted automatically.

The `nuxeo.conf` properties above are inert until that package is
actually installed: no `coldstorage:*` schema, no `ColdStorage` facet,
and no move-to-cold-storage/retrieve-from-cold-storage operations
exist in the running server today. Once a
`nuxeo-coldstorage-package-*.zip` is built (from a checkout of that
repo, against a matching Nuxeo platform version) and vendored into
`mam-platform/vendor/` — the exact same pattern as
`nuxeo-amazon-s3-package` above — three changes activate it:

1. Add a `COPY --chown=900:0 vendor/nuxeo-coldstorage-package-*.zip ...`
   step to `Dockerfile.integration`.
2. Add that path to the `install-packages.sh --offline` argument list,
   installed alongside (order-independent of) the S3 package.
3. Nothing else — the `nuxeo.coldstorage.*` properties are already in
   place and will be picked up immediately.

This project's own `broadcast:archiveState`/`archiveDate`/`archivedBy`/
`restoreDate`/`restoredBy` fields (see the `broadcast` schema section
above) are a deliberately independent, addon-free audit trail for
MAM's own hot/cold business state, enforced by
`ArchiveStateGuardListener`. They do not depend on `nuxeo-coldstorage`
being installed and will continue to work identically whether or not
that addon is ever added; `nuxeo-coldstorage` would additionally move
the actual **binary bytes** to the cold bucket when installed, which
is a distinct, complementary capability.
