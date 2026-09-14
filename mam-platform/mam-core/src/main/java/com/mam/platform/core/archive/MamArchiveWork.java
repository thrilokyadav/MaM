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
 * Background {@link org.nuxeo.ecm.core.work.api.Work} that moves an asset's
 * primary blob from the hot S3 bucket to the cold S3 bucket.
 *
 * <p>Scheduled by {@link MamArchiveOperation}. Runs on the {@code mam-restore}
 * work queue (declared in {@code mam-archive-contrib.xml}) &mdash; the same
 * dedicated, I/O-bound queue used for restores, since a machine archives and
 * restores from the same MinIO link and never needs both to compete for more
 * than a couple of threads.</p>
 *
 * <p>Workflow:</p>
 * <ol>
 *   <li>Opens an unrestricted {@link CoreSession} to load the document.</li>
 *   <li>Reads the blob's digest key from {@code file:content}.</li>
 *   <li>Calls {@link ColdStorageService#archiveBlob(String)} &mdash; S3
 *       CopyObject (hot -&gt; cold) + HeadObject verify + delete from hot.</li>
 *   <li>Stamps {@code broadcast:archiveState = "cold"},
 *       {@code broadcast:archiveDate = now()},
 *       {@code broadcast:archivedBy} (the principal who initiated the
 *       archive, carried over from the operation).</li>
 * </ol>
 *
 * <p>This mirrors {@link MamRestoreWork} exactly, and exists for the same
 * reason: the physical blob move over the network can take many seconds
 * (minutes for a large master), which must never block the HTTP request
 * thread the UI is waiting on. On any exception the work fails and
 * {@code broadcast:archiveState} is reverted to {@code "hot"} so the UI does
 * not get stuck in {@code "archive-pending"} forever and the user can
 * retry.</p>
 */
public class MamArchiveWork extends AbstractWork {

    private static final long serialVersionUID = 1L;

    private static final Logger log = LogManager.getLogger(MamArchiveWork.class);

    private static final String ARCHIVE_STATE_PROP = "broadcast:archiveState";
    private static final String ARCHIVE_DATE_PROP  = "broadcast:archiveDate";
    private static final String ARCHIVED_BY_PROP   = "broadcast:archivedBy";

    private final String docId;

    private final String initiatedBy;

    /**
     * @param docId          Nuxeo document UID
     * @param repositoryName Nuxeo repository name (usually "default")
     * @param initiatedBy    principal name that requested the archive (stamped
     *                       into {@code broadcast:archivedBy} on success)
     */
    public MamArchiveWork(String docId, String repositoryName, String initiatedBy) {
        // AbstractWork id must be stable so WorkManager.IF_NOT_RUNNING_OR_SCHEDULED
        // can deduplicate concurrent archive requests for the same document.
        super("mam-archive-" + docId);
        this.docId = docId;
        this.initiatedBy = initiatedBy;
        setDocument(repositoryName, docId);
    }

    @Override
    public String getTitle() {
        return "MAM Archive Asset [" + docId + "]";
    }

    @Override
    public String getCategory() {
        return MamRestoreOperation.RESTORE_QUEUE;
    }

    @Override
    public void work() {
        log.info("MamArchiveWork: starting archive for doc [{}]", docId);
        openSystemSession();

        String key = null;
        try {
            DocumentModel doc = session.getDocument(new IdRef(docId));

            Blob blob = (Blob) doc.getPropertyValue("file:content");
            if (blob == null) {
                throw new NuxeoException(
                        "MamArchiveWork: doc [" + docId + "] has no primary blob; cannot archive.");
            }
            key = blob.getDigest();
            if (key == null || key.isBlank()) {
                throw new NuxeoException(
                        "MamArchiveWork: blob digest is null for doc [" + docId + "].");
            }

            log.info("MamArchiveWork: archiving blob key=[{}] size={} for doc [{}]",
                    key, blob.getLength(), docId);

            ColdStorageService coldStorage = new ColdStorageService();
            // Always copy+verify to cold first (safe, idempotent).
            coldStorage.copyHotToCold(key);

            // Content-addressable dedup: one physical blob can back several
            // documents. Only remove the HOT copy if no OTHER document still
            // needs this same blob in hot storage, otherwise we would break
            // those documents. A document "needs it in hot" if it shares this
            // digest and is not itself cold/archive-pending (i.e. its blob is
            // expected to be available in the hot bucket).
            if (otherDocsNeedBlobInHot(key)) {
                log.info("MamArchiveWork: blob [{}] is still referenced by another hot document; "
                        + "keeping hot copy (dedup-safe). Doc [{}] marked cold.", key, docId);
            } else {
                coldStorage.deleteFromHot(key);
            }

            // Stamp success
            doc.setPropertyValue(ARCHIVE_STATE_PROP, "cold");
            doc.setPropertyValue(ARCHIVE_DATE_PROP,  Calendar.getInstance());
            doc.setPropertyValue(ARCHIVED_BY_PROP,   initiatedBy != null ? initiatedBy : "system");
            session.saveDocument(doc);
            session.save();

            log.info("MamArchiveWork: doc [{}] archived to cold storage successfully", docId);

        } catch (Exception e) {
            log.error("MamArchiveWork: archive FAILED for doc [{}] key=[{}]; reverting to 'hot'",
                    docId, key, e);
            // Revert archiveState so the user can retry.
            try {
                DocumentModel doc = session.getDocument(new IdRef(docId));
                doc.setPropertyValue(ARCHIVE_STATE_PROP, "hot");
                session.saveDocument(doc);
                session.save();
            } catch (Exception revertEx) {
                log.error("MamArchiveWork: also failed to revert archiveState for doc [{}]",
                        docId, revertEx);
            }
            throw new NuxeoException("MamArchiveWork failed for doc [" + docId + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Whether any document OTHER than the one being archived still needs the
     * blob {@code key} available in HOT storage. A document needs it in hot if
     * it shares the same {@code file:content} digest and its
     * {@code broadcast:archiveState} is not {@code cold}/{@code archive-pending}
     * (a null/empty/hot/warm/restore-pending state all imply the blob should
     * be present in the hot bucket). If any such document exists, deleting the
     * hot copy would break it, so the archive must keep the hot copy in place.
     */
    protected boolean otherDocsNeedBlobInHot(String key) {
        // NXQL string literals: escape single quotes in the digest defensively
        // (digests are hex, so this is belt-and-suspenders).
        String safeKey = key.replace("'", "''");
        String nxql = "SELECT * FROM Document WHERE content/data = '" + safeKey + "'"
                + " AND ecm:isVersion = 0 AND ecm:isProxy = 0 AND ecm:isTrashed = 0"
                + " AND ecm:uuid <> '" + docId + "'"
                + " AND (broadcast:archiveState IS NULL"
                + " OR broadcast:archiveState NOT IN ('cold', 'archive-pending'))";
        try {
            return !session.query(nxql).isEmpty();
        } catch (RuntimeException e) {
            // If the reference check itself fails, err on the side of NOT
            // deleting the hot copy — keeping an extra copy wastes space but
            // never loses data.
            log.warn("MamArchiveWork: dedup reference check failed for blob [{}]; keeping hot copy "
                    + "as a precaution: {}", key, e.getMessage());
            return true;
        }
    }
}
