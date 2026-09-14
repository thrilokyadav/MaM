/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.core.archive;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.runtime.api.Framework;

import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.client.config.ClientOverrideConfiguration;
import software.amazon.awssdk.http.apache.ApacheHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CopyObjectRequest;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectResponse;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.S3Exception;

import java.net.URI;
import java.time.Duration;

/**
 * Thin S3 / MinIO client for the MAM cold-storage archive pipeline.
 *
 * <p>Reads its configuration from the same {@code nuxeo.conf} properties that
 * the stock {@code S3BlobProvider} already uses, plus one additional property
 * for the cold bucket name:</p>
 *
 * <pre>
 *   nuxeo.s3storage.bucket          -- hot (primary) bucket
 *   nuxeo.s3storage.awsid           -- access key id
 *   nuxeo.s3storage.awssecret       -- secret access key
 *   nuxeo.s3storage.region          -- AWS/MinIO region (e.g. us-east-1)
 *   nuxeo.s3storage.endpoint        -- custom endpoint URL (MinIO: http://minio:9000)
 *   nuxeo.s3storage.pathstyleaccess -- "true" for MinIO
 *   nuxeo.coldstorage.bucket        -- cold bucket name (already wired by 12-mam-s3.sh)
 * </pre>
 *
 * <p>A single {@link S3Client} is created lazily and reused across calls
 * (it is thread-safe per the AWS SDK v2 contract).</p>
 */
public class ColdStorageService {

    private static final Logger log = LogManager.getLogger(ColdStorageService.class);

    /* nuxeo.conf property keys (same as S3BlobProvider) */
    private static final String PROP_HOT_BUCKET  = "nuxeo.s3storage.bucket";
    private static final String PROP_COLD_BUCKET = "nuxeo.coldstorage.bucket";
    private static final String PROP_ACCESS_KEY  = "nuxeo.s3storage.awsid";
    private static final String PROP_SECRET_KEY  = "nuxeo.s3storage.awssecret";
    private static final String PROP_REGION      = "nuxeo.s3storage.region";
    private static final String PROP_ENDPOINT    = "nuxeo.s3storage.endpoint";
    private static final String PROP_PATH_STYLE  = "nuxeo.s3storage.pathstyleaccess";

    private static volatile S3Client clientInstance;

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /**
     * Copies {@code key} from the hot bucket to the cold bucket, verifies
     * the copy via a {@code HeadObject} call, then deletes from the hot bucket.
     * The delete only happens after the cold copy is confirmed -- zero data loss.
     *
     * @param key blob digest key (content-addressable; same value in both buckets)
     */
    public void archiveBlob(String key) {
        copyHotToCold(key);
        deleteFromHot(key);
    }

    /**
     * Copies {@code key} from the hot bucket to the cold bucket and verifies
     * the copy via a {@code HeadObject} call. Does NOT delete the source; the
     * caller decides whether the hot copy can be removed (see
     * {@link #deleteFromHot(String)}) once it has confirmed no other document
     * still needs the blob in hot storage. Idempotent: copying an object that
     * already exists in cold simply overwrites it with identical bytes.
     *
     * @param key blob digest key (content-addressable; same value in both buckets)
     */
    public void copyHotToCold(String key) {
        String hot  = hotBucket();
        String cold = coldBucket();
        S3Client s3 = client();

        log.info("MAM archive: copying blob [{}] hot=[{}] -> cold=[{}]", key, hot, cold);

        CopyObjectRequest copyReq = (CopyObjectRequest) CopyObjectRequest.builder()
                .sourceBucket(hot)
                .sourceKey(key)
                .destinationBucket(cold)
                .destinationKey(key)
                .build();
        s3.copyObject(copyReq);

        HeadObjectRequest headReq = (HeadObjectRequest) HeadObjectRequest.builder()
                .bucket(cold)
                .key(key)
                .build();
        HeadObjectResponse head = s3.headObject(headReq);
        log.info("MAM archive: cold copy verified size={} etag={}", head.contentLength(), head.eTag());
    }

    /**
     * Deletes {@code key} from the hot bucket. Call this only after
     * {@link #copyHotToCold(String)} has confirmed the cold copy exists AND
     * the caller has confirmed no other document still references this blob
     * in hot storage (content-addressable dedup means one physical object can
     * back several documents).
     *
     * @param key blob digest key
     */
    public void deleteFromHot(String key) {
        String hot = hotBucket();
        DeleteObjectRequest delReq = (DeleteObjectRequest) DeleteObjectRequest.builder()
                .bucket(hot)
                .key(key)
                .build();
        client().deleteObject(delReq);
        log.info("MAM archive: hot copy deleted; blob [{}] is now cold-only", key);
    }

    /**
     * Copies {@code key} from the cold bucket back to the hot bucket, verifies,
     * then deletes from cold.
     *
     * @param key blob digest key
     */
    public void restoreBlob(String key) {
        copyColdToHot(key);
        deleteFromCold(key);
    }

