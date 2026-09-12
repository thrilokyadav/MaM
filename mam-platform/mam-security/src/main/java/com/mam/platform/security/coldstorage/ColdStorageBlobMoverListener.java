/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.security.coldstorage;

import java.io.Serializable;
import java.util.Objects;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.ecm.core.api.DocumentModel;
import org.nuxeo.ecm.core.api.event.CoreEventConstants;
import org.nuxeo.ecm.core.event.Event;
import org.nuxeo.ecm.core.event.EventListener;
import org.nuxeo.ecm.core.event.impl.DocumentEventContext;
import org.nuxeo.ecm.core.work.api.WorkManager;
import org.nuxeo.runtime.api.Framework;

/**
 * Detects a {@code broadcast:archiveState} hot&lt;-&gt;cold transition and
 * schedules the actual blob relocation as a {@link ColdStorageBlobMoveWork}
 * background task, deferred until after the enclosing transaction commits.
 *
 * <p>
 * Deliberately separate from {@code ArchiveStateGuardListener}: that
 * listener is a synchronous {@code beforeDocumentModification} guard whose
 * only job is authorization (mam-archivists/Administrator only) and
 * stamping the {@code archiveDate}/{@code archivedBy}/{@code restoreDate}/
 * {@code restoredBy} audit fields, in the SAME transaction as the state
 * change. This listener instead reacts to {@code documentModified}, which
 * only fires once the save has proceeded past every
 * {@code beforeDocumentModification} listener without one of them
 * rejecting it -- so this listener never runs at all if the guard rejected
 * the change, and never needs to perform any authorization checks of its
 * own. It is registered synchronous/non-postCommit like the guard (see the
 * XML contribution) because scheduling a background Work is itself a cheap,
 * non-blocking call; the actual wait for the enclosing transaction to
 * commit is achieved separately, by scheduling the Work with
 * {@code afterCommit=true} below -- the Work body itself only starts once
 * the transaction that changed {@code archiveState} has actually
 * committed.
 * </p>
 *
 * <p>
 * The heavy lifting (S3 cross-bucket copy/verify/delete against MinIO) is
 * intentionally NOT done inline here: this listener only decides WHETHER a
 * physical move is needed and hands off to {@link ColdStorageBlobMoveWork},
 * so the REST call that flipped {@code archiveState} returns immediately
 * (Non-Negotiable Requirement 4) and a slow/unavailable MinIO endpoint can
 * never block or fail a metadata-only save.
 * </p>
 */
public class ColdStorageBlobMoverListener implements EventListener {

    private static final Logger log = LogManager.getLogger(ColdStorageBlobMoverListener.class);

    protected static final String ARCHIVE_STATE_PROPERTY = "broadcast:archiveState";

    protected static final String COLD_STATE = "cold";

    protected static final String HOT_STATE = "hot";

    @Override
    public void handleEvent(Event event) {
        if (!(event.getContext() instanceof DocumentEventContext context)) {
            return;
        }
        DocumentModel doc = context.getSourceDocument();
        if (doc == null || !doc.hasSchema("broadcast") || doc.isProxy() || doc.isVersion()) {
            return;
        }

        DocumentModel previous = (DocumentModel) context.getProperty(CoreEventConstants.PREVIOUS_DOCUMENT_MODEL);
        if (previous == null || !previous.hasSchema("broadcast")) {
            // No previous state to compare against (e.g. document creation) --
            // nothing to move yet.
            return;
        }

        Serializable before = previous.getPropertyValue(ARCHIVE_STATE_PROPERTY);
        Serializable after = doc.getPropertyValue(ARCHIVE_STATE_PROPERTY);
        if (Objects.equals(before, after)) {
            return;
        }

        String direction;
        if (COLD_STATE.equals(after) && !COLD_STATE.equals(before)) {
            direction = ColdStorageBlobMoveWork.DIRECTION_TO_COLD;
        } else if (HOT_STATE.equals(after) && COLD_STATE.equals(before)) {
            direction = ColdStorageBlobMoveWork.DIRECTION_TO_HOT;
        } else {
            // Any other transition (e.g. hot -> warm) does not move the blob
            // between the hot/cold MinIO buckets.
            return;
        }

        // Scheduling failures here must NEVER roll back the archiveState
        // change itself: this listener fires synchronously inside the same
        // transaction as the save (see the XML contribution's rationale),
        // so an uncaught exception here would propagate up through
        // saveDocument and roll back the authorization + audit stamping
        // ArchiveStateGuardListener already committed moments earlier in
        // the SAME transaction -- turning a background-copy problem into a
        // silent metadata-corruption bug. The physical move is a
        // best-effort side effect of a successful, already-authorized
        // state change, not a precondition for it.
        try {
            ColdStorageBlobMoveWork work = new ColdStorageBlobMoveWork(doc.getRepositoryName(), doc.getId(),
                    direction);
            WorkManager workManager = Framework.getService(WorkManager.class);
            // afterCommit=true: the work must not start against the document
            // until the transaction that changed archiveState has actually
            // committed, otherwise the work's own session would not yet see
            // the new state (or could even run against a rolled-back change).
            workManager.schedule(work, true);
        } catch (RuntimeException e) {
            log.error("Failed to schedule cold storage blob move ({}) for document {}: {}. The archiveState "
                    + "change itself was NOT affected; the physical blob move must be retried/investigated "
                    + "separately.", direction, doc.getId(), e.getMessage(), e);
        }
    }

}
