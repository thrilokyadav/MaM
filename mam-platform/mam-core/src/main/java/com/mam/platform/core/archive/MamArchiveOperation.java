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

import java.util.Calendar;

/**
 * Nuxeo Automation Operation: {@code MAM.ArchiveAsset}.
 *
 * <p>Moves the primary video blob from the hot MinIO bucket to the cold MinIO
 * bucket using {@link ColdStorageService#archiveBlob(String)}, which performs a
 * server-side S3 CopyObject, verifies the copy with HeadObject, and only then
 * removes the hot copy. The blob's content-addressable digest key is identical
 * in both buckets, so Nuxeo's {@code file:content} property continues to resolve
 * the blob without modification — the S3BlobProvider finds it in whichever
 * bucket it resides in.</p>
 *
 * <p>After a successful move the operation stamps:</p>
 * <ul>
 *   <li>{@code broadcast:archiveState = "cold"}</li>
 *   <li>{@code broadcast:archiveDate} = now (UTC)</li>
 *   <li>{@code broadcast:archivedBy} = current principal</li>
 * </ul>
 *
 * <p>Permission check: the Nuxeo server enforces {@code MAM_Archive} / {@code Write}
 * ACL before the operation runs (standard REST 403 if absent). No extra guard is
 * needed here.</p>
 */
@Operation(
    id = MamArchiveOperation.ID,
    category = Constants.CAT_DOCUMENT,
    label = "MAM Archive Asset",
    description = "Moves the primary blob to cold storage (MinIO cold bucket) "
                + "and sets broadcast:archiveState to 'cold'."
)
public class MamArchiveOperation {

    public static final String ID = "MAM.ArchiveAsset";

    private static final Logger log = LogManager.getLogger(MamArchiveOperation.class);

    private static final String ARCHIVE_STATE_PROP = "broadcast:archiveState";
    private static final String ARCHIVE_DATE_PROP  = "broadcast:archiveDate";
    private static final String ARCHIVED_BY_PROP   = "broadcast:archivedBy";

    @Context
    protected CoreSession session;

    @OperationMethod
    public DocumentModel run(DocumentModel doc) {
        String uid = doc.getId();
        log.info("MAM.ArchiveAsset: starting archive for doc [{}] ({})", uid, doc.getTitle());

        // --- Validate current state ---
        String currentState = (String) doc.getPropertyValue(ARCHIVE_STATE_PROP);
        if ("cold".equals(currentState) || "restore-pending".equals(currentState)) {
            throw new NuxeoException(
                    "MAM.ArchiveAsset: doc [" + uid + "] is already in state [" + currentState
                    + "]; archive is only valid from 'hot' or 'warm' state.");
        }

        // --- Resolve blob digest key ---
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

        log.info("MAM.ArchiveAsset: blob digest key=[{}] size={} for doc [{}]",
                key, blob.getLength(), uid);

        // --- Move blob: hot -> cold (copy + verify + delete) ---
        ColdStorageService coldStorage = new ColdStorageService();
        coldStorage.archiveBlob(key);

        // --- Update metadata ---
        doc.setPropertyValue(ARCHIVE_STATE_PROP, "cold");
        doc.setPropertyValue(ARCHIVE_DATE_PROP,  Calendar.getInstance());
        doc.setPropertyValue(ARCHIVED_BY_PROP,   session.getPrincipal().getName());

        DocumentModel saved = session.saveDocument(doc);
        session.save();

        log.info("MAM.ArchiveAsset: doc [{}] successfully archived to cold storage", uid);
        return saved;
    }
}
