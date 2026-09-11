# MAM Platform — User Workflow Guides

**Audience:** News Producers, Content Managers/Editors, Media Archivists

This guide walks through the day-to-day workflows for each of the three primary user personas on the MAM Platform. Sign in through your organization's single sign-on (OIDC) — your assigned group membership (`mam-producers`, `mam-editors`, or `mam-archivists`) determines which actions are available to you.

---

## Persona 1: The News Producer (Speed & Publishing)

Producers create and prepare content for editorial review. This role corresponds to membership in the `mam-producers` group.

### Uploading MXF/MP4 Files

1. Navigate to **Upload** in the main navigation.
2. Drag and drop your video file (MXF or MP4) onto the upload area, or use the file picker.
3. The platform uploads your file in a batch session and creates a new asset once the upload completes. Depending on the content, the system creates either a `BroadcastVideo` (for video files, which get proxies, thumbnails, and storyboards) or a general `BroadcastAsset` (for other file types such as scripts or stills).
4. While the file uploads, you can begin entering initial metadata — the platform pre-fills basic descriptive fields, which you can refine afterward on the asset's detail page.

### Viewing Proxies and Editing Metadata

1. Once your asset is created, open it from the **Upload** confirmation or by finding it on the **Assets** search page.
2. On the asset detail page, the playback proxy is available in the built-in video player as soon as Nuxeo finishes generating it (this happens automatically in the background after upload — large masters may take a few minutes).
3. Use the editable metadata fields to complete the record. Key fields include:
   - **Editorial fields**: `slug`, `storyType`, `editorialStatus`
   - **Broadcast fields**: `programme`, `episode`, `bureau`, `airDate`, `embargoUntil`, `rightsHolder`, `rightsTerritory`, `rightsStart`, `rightsEnd`
4. Save your changes. Metadata edits are tracked and versioned automatically.

### Submitting for Editorial Review

1. When the asset is ready for review, use the **Submit to Editorial** action on the asset detail page (or the Review Queue, if visible to you).
2. This starts the `MAM Editorial Approval` workflow on the asset. The asset's `editorialStatus` moves from `draft` to `qc` (Quality Control), and it is assigned to the `mam-editors` group for review.
3. You will be notified (through the workflow task system) once the asset is approved or rejected. If rejected, the asset returns to your queue with the editor's feedback attached to the task.

---

## Persona 2: The Content Manager / Editor (Governance)

Editors review submitted content for quality and editorial standards. This role corresponds to membership in the `mam-editors` group.

### Using the Review Queue

1. Navigate to **Review** in the main navigation. This shows the Review Queue — every workflow task currently assigned to the `mam-editors` group.
2. Each row shows the asset, its current stage (Quality Control or Editorial Approval), and the actions available to you for that task.
3. Click into an asset from the queue to view its proxy, metadata, and original file details before making a decision.

### Approving or Rejecting Assets and Providing Feedback

The editorial workflow has two review stages that assets pass through in sequence, both assigned to `mam-editors`:

1. **Quality Control (`qc`)**: The first review checkpoint. From here you can:
   - **Submit to Editorial** — advances the asset to the second review stage.
   - **Reject** — sends the asset to a Rejected state; the producer is notified and can revise and resubmit.
2. **Editorial Approval**: The second and final review checkpoint. From here you can:
   - **Approve** — the asset's `editorialStatus` becomes `approved`, making it eligible for archiving.
   - **Reject** — the asset's `editorialStatus` becomes `rejected`.
3. You may also use **Send Back to Draft** where available, to return an asset to the producer for revision without formally rejecting it.
4. When rejecting, provide feedback through the task comment so the producer understands what needs to change before resubmission. All review decisions are recorded as part of the asset's workflow history.

### Downloading Original Files

From the asset detail page, use the download action to retrieve the original uploaded master file (not the proxy) — useful for quality checks that require frame-accurate review of the source material rather than the compressed playback proxy.

---

## Persona 3: The Media Archivist (Organization & Retrieval)

Archivists manage the long-term lifecycle of approved content, including moving assets to cold storage and restoring them. This role corresponds to membership in the `mam-archivists` group.

### Using Global Search and Faceted Filters

1. Navigate to **Assets** to search the full catalog.
2. Enter free-text search terms, or narrow results using the faceted filters:
   - **Story Type** (`storyType`)
   - **Bureau** (`bureau`)
   - **Editorial Status** (`editorialStatus`)
   - **Archive State** (`archiveState`)
3. Search results are powered by Elasticsearch, so filtering and full-text search remain fast even as the catalog grows.

> Note: full-text search requires the production PostgreSQL + Elasticsearch stack. It is not available on lightweight test/smoke environments backed by an embedded database.

### Transitioning Assets to Cold Storage and Restoring Them

1. Navigate to **Archive**. This view is scoped to assets that have completed editorial approval (`editorialStatus = approved`) — assets still in draft or review are not shown here, since only finished, approved content should be archived.
2. Filter by story type or current archive state to find the assets you want to act on.
3. Use **Archive** to move an eligible asset to cold storage. Use **Restore** to bring an archived asset back to active (hot) storage.
4. **This action is server-enforced**: only members of `mam-archivists` (or Administrators) can successfully change an asset's archive state. If you attempt this without the correct group membership, the platform rejects the request — this is enforced by the server itself, not just hidden in the UI, so it cannot be bypassed by calling the API directly.

### Understanding the Audit Trail

Every archive and restore action is automatically and immutably recorded — nobody, including administrators, can set these fields manually:

- **`archiveDate`** and **`archivedBy`** — stamped automatically the moment an asset is moved to cold storage (`archiveState = cold`), recording when and by whom.
- **`restoreDate`** and **`restoredBy`** — stamped automatically the moment an asset is restored to active storage (`archiveState = hot`), recording when and by whom.

This audit trail exists specifically to give the organization a defensible, tamper-resistant record of who archived or restored any piece of content and when — important for compliance and chain-of-custody requirements in broadcast operations.

---
*For system administration and deployment operations, see `ADMIN_GUIDE.md`. For developer/API integration details, see `API_OVERVIEW.md`.*
