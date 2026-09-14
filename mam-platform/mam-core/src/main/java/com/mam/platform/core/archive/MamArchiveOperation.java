/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.core.archive;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.ecm.automation.core.Constants;
import org.nuxeo.ecm.automation.core.annotations.Context;
import org.nuxeo.ecm.automation.core.annotations.Operation;
import org.nuxeo.ecm.automation.core.annotations.OperationMethod;
import org.nuxeo.ecm.core.api.Blob;
import org.nuxeo.ecm.core.api.CoreSession;
import org.nuxeo.ecm.core.api.DocumentModel;
import org.nuxeo.ecm.core.api.NuxeoException;
import org.nuxeo.ecm.core.work.api.WorkManager;
import org.nuxeo.runtime.api.Framework;

/**
 * Nuxeo Automation Operation: {@code MAM.ArchiveAsset}.
 *
 * <p>Initiates an asynchronous move of the primary video blob from the hot
 * MinIO bucket to the cold MinIO bucket. The operation itself returns
 * immediately after:</p>
 * <ol>
 *   <li>Validating the asset is archivable (has a blob with a digest and is
 *       not already cold / pending).</li>
 *   <li>Setting {@code broadcast:archiveState = "archive-pending"} so the UI
 *       can show a progress indicator.</li>
 *   <li>Scheduling a {@link MamArchiveWork} instance on the {@code mam-restore}
 *       work queue, which performs the actual S3 CopyObject (hot -&gt; cold) +
 *       HeadObject verify + delete from hot, then stamps
 *       {@code archiveState = "cold"}, {@code archiveDate} and
 *       {@code archivedBy}.</li>
 * </ol>
 *
 * <p>The blob's content-addressable digest key is identical in both buckets,
 * so Nuxeo's {@code file:content} property continues to resolve the blob
 * without modification — the S3BlobProvider finds it in whichever bucket it
 * resides in.</p>
 *
 * <p>This is intentionally async (mirroring {@link MamRestoreOperation}): a
 * large master blob's server-side copy on MinIO can take far longer than the
 * HTTP request/socket read timeout, so running it inline in the request thread
 * made the Archive button hang and then error with "Read timed out". The
 * frontend polls {@code broadcast:archiveState} every few seconds until it
 * transitions from {@code "archive-pending"} to {@code "cold"} (or back to
 * {@code "hot"} if the move failed).</p>
 *
 * <p>Permission check: the Nuxeo server enforces {@code MAM_Archive} / {@code Write}
 * ACL before the operation runs (standard REST 403 if absent), and
 * {@code ArchiveStateGuardListener} additionally restricts changes to
 * {@code broadcast:archiveState} to Administrator / {@code mam-archivists}.</p>
 */
@Operation(
    id = MamArchiveOperation.ID,
    category = Constants.CAT_DOCUMENT,
    label = "MAM Archive Asset",
    description = "Initiates an async move of the primary blob to cold storage "
                + "(MinIO cold bucket). Sets broadcast:archiveState to "
                + "'archive-pending' immediately and schedules a background "
                + "MamArchiveWork that transitions it to 'cold' on completion."
)
public class MamArchiveOperation {

    public static final String ID = "MAM.ArchiveAsset";

    private static final Logger log = LogManager.getLogger(MamArchiveOperation.class);

    private static final String ARCHIVE_STATE_PROP = "broadcast:archiveState";

    @Context
    protected CoreSession session;

    @OperationMethod
    public DocumentModel run(DocumentModel doc) {
        String uid = doc.getId();
        log.info("MAM.ArchiveAsset: initiating archive for doc [{}] ({})", uid, doc.getTitle());

        // --- Validate current state ---
        String currentState = (String) doc.getPropertyValue(ARCHIVE_STATE_PROP);
        if ("cold".equals(currentState) || "restore-pending".equals(currentState)
                || "archive-pending".equals(currentState)) {
            throw new NuxeoException(
                    "MAM.ArchiveAsset: doc [" + uid + "] is already in state [" + currentState
                    + "]; archive is only valid from 'hot' or 'warm' state.");
        }

        // --- Validate a blob is present up front, so the UI gets an
        //     immediate, clear error rather than the background work failing
        //     silently later. ---
        Blob blob = (Blob) doc.getPropertyValue("file:content");
        if (blob == null) {
            throw new NuxeoException(
                    "MAM.ArchiveAsset: doc [" + uid + "] has no primary blob (file:content is null). "
                    + "Cannot archive a document without a binary.");
        }
        String key = blob.getDigest();
        if (key == null || key.isBlank()) {
            throw new NuxeoException(
                    "MAM.ArchiveAsset: blob digest is null for doc [" + uid + "]. "
                    + "Ensure the S3BlobProvider has computed a digest for this blob.");
        }

        // --- Stamp 'archive-pending' so the UI reflects in-progress state ---
        // The physical hot->cold blob copy can take many seconds (minutes for
        // a large master) over the MinIO/S3 link, which must NOT block the
        // HTTP request thread the UI is awaiting. This mirrors
        // MAM.RestoreAsset: set an immediate pending state, schedule the
        // actual move as a background Work, and return right away. The
        // frontend polls broadcast:archiveState until it leaves
        // 'archive-pending' (-> 'cold' on success, or reverts to 'hot' on
        // failure).
        doc.setPropertyValue(ARCHIVE_STATE_PROP, "archive-pending");
        DocumentModel saved = session.saveDocument(doc);
        session.save();

        // --- Schedule async work ---
        MamArchiveWork work = new MamArchiveWork(uid, session.getRepositoryName(),
                session.getPrincipal().getName());
        WorkManager wm = Framework.getService(WorkManager.class);
        if (wm == null) {
            throw new NuxeoException("MAM.ArchiveAsset: WorkManager service unavailable");
        }
        wm.schedule(work, WorkManager.Scheduling.IF_NOT_RUNNING_OR_SCHEDULED);

        log.info("MAM.ArchiveAsset: doc [{}] set to archive-pending; MamArchiveWork scheduled (blob key=[{}])",
                uid, key);
        return saved;
    }
}
