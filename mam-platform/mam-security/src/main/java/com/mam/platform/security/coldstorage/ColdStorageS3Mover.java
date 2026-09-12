/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.security.coldstorage;

import java.net.URI;

import org.apache.commons.lang3.StringUtils;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.ecm.core.api.NuxeoException;
import org.nuxeo.ecm.core.blob.ManagedBlob;
import org.nuxeo.runtime.api.Framework;

import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.AwsCredentialsProvider;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;

/**
 * Physically copies a single S3/MinIO object between the "hot"
 * ({@code mam-blobs}) and "cold" ({@code mam-blobs-cold}) buckets, always
 * following copy -&gt; verify (HeadObject) -&gt; delete (Non-Negotiable
 * Requirement 3): the source object is only ever deleted after the copy has
 * been positively confirmed to exist at the destination, and any failure of
 * the copy or the verification step aborts before any delete is attempted,
 * leaving the original object untouched.
 *
 * <p>
 * Reuses the SAME MinIO connection settings (endpoint/credentials/path-style
 * access) already configured for the hot bucket's {@code S3BlobProvider} by
 * {@code Dockerfile.integration} -- both buckets live on the same MinIO
 * instance, only the bucket NAME differs per direction. The hot bucket name
 * comes from {@code nuxeo.s3storage.bucket} (the same property the S3
 * blob provider itself is configured with); the cold bucket name comes from
 * {@code nuxeo.coldstorage.bucket}, which {@code Dockerfile.integration}
 * already sets to {@code mam-blobs-cold} in anticipation of exactly this
 * kind of usage (its comment there predates this implementation and
 * describes the AWS Glacier addon path, which this class deliberately does
 * NOT use -- only the bucket name property is shared).
 * </p>
 *
 * @since 1.0.0
 */
public final class ColdStorageS3Mover {

    private static final Logger log = LogManager.getLogger(ColdStorageS3Mover.class);

    /** Same property {@code S3BlobStoreConfiguration} reads for the hot bucket's own name. */
    public static final String HOT_BUCKET_PROPERTY = "nuxeo.s3storage.bucket";

    /** Cold-bucket name; already populated in nuxeo.conf by Dockerfile.integration. */
    public static final String COLD_BUCKET_PROPERTY = "nuxeo.coldstorage.bucket";

    public static final String ENDPOINT_PROPERTY = "nuxeo.s3storage.endpoint";

    public static final String AWS_ID_PROPERTY = "nuxeo.s3storage.awsid";

    public static final String AWS_SECRET_PROPERTY = "nuxeo.s3storage.awssecret";

    public static final String PATH_STYLE_PROPERTY = "nuxeo.s3storage.pathstyleaccess";

    public static final String REGION_PROPERTY = "nuxeo.s3storage.region";

    private static volatile ColdStorageS3Mover instance;

    protected final S3Client s3;

    protected final String hotBucket;

    protected final String coldBucket;

    protected ColdStorageS3Mover() {
        hotBucket = requireProperty(HOT_BUCKET_PROPERTY);
        coldBucket = requireProperty(COLD_BUCKET_PROPERTY);
        String endpoint = Framework.getProperty(ENDPOINT_PROPERTY);
        String awsId = Framework.getProperty(AWS_ID_PROPERTY);
        String awsSecret = Framework.getProperty(AWS_SECRET_PROPERTY);
        boolean pathStyle = Boolean.parseBoolean(Framework.getProperty(PATH_STYLE_PROPERTY, "false"));
        String region = Framework.getProperty(REGION_PROPERTY, "us-east-1");

        AwsCredentialsProvider credentialsProvider;
        if (StringUtils.isNotBlank(awsId) && StringUtils.isNotBlank(awsSecret)) {
            credentialsProvider = StaticCredentialsProvider.create(AwsBasicCredentials.create(awsId, awsSecret));
        } else {
            throw new NuxeoException(
                    "Missing %s/%s: cold storage blob mover requires explicit MinIO credentials".formatted(
                            AWS_ID_PROPERTY, AWS_SECRET_PROPERTY));
        }

        var builder = S3Client.builder().region(Region.of(region)).credentialsProvider(credentialsProvider)
                              .forcePathStyle(pathStyle);
        if (StringUtils.isNotBlank(endpoint)) {
            builder.endpointOverride(URI.create(endpoint));
        }
        s3 = builder.build();
        log.info("ColdStorageS3Mover initialized: hotBucket={}, coldBucket={}, endpoint={}", hotBucket, coldBucket,
                endpoint);
    }

    protected static String requireProperty(String name) {
        String value = Framework.getProperty(name);
        if (StringUtils.isBlank(value)) {
            throw new NuxeoException("Missing required nuxeo.conf property: " + name);
        }
        return value;
    }

