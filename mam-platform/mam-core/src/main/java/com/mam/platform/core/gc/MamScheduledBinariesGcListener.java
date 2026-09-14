/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.core.gc;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.ecm.core.event.Event;
import org.nuxeo.ecm.core.event.EventListener;
import org.nuxeo.ecm.core.work.api.WorkManager;
import org.nuxeo.runtime.api.Framework;

/**
 * Bridges the cron {@code <schedule>} (see {@code mam-gc-contrib.xml}) to the
 * actual GC {@link MamBinariesGarbageCollectionWork}.
 *
 * <p>
 * Nuxeo's scheduler fires a plain event on its cron; it does not run business
 * logic itself. This listener reacts to that event
 * ({@code mamBinariesGarbageCollect}) and schedules the GC Work with
 * {@link WorkManager.Scheduling#IF_NOT_RUNNING_OR_SCHEDULED} so a sweep that
 * runs longer than the cron interval never stacks a second concurrent GC (the
 * Work itself additionally guards on
 * {@code DocumentBlobManager#isBinariesGarbageCollectionInProgress()}).
 * </p>
 */
public class MamScheduledBinariesGcListener implements EventListener {

    private static final Logger log = LogManager.getLogger(MamScheduledBinariesGcListener.class);

    /** Must match the {@code eventId} on the {@code <schedule>} contribution. */
    public static final String EVENT_ID = "mamBinariesGarbageCollect";

    @Override
    public void handleEvent(Event event) {
        if (!EVENT_ID.equals(event.getName())) {
            return;
        }
        WorkManager workManager = Framework.getService(WorkManager.class);
        if (workManager == null) {
            log.warn("MAM binaries GC: WorkManager unavailable; cannot schedule scheduled GC run");
            return;
        }
        log.info("MAM binaries GC: cron fired; scheduling orphaned-binary GC work");
        workManager.schedule(new MamBinariesGarbageCollectionWork(),
                WorkManager.Scheduling.IF_NOT_RUNNING_OR_SCHEDULED);
    }
}
