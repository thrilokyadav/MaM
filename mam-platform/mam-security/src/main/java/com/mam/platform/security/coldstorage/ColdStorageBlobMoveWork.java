/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.security.coldstorage;

import java.io.Serializable;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.ecm.core.api.Blob;
import org.nuxeo.ecm.core.api.DocumentModel;
import org.nuxeo.ecm.core.api.IdRef;
import org.nuxeo.ecm.core.api.NuxeoException;
import org.nuxeo.ecm.core.blob.ManagedBlob;
import org.nuxeo.ecm.core.work.AbstractWork;

/**
 * Physically relocates a {@code BroadcastAsset}/{@code BroadcastVideo}'s
 * MASTER blob ({@code file:content}) between the hot and cold MinIO
 * buckets, keyed by the blob's content digest -- the exact same key the
 * vendored {@code S3BlobProvider} (see
 * {@code org.nuxeo.ecm.blob.s3.S3BlobStoreConfiguration} /
 * {@code S3BlobKey}) already uses to address the object in the hot bucket,
 * given our deployment has no {@code bucket_prefix} and
 * {@code subDirsDepth=0} configured (see {@code Dockerfile.integration}):
 * with that configuration, {@code S3BlobKey#bucketKey()} reduces to exactly
 * {@code bucketPrefix + key}, i.e. just the raw key, and
 * {@code KeyStrategyDigest} makes that key exactly the blob's digest hex
 * string. Mirroring this exactly is required so that after a restore
 * (cold -> hot) Nuxeo's own {@code S3BlobProvider} resolves the object
 * transparently at the same key it always used, without any change to the
 * document's {@code file:content} property.
 *
 * <p>
 * <b>Deliberately does NOT touch document schema/properties.</b> Only the
 * S3 object is moved; {@code file:content}, {@code vid:transcodedVideos}
 * (proxies), and thumbnail/storyboard renditions are left completely
 * alone, so proxies/thumbnails remain servable straight from the hot
 * bucket regardless of the master's location (Non-Negotiable Requirement
 * 1). This intentionally means the ORIGINAL master becomes
 * non-downloadable through Nuxeo's normal {@code file:content} resolution
 * while archived -- consistent with "physically offloaded to cold storage"
 * -- restoring it (cold -> hot) makes it transparently downloadable again
 * with zero document changes, since the key never changes.
 * </p>
 *
 * @since 1.0.0
 */
public class ColdStorageBlobMoveWork extends AbstractWork {

    private static final long serialVersionUID = 1L;

    private static final Logger log = LogManager.getLogger(ColdStorageBlobMoveWork.class);

    public static final String DIRECTION_TO_COLD = "toCold";

    public static final String DIRECTION_TO_HOT = "toHot";

    protected static final String FILE_CONTENT_PROPERTY = "file:content";

    protected final String direction;

    public ColdStorageBlobMoveWork(String repositoryName, String docId, String direction) {
        super(docId + ":" + direction + ":" + System.nanoTime());
        setDocument(repositoryName, docId);
        this.direction = direction;
    }

    @Override
    public String getCategory() {
        return "coldStorageBlobMove";
    }

    @Override
    public String getTitle() {
        return "Cold storage blob move (%s) for document %s".formatted(direction, docId);
    }

    @Override
    public void work() {
        openSystemSession();
        DocumentModel doc = session.getDocument(new IdRef(docId));
        Serializable rawBlob = doc.getPropertyValue(FILE_CONTENT_PROPERTY);
        if (!(rawBlob instanceof Blob blob)) {
            log.debug("Document {} has no master content ({}); nothing to relocate", docId, FILE_CONTENT_PROPERTY);
            return;
        }
        if (!(blob instanceof ManagedBlob managedBlob)) {
            throw new NuxeoException(
                    "Master content of document %s is not a ManagedBlob; cannot compute its S3 key".formatted(docId));
        }
        String key = ColdStorageS3Mover.getObjectKey(managedBlob);
        ColdStorageS3Mover mover = ColdStorageS3Mover.get();
        if (DIRECTION_TO_COLD.equals(direction)) {
            mover.moveHotToCold(key, docId);
        } else {
            mover.moveColdToHot(key, docId);
        }
    }

}