    /** Lazily-initialized singleton; safe to call from any Work instance. */
    public static ColdStorageS3Mover get() {
        ColdStorageS3Mover local = instance;
        if (local == null) {
            synchronized (ColdStorageS3Mover.class) {
                local = instance;
                if (local == null) {
                    local = new ColdStorageS3Mover();
                    instance = local;
                }
            }
        }
        return local;
    }

    /**
     * Test/reset hook: drops the cached singleton so the next {@link #get()} rebuilds it from current properties.
     */
    public static void reset() {
        synchronized (ColdStorageS3Mover.class) {
            instance = null;
        }
    }

    /**
     * Computes the S3/MinIO object key for a blob, mirroring
     * {@code S3BlobKey#bucketKey()} exactly for our deployment's
     * configuration (no {@code bucket_prefix}, {@code subDirsDepth=0}):
     * under those settings the object key is simply the Nuxeo blob key
     * itself, and for the default {@code KeyStrategyDigest} strategy that
     * blob key IS the blob's content digest (hex-encoded MD5).
     */
    public static String getObjectKey(ManagedBlob blob) {
        String key = blob.getKey();
        // Strip an optional "<blobProviderId>:" prefix, exactly like
        // BlobStoreBlobProvider#stripBlobKeyPrefix does, so the key we use
        // to address the object in S3 never includes the Nuxeo-internal
        // provider id.
        int colon = key.indexOf(':');
        if (colon >= 0) {
            key = key.substring(colon + 1);
        }
        return key;
    }

    /**
     * Copies {@code key} from the hot bucket to the cold bucket, verifies the
     * copy landed, then deletes it from the hot bucket. No-ops (logs and
     * returns) if the object is already absent from the hot bucket -- e.g. a
     * retried Work after a previous run's delete already succeeded.
     */
    public void moveHotToCold(String key, String docId) {
        move(hotBucket, coldBucket, key, docId, "hot->cold");
    }

    /**
     * Copies {@code key} from the cold bucket back to the hot bucket,
     * verifies the copy landed, then deletes it from the cold bucket.
     */
    public void moveColdToHot(String key, String docId) {
        move(coldBucket, hotBucket, key, docId, "cold->hot");
    }

    protected void move(String sourceBucket, String destBucket, String key, String docId, String label) {
        if (!objectExists(sourceBucket, key)) {
            if (objectExists(destBucket, key)) {
                log.info("Cold storage move ({}) for document {}: object {} already present in destination bucket "
                        + "{} and absent from source {}; treating as already-completed (idempotent retry).", label,
                        docId, key, destBucket, sourceBucket);
                return;
            }
            throw new NuxeoException(
                    "Cold storage move (%s) for document %s: object %s not found in EITHER bucket (%s / %s)"
                            .formatted(label, docId, key, sourceBucket, destBucket));
        }

        // a. CopyObject(source/<key> -> dest/<key>)
        try {
            s3.copyObject(b -> b.sourceBucket(sourceBucket).sourceKey(key).destinationBucket(destBucket)
                                .destinationKey(key));
        } catch (SdkException e) {
            throw new NuxeoException(
                    "Cold storage move (%s) for document %s: CopyObject failed for key %s".formatted(label, docId,
                            key), e);
        }

        // b. HeadObject(dest/<key>) to confirm the copy exists before touching the source
        if (!objectExists(destBucket, key)) {
            String msg = ("Cold storage move (%s) for document %s: copy verification failed, object %s missing "
                    + "from destination bucket %s after CopyObject reported success -- source left intact").formatted(
                            label, docId, key, destBucket);
            throw new NuxeoException(msg);
        }

        // c. DeleteObject(source/<key>) -- only now that the copy is confirmed
        try {
            s3.deleteObject(b -> b.bucket(sourceBucket).key(key));
        } catch (SdkException e) {
            String msg = ("Cold storage move (%s) for document %s: copy succeeded but DeleteObject on source "
                    + "bucket %s failed for key %s -- object now exists in BOTH buckets, manual cleanup "
                    + "required").formatted(label, docId, sourceBucket, key);
            throw new NuxeoException(msg, e);
        }

        log.info("Cold storage move ({}) for document {} completed: key {} moved {} -> {}", label, docId, key,
                sourceBucket, destBucket);
    }

    protected boolean objectExists(String bucket, String key) {
        try {
            s3.headObject(HeadObjectRequest.builder().bucket(bucket).key(key).build());
            return true;
        } catch (NoSuchKeyException e) {
            return false;
        } catch (SdkException e) {
            if (e.getMessage() != null && e.getMessage().contains("Not Found")) {
                return false;
            }
            throw new NuxeoException("Failed to HEAD object %s/%s".formatted(bucket, key), e);
        }
    }

}
