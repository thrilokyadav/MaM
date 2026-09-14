/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.core.archive;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.ecm.core.api.Blob;
import org.nuxeo.ecm.core.api.CoreInstance;
import org.nuxeo.ecm.core.api.CoreSession;
import org.nuxeo.ecm.core.api.DocumentModel;
import org.nuxeo.ecm.core.api.DocumentModelList;
import org.nuxeo.ecm.core.api.NuxeoException;
import org.nuxeo.ecm.core.api.repository.RepositoryManager;
import org.nuxeo.runtime.api.Framework;
import org.nuxeo.runtime.model.ComponentContext;
import org.nuxeo.runtime.model.ComponentStartOrders;
import org.nuxeo.runtime.model.DefaultComponent;
import org.nuxeo.runtime.transaction.TransactionHelper;

/**
 * Reconciles any {@code broadcast:archiveState} left stuck in a transient
 * {@code archive-pending} / {@code restore-pending} state, once on every
 * server start.
 *
 * <p>
 * The archive/restore pipeline is asynchronous: {@link MamArchiveOperation}
 * / {@link MamRestoreOperation} stamp a {@code *-pending} state and hand the
 * physical blob move off to a background {@link MamArchiveWork} /
 * {@link MamRestoreWork}, which flips the state to its terminal value
 * ({@code cold} / {@code hot}) on success or reverts it on a caught failure.
 * That revert only runs inside the Work's {@code catch} block, so if the JVM
 * dies (or the Work is evicted from the queue) mid-move, the document is left
 * in {@code archive-pending} / {@code restore-pending} forever and the
 * frontend polls it indefinitely (see {@code AssetDetailPage.tsx}'s
 * archive/restore poll effects). This component is the safety net for exactly
 * that crash window.
 * </p>
 *
 * <p>
 * It runs after {@link ComponentStartOrders#REPOSITORY} (so the repository is
 * available), in its own privileged transaction, and reconciles each stuck
 * document to match the ACTUAL physical blob location in MinIO rather than
 * guessing:
 * </p>
 * <ul>
 * <li>{@code archive-pending}: if the blob is present in the cold bucket the
 * move completed before the crash, so finalize to {@code cold}; otherwise the
 * move had not finished, so revert to {@code hot}.</li>
 * <li>{@code restore-pending}: if the blob is present in the hot bucket the
 * restore completed, so finalize to {@code hot}; otherwise revert to
 * {@code cold}.</li>
 * </ul>
 *
 * <p>
 * This is deliberately conservative: it only ever sets a terminal state that
 * agrees with where the bytes actually are, so it can never point a document
 * at a tier that has no blob. It is idempotent (a healthy system has no stuck
 * documents, so it is a no-op) and safe to run on every boot.
 * </p>
 */
public class StuckArchiveStateReconciler extends DefaultComponent {

    private static final Logger log = LogManager.getLogger(StuckArchiveStateReconciler.class);

    protected static final String ARCHIVE_STATE_PROP = "broadcast:archiveState";

    protected static final String ARCHIVE_PENDING = "archive-pending";

    protected static final String RESTORE_PENDING = "restore-pending";

    protected static final String COLD_STATE = "cold";

    protected static final String HOT_STATE = "hot";

    @Override
    public int getApplicationStartedOrder() {
        // After the repository is up; same window the DefaultAclProvisioner
        // uses. No ordering dependency between the two.
        return ComponentStartOrders.REPOSITORY + 20;
    }

    @Override
    public void start(ComponentContext context) {
        // CoreSession usage requires an active transaction; none is open at
        // component-start time, so open one around the reconcile pass.
        Framework.doPrivileged(() -> TransactionHelper.runInTransaction(this::reconcileStuckStates));
    }

    protected void reconcileStuckStates() {
        RepositoryManager repositoryManager = Framework.getService(RepositoryManager.class);
        if (repositoryManager == null) {
            log.warn("RepositoryManager unavailable; skipping stuck archive-state reconciliation");
            return;
        }
        String repositoryName = repositoryManager.getDefaultRepositoryName();
        CoreSession session = CoreInstance.getCoreSessionSystem(repositoryName);

        String nxql = "SELECT * FROM Document WHERE " + ARCHIVE_STATE_PROP + " IN ('" + ARCHIVE_PENDING + "', '"
                + RESTORE_PENDING + "') AND ecm:isVersion = 0 AND ecm:isProxy = 0 AND ecm:isTrashed = 0";
        DocumentModelList stuck;
        try {
            stuck = session.query(nxql);
        } catch (NuxeoException e) {
            log.warn("Stuck archive-state reconciliation query failed; skipping this pass: {}", e.getMessage(), e);
            return;
        }
        if (stuck.isEmpty()) {
            return;
        }

        ColdStorageService coldStorage = new ColdStorageService();
        int reconciled = 0;
        for (DocumentModel doc : stuck) {
            try {
                if (reconcileOne(session, coldStorage, doc)) {
                    reconciled++;
                }
            } catch (RuntimeException e) {
                // Never let one bad document abort the whole pass.
                log.warn("Failed to reconcile stuck archive-state for doc [{}]: {}", doc.getId(), e.getMessage(), e);
            }
        }
        if (reconciled > 0) {
            session.save();
            log.warn("Reconciled {} document(s) stuck in a transient archive-state after an unclean shutdown",
                    reconciled);
        }
    }

    /**
     * Reconciles a single stuck document to the terminal state that matches
     * where its blob physically is. Returns {@code true} if it changed the
     * document (so the caller knows whether a {@code session.save()} is
     * needed).
     */
    protected boolean reconcileOne(CoreSession session, ColdStorageService coldStorage, DocumentModel doc) {
        String state = String.valueOf(doc.getPropertyValue(ARCHIVE_STATE_PROP));
        Blob blob = (Blob) doc.getPropertyValue("file:content");
        String key = blob == null ? null : blob.getDigest();
        if (key == null || key.isBlank()) {
            // No resolvable blob: fall back to the live tier so the UI is not
            // stuck; there is nothing to physically verify.
            log.warn("Stuck doc [{}] in state [{}] has no resolvable blob digest; setting to hot", doc.getId(), state);
            return finalizeState(session, doc, HOT_STATE);
        }

        String target;
        if (ARCHIVE_PENDING.equals(state)) {
            // Completed iff the blob made it to cold.
            target = coldStorage.existsInCold(key) ? COLD_STATE : HOT_STATE;
        } else if (RESTORE_PENDING.equals(state)) {
            // Completed iff the blob made it back to hot.
            target = coldStorage.existsInHot(key) ? HOT_STATE : COLD_STATE;
        } else {
            return false;
        }

        log.warn("Reconciling stuck doc [{}]: state [{}] -> [{}] (blob key [{}])", doc.getId(), state, target, key);
        return finalizeState(session, doc, target);
    }

    private boolean finalizeState(CoreSession session, DocumentModel doc, String target) {
        doc.setPropertyValue(ARCHIVE_STATE_PROP, target);
        session.saveDocument(doc);
        return true;
    }

}
