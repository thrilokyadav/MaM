/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.core.gc;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.ecm.core.blob.DocumentBlobManager;
import org.nuxeo.ecm.core.blob.binary.BinaryManagerStatus;
import org.nuxeo.ecm.core.work.AbstractWork;
import org.nuxeo.runtime.api.Framework;

/**
 * Background {@link org.nuxeo.ecm.core.work.api.Work} that runs Nuxeo's
 * orphaned-binary garbage collection: it deletes every blob in the storage
 * backend (the {@code mam-blobs} / {@code mam-blobs-cold} MinIO buckets, via
 * the S3 blob provider) that is no longer referenced by any document, so
 * space from deleted/emptied-from-trash assets is actually reclaimed.
 *
 * <p>
 * Nuxeo does NOT delete a blob when its document is deleted &mdash; blobs are
 * content-addressable and may be shared by several documents (dedup), so the
 * only safe time to remove one is a mark-and-sweep that has checked every
 * document reference. That sweep is exactly what
 * {@link DocumentBlobManager#garbageCollectBinaries(boolean)} performs. This
 * Work is what {@link MamScheduledBinariesGcListener} schedules on a cron, and
 * it can also be scheduled on demand.
 * </p>
 *
 * <p>
 * Runs as its own {@link AbstractWork} (rather than inline on the scheduler's
 * quartz thread) because a full sweep of a large library is I/O-bound and can
 * take a while; doing it as a Work keeps it observable in the Admin Center's
 * work queues and off the scheduler thread. It is guarded against overlapping
 * runs via {@link DocumentBlobManager#isBinariesGarbageCollectionInProgress()},
 * so a slow sweep that outlasts the cron interval never stacks a second
 * concurrent GC.
 * </p>
 *
 * <p>
 * The delete flag is {@code true}: this actually removes the orphaned blobs.
 * Nuxeo's GC is safe with concurrent writes &mdash; the provider's collector
 * only sweeps blobs that existed before the mark phase began, so a blob being
 * uploaded right now is never collected mid-flight.
 * </p>
 */
public class MamBinariesGarbageCollectionWork extends AbstractWork {

    private static final long serialVersionUID = 1L;

    private static final Logger log = LogManager.getLogger(MamBinariesGarbageCollectionWork.class);

    public static final String CATEGORY = "mamBinariesGC";

    /** Stable id so WorkManager can deduplicate concurrent GC schedules. */
    public static final String WORK_ID = "mam-binaries-gc";

    public MamBinariesGarbageCollectionWork() {
        super(WORK_ID);
    }

    @Override
    public String getTitle() {
        return "MAM Orphaned Binaries Garbage Collection";
    }

    @Override
    public String getCategory() {
        return CATEGORY;
    }

    @Override
    public void work() {
        DocumentBlobManager blobManager = Framework.getService(DocumentBlobManager.class);
        if (blobManager == null) {
            log.warn("MAM binaries GC: DocumentBlobManager unavailable; skipping");
            return;
        }
        if (blobManager.isBinariesGarbageCollectionInProgress()) {
            log.info("MAM binaries GC: a garbage collection is already in progress; skipping this run");
            return;
        }

        setStatus("Collecting orphaned binaries");
        long start = System.currentTimeMillis();
        log.info("MAM binaries GC: starting orphaned-binary sweep (delete=true)");
        try {
            BinaryManagerStatus status = blobManager.garbageCollectBinaries(true);
            long elapsedMs = System.currentTimeMillis() - start;
            log.info("MAM binaries GC: complete in {} ms. Examined GC size={} bytes / {} binaries; "
                    + "DELETED {} orphaned binaries reclaiming {} bytes.", elapsedMs, status.getSizeBinaries(),
                    status.getNumBinaries(), status.getNumBinariesGC(), status.getSizeBinariesGC());
        } catch (RuntimeException e) {
            log.error("MAM binaries GC: garbage collection failed: {}", e.getMessage(), e);
            throw e;
        }
        setStatus("Done");
    }
}
