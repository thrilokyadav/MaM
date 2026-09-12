/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.core.archive;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.ecm.core.api.Blob;
import org.nuxeo.ecm.core.api.CoreSession;
import org.nuxeo.ecm.core.api.DocumentModel;
import org.nuxeo.ecm.core.api.IdRef;
import org.nuxeo.ecm.core.api.NuxeoException;
import org.nuxeo.ecm.core.work.AbstractWork;

import java.util.Calendar;

/**
 * Background {@link org.nuxeo.ecm.core.work.api.Work} that restores a
 * cold-archived blob back to the hot S3 bucket.
 *
 * <p>Scheduled by {@link MamRestoreOperation}. Runs on the {@code mam-restore}
 * work queue (declared in {@code mam-archive-contrib.xml}) with configurable
 * thread-pool size (default 2).</p>
 *
 * <p>Workflow:</p>
 * <ol>
 *   <li>Opens an unrestricted {@link CoreSession} to load the document.</li>
 *   <li>Reads the blob's digest key from {@code file:content}.</li>
 *   <li>Calls {@link ColdStorageService#restoreBlob(String)} — S3 CopyObject
 *       (cold -&gt; hot) + HeadObject verify + delete from cold.</li>
 *   <li>Stamps {@code broadcast:archiveState = "hot"},
 *       {@code broadcast:restoreDate = now()},
 *       {@code broadcast:restoredBy = "system"} (work runs as system user).</li>
 * </ol>
 *
 * <p>On any exception the work fails and {@code broadcast:archiveState} is
 * reverted to {@code "cold"} so the UI does not get stuck in
 * {@code "restore-pending"} forever.</p>
 */
public class MamRestoreWork extends AbstractWork {

    private static final long serialVersionUID = 1L;

    private static final Logger log = LogManager.getLogger(MamRestoreWork.class);

    private static final String ARCHIVE_STATE_PROP = "broadcast:archiveState";
    private static final String RESTORE_DATE_PROP  = "broadcast:restoreDate";
    private static final String RESTORED_BY_PROP   = "broadcast:restoredBy";

    private final String docId;

    /**
     * @param docId          Nuxeo document UID
     * @param repositoryName Nuxeo repository name (usually "default")
     */
    public MamRestoreWork(String docId, String repositoryName) {
        // AbstractWork id must be stable so WorkManager.IF_NOT_RUNNING_OR_SCHEDULED
        // can deduplicate concurrent restore requests for the same document.
        super("mam-restore-" + docId);
        this.docId = docId;
        setDocument(repositoryName, docId);
    }

    @Override
    public String getTitle() {
        return "MAM Restore Asset [" + docId + "]";
    }

    @Override
    public String getCategory() {
        return MamRestoreOperation.RESTORE_QUEUE;
    }

    @Override
    public void work() {
        log.info("MamRestoreWork: starting restore for doc [{}]", docId);
        openSystemSession();

        String key = null;
        try {
            DocumentModel doc = session.getDocument(new IdRef(docId));

            Blob blob = (Blob) doc.getPropertyValue("file:content");
            if (blob == null) {
                throw new NuxeoException(
                        "MamRestoreWork: doc [" + docId + "] has no primary blob; cannot restore.");
            }
            key = blob.getDigest();
            if (key == null || key.isBlank()) {
                throw new NuxeoException(
                        "MamRestoreWork: blob digest is null for doc [" + docId + "].");
            }

            log.info("MamRestoreWork: restoring blob key=[{}] for doc [{}]", key, docId);

            ColdStorageService coldStorage = new ColdStorageService();
            coldStorage.restoreBlob(key);

            // Stamp success
            doc.setPropertyValue(ARCHIVE_STATE_PROP, "hot");
            doc.setPropertyValue(RESTORE_DATE_PROP,  Calendar.getInstance());
            doc.setPropertyValue(RESTORED_BY_PROP,   "system");
            session.saveDocument(doc);
            session.save();

            log.info("MamRestoreWork: doc [{}] restored to hot storage successfully", docId);

        } catch (Exception e) {
            log.error("MamRestoreWork: restore FAILED for doc [{}] key=[{}]; reverting to 'cold'",
                    docId, key, e);
            // Revert archiveState so the user can retry.
            try {
                DocumentModel doc = session.getDocument(new IdRef(docId));
                doc.setPropertyValue(ARCHIVE_STATE_PROP, "cold");
                session.saveDocument(doc);
                session.save();
            } catch (Exception revertEx) {
                log.error("MamRestoreWork: also failed to revert archiveState for doc [{}]",
                        docId, revertEx);
            }
            throw new NuxeoException("MamRestoreWork failed for doc [" + docId + "]: " + e.getMessage(), e);
        }
    }
}
