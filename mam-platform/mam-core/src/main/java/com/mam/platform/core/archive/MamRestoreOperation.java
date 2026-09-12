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
import org.nuxeo.ecm.core.api.CoreSession;
import org.nuxeo.ecm.core.api.DocumentModel;
import org.nuxeo.ecm.core.api.NuxeoException;
import org.nuxeo.ecm.core.work.api.WorkManager;
import org.nuxeo.runtime.api.Framework;

/**
 * Nuxeo Automation Operation: {@code MAM.RestoreAsset}.
 *
 * <p>Initiates an asynchronous restore of a cold-archived blob back to hot
 * storage. The operation itself returns immediately after:</p>
 * <ol>
 *   <li>Setting {@code broadcast:archiveState = "restore-pending"} so the UI
 *       can show a progress indicator.</li>
 *   <li>Scheduling a {@link MamRestoreWork} instance on Nuxeo's work queue,
 *       which performs the actual S3 CopyObject (cold -&gt; hot) + HeadObject
 *       verify + delete from cold, then stamps {@code archiveState = "hot"}.</li>
 * </ol>
 *
 * <p>The frontend polls {@code broadcast:archiveState} every few seconds until
 * it transitions from {@code "restore-pending"} to {@code "hot"}.</p>
 */
@Operation(
    id = MamRestoreOperation.ID,
    category = Constants.CAT_DOCUMENT,
    label = "MAM Restore Asset",
    description = "Initiates an async restore of a cold-archived blob to hot storage. "
                + "Sets broadcast:archiveState to 'restore-pending' immediately and schedules "
                + "a background MamRestoreWork that transitions it to 'hot' on completion."
)
public class MamRestoreOperation {

    public static final String ID = "MAM.RestoreAsset";

    private static final Logger log = LogManager.getLogger(MamRestoreOperation.class);

    private static final String ARCHIVE_STATE_PROP = "broadcast:archiveState";

    /** WorkManager queue id declared in mam-archive-contrib.xml. */
    public static final String RESTORE_QUEUE = "mam-restore";

    @Context
    protected CoreSession session;

    @OperationMethod
    public DocumentModel run(DocumentModel doc) {
        String uid = doc.getId();
        log.info("MAM.RestoreAsset: initiating restore for doc [{}] ({})", uid, doc.getTitle());

        // --- Validate current state ---
        String currentState = (String) doc.getPropertyValue(ARCHIVE_STATE_PROP);
        if (!"cold".equals(currentState)) {
            throw new NuxeoException(
                    "MAM.RestoreAsset: doc [" + uid + "] is in state [" + currentState
                    + "]; restore is only valid from 'cold' state.");
        }

        // --- Stamp 'restore-pending' so UI reflects in-progress state ---
        doc.setPropertyValue(ARCHIVE_STATE_PROP, "restore-pending");
        DocumentModel saved = session.saveDocument(doc);
        session.save();

        // --- Schedule async work ---
        MamRestoreWork work = new MamRestoreWork(uid, session.getRepositoryName());
        WorkManager wm = Framework.getService(WorkManager.class);
        if (wm == null) {
            throw new NuxeoException("MAM.RestoreAsset: WorkManager service unavailable");
        }
        wm.schedule(work, WorkManager.Scheduling.IF_NOT_RUNNING_OR_SCHEDULED);

        log.info("MAM.RestoreAsset: doc [{}] set to restore-pending; MamRestoreWork scheduled", uid);
        return saved;
    }
}