    /**
     * Copies {@code key} from the cold bucket back to the hot bucket and
     * verifies the copy. Does NOT delete the cold source; the caller decides
     * whether the cold copy can be removed (see {@link #deleteFromCold(String)})
     * once it has confirmed no other still-cold document needs it. Idempotent.
     *
     * @param key blob digest key
     */
    public void copyColdToHot(String key) {
        String hot  = hotBucket();
        String cold = coldBucket();
        S3Client s3 = client();

        log.info("MAM restore: copying blob [{}] cold=[{}] -> hot=[{}]", key, cold, hot);

        CopyObjectRequest copyReq = (CopyObjectRequest) CopyObjectRequest.builder()
                .sourceBucket(cold)
                .sourceKey(key)
                .destinationBucket(hot)
                .destinationKey(key)
                .build();
        s3.copyObject(copyReq);

        HeadObjectRequest headReq = (HeadObjectRequest) HeadObjectRequest.builder()
                .bucket(hot)
                .key(key)
                .build();
        HeadObjectResponse head = s3.headObject(headReq);
        log.info("MAM restore: hot copy verified size={} etag={}", head.contentLength(), head.eTag());
    }

    /**
     * Deletes {@code key} from the cold bucket. Call this only after
     * {@link #copyColdToHot(String)} has confirmed the hot copy exists AND the
     * caller has confirmed no other document still references this blob in
     * cold storage.
     *
     * @param key blob digest key
     */
    public void deleteFromCold(String key) {
        String cold = coldBucket();
        DeleteObjectRequest delReq = (DeleteObjectRequest) DeleteObjectRequest.builder()
                .bucket(cold)
                .key(key)
                .build();
        client().deleteObject(delReq);
        log.info("MAM restore: cold copy deleted; blob [{}] is now hot-only", key);
    }

    /**
     * Returns {@code true} if {@code key} exists in the cold bucket.
     */
    public boolean existsInCold(String key) {
        return existsIn(coldBucket(), key);
    }

    /**
     * Returns {@code true} if {@code key} exists in the hot bucket.
     */
    public boolean existsInHot(String key) {
        return existsIn(hotBucket(), key);
    }

    private boolean existsIn(String bucket, String key) {
        try {
            HeadObjectRequest headReq = (HeadObjectRequest) HeadObjectRequest.builder()
                    .bucket(bucket)
                    .key(key)
                    .build();
            client().headObject(headReq);
            return true;
        } catch (NoSuchKeyException e) {
            return false;
        } catch (S3Exception e) {
            log.warn("MAM cold-storage: HeadObject on bucket=[{}] key=[{}] failed: {}", bucket, key, e.getMessage());
            return false;
        }
    }

    // ---------------------------------------------------------------------------
    // Config helpers
    // ---------------------------------------------------------------------------

    private static String hotBucket() {
        return requiredProp(PROP_HOT_BUCKET);
    }

    private static String coldBucket() {
        return requiredProp(PROP_COLD_BUCKET);
    }

    private static String requiredProp(String key) {
        String v = Framework.getProperty(key);
        if (v == null || v.isBlank()) {
            throw new IllegalStateException(
                    "MAM cold-storage: required nuxeo.conf property [" + key + "] is not set.");
        }
        return v.trim();
    }

    // ---------------------------------------------------------------------------
    // S3Client lifecycle (lazy singleton, thread-safe via double-checked lock)
    // ---------------------------------------------------------------------------

    private static S3Client client() {
        if (clientInstance == null) {
            synchronized (ColdStorageService.class) {
                if (clientInstance == null) {
                    clientInstance = buildClient();
                }
            }
        }
        return clientInstance;
    }

    private static S3Client buildClient() {
        String accessKey = requiredProp(PROP_ACCESS_KEY);
        String secretKey = requiredProp(PROP_SECRET_KEY);
        String region    = Framework.getProperty(PROP_REGION, "us-east-1");
        String endpoint  = Framework.getProperty(PROP_ENDPOINT, "");
        boolean pathStyle = "true".equalsIgnoreCase(
                Framework.getProperty(PROP_PATH_STYLE, "false"));

        // A server-side CopyObject of a multi-hundred-MB video on MinIO can
        // take far longer than the AWS SDK's default socket read timeout
        // (30s), after which the SDK retries a few times and then fails the
        // whole call with "Read timed out". That surfaced as the Archive
        // button hanging and then erroring. Give the underlying Apache HTTP
        // client generous socket/connection timeouts, and cap the overall
        // per-API-call time well above the largest expected blob copy so a
        // legitimately slow copy is allowed to finish rather than being
        // aborted mid-flight.
        ApacheHttpClient.Builder httpClient = ApacheHttpClient.builder()
                .connectionTimeout(Duration.ofSeconds(30))
                .socketTimeout(Duration.ofMinutes(15));

        ClientOverrideConfiguration overrideConfig = ClientOverrideConfiguration.builder()
                .apiCallTimeout(Duration.ofMinutes(20))
                .apiCallAttemptTimeout(Duration.ofMinutes(16))
                .build();

        var builder = S3Client.builder()
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(accessKey, secretKey)))
                .region(Region.of(region))
                .httpClientBuilder(httpClient)
                .overrideConfiguration(overrideConfig)
                .serviceConfiguration(S3Configuration.builder()
                        .pathStyleAccessEnabled(pathStyle)
                        .build());

        if (!endpoint.isBlank()) {
            builder.endpointOverride(URI.create(endpoint));
            log.info("MAM ColdStorageService: using custom S3 endpoint [{}]", endpoint);
        }

        S3Client c = builder.build();
        log.info("MAM ColdStorageService: S3Client ready hot=[{}] cold=[{}] region={} pathStyle={}",
                Framework.getProperty(PROP_HOT_BUCKET, "<unset>"),
                Framework.getProperty(PROP_COLD_BUCKET, "<unset>"),
                region, pathStyle);
        return c;
    }
}
