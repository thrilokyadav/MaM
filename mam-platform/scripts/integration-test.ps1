<#
  (C) Copyright 2026 MAM Platform. All rights reserved.
  Proprietary and confidential.

  MAM PostgreSQL + Elasticsearch integration test (Priority 3):

  1. Brings up a disposable Nuxeo + PostgreSQL 16 + Elasticsearch 8.x
     stack from compose.integration.yaml, waiting for Postgres and
     Elasticsearch to report healthy BEFORE starting Nuxeo (via
     depends_on: condition: service_healthy), then for Nuxeo itself.
  2. Verifies BroadcastAsset/BroadcastVideo are registered (same checks
     as scripts/smoke-test.ps1, run again here because this is a
     different repository backend -- PostgreSQL, not H2).
  3. Full-text search: creates a BroadcastAsset with a unique token in
     dc:title, polls MAM_BROADCAST_ASSET_SEARCH's `q` (ecm:fulltext)
     parameter until the asset is indexed and returned by Elasticsearch,
     then asserts it comes back. This step has no equivalent on the
     H2-backed smoke stack: DialectH2 throws if fulltext is requested,
     so this specifically proves the Elasticsearch integration works,
     not just that documents were created.
  4. Faceted filtering: creates three BroadcastAssets with distinct
     broadcast:storyType values, queries MAM_BROADCAST_ASSET_SEARCH
     filtered to exactly one storyType, and asserts only the matching
     asset comes back (i.e. the filter facet is real, not accidental).
     Also asserts the storyType_agg aggregation bucket counts show up
     in the page provider response, proving ES aggregations are wired.
  5. S3 (MinIO) binary storage (Priority 4): uploads a real MP4 through
     Batch Upload, creates a BroadcastVideo, and asserts the MinIO
     `mam-blobs` bucket's object count increases (via `mc ls` run inside
     the minio container) -- direct proof the blob physically lives in
     S3-compatible storage, not the local filesystem. Then polls for
     FFmpeg-transcoded renditions and fetches the thumbnail rendition,
     proving Nuxeo can read the original blob back out of MinIO to
     process it, not just write it there once.
  6. Archive metadata audit trail (Priority 5): creates a BroadcastAsset
     with archiveState=hot, transitions it to "cold" and asserts
     broadcast:archiveDate/archivedBy were stamped by
     ArchiveStateGuardListener, then transitions back to "hot" and
     asserts broadcast:restoreDate/restoredBy were stamped while the
     earlier archiveDate/archivedBy are preserved as history.
  7. Cleans up all created test documents, then stops the stack
     (volumes preserved).

  On failure the script collects container logs into logs/ and exits
  non-zero. Named volumes are NEVER deleted automatically -- see the
  README's "PostgreSQL + Elasticsearch integration stack" section, or
  run `docker volume rm mam-integration-pg-data mam-integration-es-data
  mam-integration-minio-data mam-integration-nuxeo-data
  mam-integration-nuxeo-logs mam-integration-nuxeo-tmp` for a clean
  slate.
#>
[CmdletBinding()]
param(
    [string] $ProjectDir  = '',
    [string] $ComposeFile = 'compose.integration.yaml',
    [string] $EnvFile     = '.env.integration',
    [int]    $HealthTimeoutSec = 600,
    [int]    $IndexTimeoutSec  = 60,
    [int]    $TranscodeTimeoutSec = 180
)

$ErrorActionPreference = 'Stop'

if (-not $ProjectDir) {
    $scriptFile = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
    $ProjectDir = Split-Path -Parent (Split-Path -Parent $scriptFile)
}
Set-Location $ProjectDir

# ----- Load environment ----------------------------------------------
$envPath = Join-Path $ProjectDir $EnvFile
if (-not (Test-Path $envPath)) {
    $samplePath = Join-Path $ProjectDir '.env.integration.example'
    Write-Host "No $EnvFile found, falling back to .env.integration.example."
    $envPath = $samplePath
}
if (-not (Test-Path $envPath)) {
    throw "Neither $EnvFile nor .env.integration.example is present."
}

$envMap = @{}
Get-Content $envPath | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $k, $v = $line -split '=', 2
        $envMap[$k.Trim()] = $v.Trim()
    }
}

$nuxeoImage = if ($envMap['NUXEO_IMAGE']) { $envMap['NUXEO_IMAGE'] } else { 'nuxeo/nuxeo:2025.x' }
$hostPort   = if ($envMap['INTEGRATION_HOST_PORT']) { [int]$envMap['INTEGRATION_HOST_PORT'] } else { 8081 }

$baseUrl   = "http://localhost:$hostPort/nuxeo"
$restUrl   = "$baseUrl/api/v1"
$container = 'mam-integration-nuxeo'
$logDir    = Join-Path $ProjectDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# Administrator seed account -- same default as compose.smoke.yaml's
# Nuxeo image; no custom user management needed for this stack.
$adminUser     = 'Administrator'
$adminPassword = 'Administrator'
$basicAuth = 'Basic ' + [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes("${adminUser}:${adminPassword}"))
$authHeaders = @{ Authorization = $basicAuth }
$jsonHeaders = $authHeaders + @{ 'Content-Type' = 'application/json' }

# A fresh JWT smoke secret is still required as a Dockerfile.integration
# build arg (it reuses the same mam-jwt-smoke-config.xml mechanism as
# Dockerfile.smoke) even though this test suite doesn't exercise Bearer
# auth itself -- see scripts/smoke-test.ps1 for the full JWT test suite.
$jwtSecretBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($jwtSecretBytes)
$env:MAM_SMOKE_JWT_SECRET = -join ($jwtSecretBytes | ForEach-Object { '{0:x2}' -f $_ })

# Track created documents so failure paths can still remove them.
$createdPaths = @()

# ----- Local helpers ---------------------------------------------------
function Invoke-Compose {
    param([string[]] $ComposeArgs)
    & docker compose --env-file $EnvFile -f $ComposeFile @ComposeArgs
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose $($ComposeArgs -join ' ') failed with exit $LASTEXITCODE"
    }
}

function Remove-CreatedDocs {
    foreach ($p in $createdPaths) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$restUrl/path$p" -Headers $authHeaders `
                              -Method Delete -TimeoutSec 15 | Out-Null
            Write-Host "  Deleted: $p"
        } catch {
            Write-Host "  WARN: cleanup of $p failed: $($_.Exception.Message)"
        }
    }
}

function Collect-LogsAndFail {
    param([string] $Reason)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $logFile = Join-Path $logDir ("integration-nuxeo-{0}.log" -f $stamp)
    $pgLogFile = Join-Path $logDir ("integration-postgres-{0}.log" -f $stamp)
    $esLogFile = Join-Path $logDir ("integration-elasticsearch-{0}.log" -f $stamp)
    $minioLogFile = Join-Path $logDir ("integration-minio-{0}.log" -f $stamp)
    Write-Host "Collecting container logs into logs/integration-*-$stamp.log"
    try { docker logs $container *>&1 | Out-File -FilePath $logFile -Encoding utf8 } catch { }
    try { docker logs mam-integration-postgres *>&1 | Out-File -FilePath $pgLogFile -Encoding utf8 } catch { }
    try { docker logs mam-integration-elasticsearch *>&1 | Out-File -FilePath $esLogFile -Encoding utf8 } catch { }
    try { docker logs mam-integration-minio *>&1 | Out-File -FilePath $minioLogFile -Encoding utf8 } catch { }
    Remove-CreatedDocs
    Write-Host "Stopping the stack (volumes preserved)..."
    try { docker compose --env-file $EnvFile -f $ComposeFile down } catch { }
    Write-Host "INTEGRATION TEST FAILED: $Reason" -ForegroundColor Red
    exit 1
}

# ----- 1. Verify prerequisites ------------------------------------------
Write-Host "[1/8] Checking base image $nuxeoImage and mam-package ZIP exist..."
$img = docker image inspect $nuxeoImage --format '{{.Id}}' 2>$null
if (-not $img) {
    Write-Host "INTEGRATION TEST FAILED: base image $nuxeoImage is not present in the local daemon." -ForegroundColor Red
    exit 1
}
$zipPath = Join-Path $ProjectDir 'mam-package\target\mam-package-1.0.0-SNAPSHOT.zip'
if (-not (Test-Path $zipPath)) {
    Write-Host "INTEGRATION TEST FAILED: $zipPath is missing. Run 'mvn -DskipTests package' first." -ForegroundColor Red
    exit 1
}
$searchClientZip = Join-Path $ProjectDir 'vendor\nuxeo-search-client-opensearch1-package-2025.21-SNAPSHOT.zip'
if (-not (Test-Path $searchClientZip)) {
    Write-Host "INTEGRATION TEST FAILED: $searchClientZip is missing." -ForegroundColor Red
    Write-Host "  Build it from the D:\MaM\nuxeo source checkout (never modified in place):" -ForegroundColor Red
    Write-Host "    mvn -Pdistrib -pl packages/nuxeo-search-client-opensearch1-package -am -DskipTests install" -ForegroundColor Red
    Write-Host "  then copy nuxeo/packages/nuxeo-search-client-opensearch1-package/target/*.zip here." -ForegroundColor Red
    exit 1
}
$s3PackageZip = Join-Path $ProjectDir 'vendor\nuxeo-amazon-s3-package-2025.21-SNAPSHOT.zip'
if (-not (Test-Path $s3PackageZip)) {
    Write-Host "INTEGRATION TEST FAILED: $s3PackageZip is missing." -ForegroundColor Red
    Write-Host "  Build it from the D:\MaM\nuxeo source checkout (never modified in place):" -ForegroundColor Red
    Write-Host "    mvn -Pdistrib -pl packages/nuxeo-amazon-s3-package -am -DskipTests install" -ForegroundColor Red
    Write-Host "  then copy nuxeo/packages/nuxeo-amazon-s3-package/target/*.zip here." -ForegroundColor Red
    exit 1
}

# ----- 2. Build and start the stack, waiting for Postgres/ES health ----
# depends_on: condition: service_healthy in compose.integration.yaml
# already blocks Nuxeo's container start until both healthchecks pass;
# `docker compose up -d` itself blocks until every service's dependency
# graph is satisfied, so this single command IS the "wait for Postgres
# and Elasticsearch to be fully healthy before starting Nuxeo" step the
# task requires -- no extra polling needed for those two services.
Write-Host "[2/8] Building images and starting Postgres + Elasticsearch + MinIO + Nuxeo (dependency-ordered)..."
Invoke-Compose @('build')
Invoke-Compose @('up', '-d')

Write-Host "  Postgres, Elasticsearch, and MinIO (+ mam-blobs bucket init) reported healthy/completed (compose depends_on gate passed)."

# ----- 3. Wait for Nuxeo's own /runningstatus ---------------------------
Write-Host "[3/8] Waiting for Nuxeo to become healthy (up to $HealthTimeoutSec s)..."
$deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/runningstatus" -TimeoutSec 5
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 5
}
if (-not $ready) {
    Collect-LogsAndFail "Nuxeo did not respond 200 on /runningstatus within $HealthTimeoutSec s."
}
Write-Host "  Nuxeo is up (backed by PostgreSQL 16 + Elasticsearch 8.x)."

$targetPath = '/default-domain/workspaces'
try {
    Invoke-RestMethod -Uri "$restUrl/path$targetPath" -Headers $authHeaders -TimeoutSec 15 | Out-Null
} catch { Collect-LogsAndFail "Cannot read $targetPath : $($_.Exception.Message)" }

# ----- 4. Doctype sanity check (same repository, different backend) ----
Write-Host "[4/8] Verifying BroadcastAsset is registered against the PostgreSQL-backed repository..."
try {
    $ba = Invoke-RestMethod -Uri "$restUrl/config/types/BroadcastAsset" -Headers $authHeaders -TimeoutSec 15
} catch { Collect-LogsAndFail "GET /config/types/BroadcastAsset failed: $($_.Exception.Message)" }
if ($ba.name -ne 'BroadcastAsset' -or $ba.'entity-type' -ne 'docType') {
    Collect-LogsAndFail "BroadcastAsset not reported by /config/types."
}
Write-Host "  Doctype BroadcastAsset is registered."

# ----- 5. Full-text search via Elasticsearch ----------------------------
Write-Host "[5/8] Verifying full-text search (ecm:fulltext) via Elasticsearch..."

$uniqueToken = "UniqueSearchTermAlpha-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$ftAssetName = "mam-integration-ft-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$ftBody = @{
    'entity-type' = 'document'
    name          = $ftAssetName
    type          = 'BroadcastAsset'
    properties    = @{
        'dc:title'                  = "Integration fulltext probe $uniqueToken"
        'broadcast:slug'            = 'integration-fulltext-probe'
        'broadcast:storyType'       = 'bulletin'
        'broadcast:editorialStatus' = 'draft'
        'broadcast:archiveState'    = 'hot'
    }
} | ConvertTo-Json -Depth 5
try {
    $ftDoc = Invoke-RestMethod -Uri "$restUrl/path$targetPath" -Headers $jsonHeaders -Method Post -Body $ftBody -TimeoutSec 30
} catch { Collect-LogsAndFail "Full-text probe asset create failed: $($_.Exception.Message)" }
$createdPaths += $ftDoc.path
Write-Host "  Created full-text probe asset: $($ftDoc.path) (title contains '$uniqueToken')"

# Poll MAM_BROADCAST_ASSET_SEARCH's `q` (ecm:fulltext) parameter until
# Elasticsearch has indexed the document (indexing is asynchronous: the
# core listener fires a domain event that a stream processor consumes to
# push the document into ES, so there is always a short lag after
# creation). This is the step that CANNOT pass against the H2-backed
# smoke stack (Dockerfile.smoke) -- DialectH2 throws
# "Fulltext search cannot be enabled with H2" if fulltext is ever
# requested against it, so a passing result here is direct proof
# Elasticsearch is doing the work, not the repository's own SQL fulltext
# index.
$found = $false
$deadline = (Get-Date).AddSeconds($IndexTimeoutSec)
while ((Get-Date) -lt $deadline) {
    try {
        $q = [uri]::EscapeDataString($uniqueToken)
        $resp = Invoke-RestMethod -Uri "$restUrl/search/pp/MAM_BROADCAST_ASSET_SEARCH/execute?q=$q" `
                                  -Headers $authHeaders -TimeoutSec 15
        if ($resp.entries | Where-Object { $_.uid -eq $ftDoc.uid }) {
            $found = $true
            break
        }
    } catch { }
    Start-Sleep -Seconds 3
}
if (-not $found) {
    Collect-LogsAndFail "Full-text search for '$uniqueToken' via MAM_BROADCAST_ASSET_SEARCH did not return the probe asset within ${IndexTimeoutSec}s (Elasticsearch indexing lag, or ES wiring broken)."
}
Write-Host "  Full-text search PASSED: MAM_BROADCAST_ASSET_SEARCH found the asset by unique token '$uniqueToken' via Elasticsearch."

# ----- 6. Faceted filtering / aggregations -------------------------------
Write-Host "[6/8] Verifying faceted filtering (broadcast:storyType) and aggregations..."

$storyTypes = @('bulletin', 'feature', 'breaking')
$facetDocs = @{}
foreach ($st in $storyTypes) {
    $name = "mam-integration-facet-$st-$([Guid]::NewGuid().ToString('N').Substring(0,6))"
    $body = @{
        'entity-type' = 'document'
        name          = $name
        type          = 'BroadcastAsset'
        properties    = @{
            'dc:title'                  = "Facet probe ($st)"
            'broadcast:slug'            = "facet-probe-$st"
            'broadcast:storyType'       = $st
            'broadcast:editorialStatus' = 'draft'
            'broadcast:archiveState'    = 'hot'
        }
    } | ConvertTo-Json -Depth 5
    try {
        $doc = Invoke-RestMethod -Uri "$restUrl/path$targetPath" -Headers $jsonHeaders -Method Post -Body $body -TimeoutSec 30
    } catch { Collect-LogsAndFail "Facet probe asset create ($st) failed: $($_.Exception.Message)" }
    $createdPaths += $doc.path
    $facetDocs[$st] = $doc
    Write-Host "  Created facet probe asset ($st): $($doc.path)"
}

# Wait for all three to be searchable (reuse the same ES-indexing-lag
# polling approach as the full-text step, keyed this time on the
# storyType filter itself rather than a title token).
$filterReady = $false
$deadline = (Get-Date).AddSeconds($IndexTimeoutSec)
while ((Get-Date) -lt $deadline) {
    try {
        $resp = Invoke-RestMethod -Uri "$restUrl/search/pp/MAM_BROADCAST_ASSET_SEARCH/execute?storyType=breaking" `
                                  -Headers $authHeaders -TimeoutSec 15
        if ($resp.entries | Where-Object { $_.uid -eq $facetDocs['breaking'].uid }) {
            $filterReady = $true
            break
        }
    } catch { }
    Start-Sleep -Seconds 3
}
if (-not $filterReady) {
    Collect-LogsAndFail "Faceted filter query (storyType=breaking) did not return the probe asset within ${IndexTimeoutSec}s."
}

# Re-fetch (now that indexing has caught up) and assert ONLY the
# matching storyType comes back among our probe docs -- proves the
# filter is a real predicate, not an accidental match-everything.
$resp = Invoke-RestMethod -Uri "$restUrl/search/pp/MAM_BROADCAST_ASSET_SEARCH/execute?storyType=breaking" `
                          -Headers $authHeaders -TimeoutSec 15
$matchedUids = @($resp.entries | ForEach-Object { $_.uid })
foreach ($st in $storyTypes) {
    $shouldMatch = ($st -eq 'breaking')
    $didMatch = $matchedUids -contains $facetDocs[$st].uid
    if ($shouldMatch -and -not $didMatch) {
        Collect-LogsAndFail "Faceted filter (storyType=breaking): expected the 'breaking' probe asset in results, but it was absent."
    }
    if (-not $shouldMatch -and $didMatch) {
        Collect-LogsAndFail "Faceted filter (storyType=breaking): the '$st' probe asset was unexpectedly returned by a filter for a different storyType."
    }
}
Write-Host "  Faceted filter PASSED: storyType=breaking returned only the 'breaking' probe asset (bulletin/feature correctly excluded)."

# Assert the terms aggregation bucket for storyType is present and
# non-empty -- proves aggregations (not just the plain filter) are wired
# through to Elasticsearch via the searchServicePageProvider contribution.
if (-not $resp.aggregations -or -not $resp.aggregations.storyType_agg) {
    Collect-LogsAndFail "MAM_BROADCAST_ASSET_SEARCH response has no 'storyType_agg' aggregation; faceted aggregation wiring is broken."
}
$buckets = $resp.aggregations.storyType_agg.buckets
if (-not $buckets -or $buckets.Count -eq 0) {
    Collect-LogsAndFail "storyType_agg aggregation returned zero buckets; expected at least one (breaking/bulletin/feature)."
}
$bucketSummary = ($buckets | ForEach-Object { "$($_.key)=$($_.docCount)" }) -join ', '
Write-Host "  Aggregation PASSED: storyType_agg returned $($buckets.Count) bucket(s): $bucketSummary"

Write-Host "  Faceted filtering and aggregations verified against Elasticsearch."

# ----- 7. S3 (MinIO) binary storage: upload, transcode, thumbnail --------
# Uploads a real video through the same Batch Upload -> BroadcastVideo ->
# transcode -> thumbnail pipeline exercised by scripts/smoke-test.ps1,
# but here the repository's blob provider is nuxeo.core.binarymanager=
# org.nuxeo.ecm.blob.s3.S3BlobProvider pointed at MinIO (see
# Dockerfile.integration), not the local filesystem. A passing transcode
# and thumbnail fetch proves Nuxeo can read the *original* upload back
# out of MinIO to run FFmpeg against it; the `mc ls` check below proves
# the blob is physically sitting in the mam-blobs bucket, not on local
# disk.
Write-Host "[7/8] Verifying S3 (MinIO) binary storage: video upload, transcoding, thumbnail..."

$minioBucket = if ($envMap['MAM_S3_BUCKET']) { $envMap['MAM_S3_BUCKET'] } else { 'mam-blobs' }
$minioContainer = 'mam-integration-minio'
$minioUser = if ($envMap['MINIO_ROOT_USER']) { $envMap['MINIO_ROOT_USER'] } else { 'mam_minio_admin' }
$minioPassword = if ($envMap['MINIO_ROOT_PASSWORD']) { $envMap['MINIO_ROOT_PASSWORD'] } else { 'mam_minio_dev_only' }

function Get-MinioObjectCount {
    # Runs `mc` from inside the already-running minio container (the
    # official minio/minio image bundles mc -- the compose healthcheck
    # above already relies on `mc ready`), so no extra client container
    # needs to be started just to inspect the bucket.
    docker exec $minioContainer mc alias set local http://localhost:9000 $minioUser $minioPassword *>$null
    $listing = docker exec $minioContainer mc ls --recursive "local/$minioBucket" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $listing) { return 0 }
    return @($listing -split "`n" | Where-Object { $_.Trim() }).Count
}

$objectCountBefore = Get-MinioObjectCount
Write-Host "  MinIO bucket '$minioBucket' object count before upload: $objectCountBefore"

# 7a: FFmpeg fixture, generated the same way as scripts/smoke-test.ps1.
$s3FixtureInContainer = '/tmp/mam-s3-fixture.mp4'
$s3FixtureHost = Join-Path $env:TEMP ("mam-s3-fixture-{0}.mp4" -f ([Guid]::NewGuid().ToString('N').Substring(0,8)))
$ffmpegCmd = @(
    'ffmpeg -y -v error',
    '-f lavfi -i testsrc=duration=6:size=320x240:rate=25',
    '-f lavfi -i sine=frequency=1000:duration=6',
    '-c:v libx264 -preset ultrafast -pix_fmt yuv420p',
    '-c:a aac -b:a 64k',
    '-shortest',
    "$s3FixtureInContainer"
) -join ' '
docker exec $container bash -c $ffmpegCmd
if ($LASTEXITCODE -ne 0) {
    Collect-LogsAndFail "In-container ffmpeg S3 fixture generation failed."
}
docker cp "${container}:${s3FixtureInContainer}" $s3FixtureHost | Out-Null
if (-not (Test-Path $s3FixtureHost) -or (Get-Item $s3FixtureHost).Length -lt 10000) {
    Collect-LogsAndFail "S3 fixture MP4 was not copied to the host (or is too small)."
}
Write-Host "  Fixture created: $s3FixtureHost ($((Get-Item $s3FixtureHost).Length) bytes)"

# 7b: Batch upload + BroadcastVideo create (identical REST shape to the
# smoke stack; the only difference is the repository's blob provider).
try {
    $s3Batch = Invoke-RestMethod -Uri "$restUrl/upload/" -Headers $authHeaders -Method Post -TimeoutSec 30
} catch { Collect-LogsAndFail "S3 batch init failed: $($_.Exception.Message)" }
$s3BatchId = $s3Batch.batchId
if (-not $s3BatchId) { Collect-LogsAndFail "S3 batch init returned no batchId." }

$s3FixtureBytes = [IO.File]::ReadAllBytes($s3FixtureHost)
$s3UploadHeaders = $authHeaders + @{
    'Content-Type'  = 'video/mp4'
    'X-File-Name'   = 'mam-s3-fixture.mp4'
    'X-File-Type'   = 'video/mp4'
    'X-Upload-Type' = 'normal'
}
try {
    Invoke-RestMethod -Uri "$restUrl/upload/$s3BatchId/0" -Headers $s3UploadHeaders -Method Post `
                      -Body $s3FixtureBytes -TimeoutSec 120 | Out-Null
} catch { Collect-LogsAndFail "S3 batch upload failed: $($_.Exception.Message)" }
Write-Host "  Uploaded S3 fixture as batchId=$s3BatchId file 0."

$s3VideoName = "mam-integration-s3video-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$s3VideoBody = @{
    'entity-type' = 'document'
    name          = $s3VideoName
    type          = 'BroadcastVideo'
    properties    = @{
        'dc:title'                  = "MAM S3 integration video $(Get-Date -Format o)"
        'file:content'              = @{ 'upload-batch' = $s3BatchId; 'upload-fileId' = '0' }
        'broadcast:slug'            = 'integration-s3-video'
        'broadcast:storyType'       = 'bulletin'
        'broadcast:editorialStatus' = 'draft'
        'broadcast:archiveState'    = 'hot'
    }
} | ConvertTo-Json -Depth 6
try {
    $s3Video = Invoke-RestMethod -Uri "$restUrl/path$targetPath" -Headers $jsonHeaders -Method Post `
                                 -Body $s3VideoBody -TimeoutSec 60
} catch { Collect-LogsAndFail "S3 BroadcastVideo create failed: $($_.Exception.Message)" }
if ($s3Video.type -ne 'BroadcastVideo') {
    Collect-LogsAndFail "S3 created video doc type mismatch: '$($s3Video.type)'."
}
$s3VideoUid = $s3Video.uid
$createdPaths += $s3Video.path
Write-Host "  Created BroadcastVideo (S3-backed): $($s3Video.path)"

# 7c: Blob-in-MinIO check. Nuxeo's own upload response is written
# synchronously (the document create above already blocked on the S3
# PutObject call inside S3BlobProvider), so the object count should have
# already increased by the time we get here -- no indexing lag to poll
# for, unlike the Elasticsearch steps above. A short retry loop is kept
# only to absorb any transient `mc` invocation hiccups, not blob
# propagation delay.
$objectCountAfterUpload = $null
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    $objectCountAfterUpload = Get-MinioObjectCount
    if ($objectCountAfterUpload -gt $objectCountBefore) { break }
    Start-Sleep -Seconds 2
}
if (-not $objectCountAfterUpload -or $objectCountAfterUpload -le $objectCountBefore) {
    Collect-LogsAndFail "MinIO bucket '$minioBucket' object count did not increase after BroadcastVideo upload (before=$objectCountBefore, after=$objectCountAfterUpload); blob was not written to S3."
}
Write-Host "  MinIO PASSED: bucket '$minioBucket' object count increased from $objectCountBefore to $objectCountAfterUpload after upload."

# 7d: Poll for transcoded renditions -- proves Nuxeo/FFmpeg can read the
# *original* blob back out of MinIO (not local disk) to produce them.
Write-Host "  Polling up to ${TranscodeTimeoutSec}s for vid:transcodedVideos (reading original blob from MinIO)..."
$s3Transcoded = @()
$pollDeadline = (Get-Date).AddSeconds($TranscodeTimeoutSec)
while ((Get-Date) -lt $pollDeadline) {
    try {
        $doc = Invoke-RestMethod -Uri "$restUrl/id/$s3VideoUid" -Headers ($authHeaders + @{ 'properties' = '*' }) `
                                 -TimeoutSec 15
        $tv = $doc.properties.'vid:transcodedVideos'
        if ($tv -and $tv.Count -gt 0) { $s3Transcoded = $tv; break }
    } catch { }
    Start-Sleep -Seconds 5
}
if ($s3Transcoded.Count -eq 0) {
    Collect-LogsAndFail "vid:transcodedVideos remained empty after ${TranscodeTimeoutSec}s for the S3-backed video; Nuxeo could not read/transcode the MinIO-stored blob."
}
$s3TranscodedNames = ($s3Transcoded | ForEach-Object { $_.name }) -join ','
Write-Host "  Transcoding PASSED (S3-backed source): renditions=$s3TranscodedNames"

# 7e: Thumbnail rendition fetch -- same sync=true pattern as the smoke
# stack, proving thumbnail generation also reads the blob from MinIO.
$s3ThumbResp = $null
$thumbDeadline = (Get-Date).AddSeconds(120)
$s3LastErr = $null
while ((Get-Date) -lt $thumbDeadline) {
    try {
        $s3ThumbResp = Invoke-WebRequest -UseBasicParsing -Uri "$restUrl/id/$s3VideoUid/@rendition/thumbnail?sync=true" `
                                         -Headers $authHeaders -TimeoutSec 60
        if ($s3ThumbResp.StatusCode -eq 200 -and $s3ThumbResp.Content.Length -ge 100) { break }
    } catch { $s3LastErr = $_.Exception.Message }
    Start-Sleep -Seconds 5
}
if (-not $s3ThumbResp -or $s3ThumbResp.StatusCode -ne 200 -or $s3ThumbResp.Content.Length -lt 100) {
    Collect-LogsAndFail "S3-backed thumbnail rendition fetch failed within 120s: $s3LastErr"
}
Write-Host "  Thumbnail PASSED (S3-backed source): $($s3ThumbResp.Content.Length) bytes."

if (Test-Path $s3FixtureHost) { Remove-Item -Force $s3FixtureHost }
Write-Host "  S3 (MinIO) binary storage verified: upload, transcoding, and thumbnail all round-trip correctly through MinIO."

# ----- 8. Archive metadata audit trail (Priority 5) ----------------------
# ArchiveStateGuardListener (mam-security) now stamps broadcast:archiveDate/
# archivedBy on a hot->cold transition and broadcast:restoreDate/restoredBy
# on a cold->hot transition, in the SAME saveDocument call that changed
# archiveState (see the listener's Javadoc). This stack has no CSRF
# handshake enabled (see Dockerfile.integration), so, like every other
# state-changing call in this script, the PUTs below use plain
# Invoke-RestMethod with Administrator Basic auth -- no
# Invoke-NxRestMethod/CSRF-Token dance needed here (that is exercised by
# scripts/smoke-test.ps1 instead).
Write-Host "[8/8] Verifying archive metadata audit trail (archiveDate/archivedBy/restoreDate/restoredBy)..."

$archiveAssetName = "mam-integration-archive-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$archiveBody = @{
    'entity-type' = 'document'
    name          = $archiveAssetName
    type          = 'BroadcastAsset'
    properties    = @{
        'dc:title'                  = "Archive audit probe $(Get-Date -Format o)"
        'broadcast:slug'            = 'integration-archive-audit'
        'broadcast:storyType'       = 'bulletin'
        'broadcast:editorialStatus' = 'draft'
        'broadcast:archiveState'    = 'hot'
    }
} | ConvertTo-Json -Depth 5
try {
    $archiveDoc = Invoke-RestMethod -Uri "$restUrl/path$targetPath" -Headers $jsonHeaders -Method Post `
                                    -Body $archiveBody -TimeoutSec 30
} catch { Collect-LogsAndFail "Archive audit probe asset create failed: $($_.Exception.Message)" }
$createdPaths += $archiveDoc.path
Write-Host "  Created archive audit probe asset: $($archiveDoc.path) (archiveState=hot)"

# 8a: hot -> cold. Expect archiveDate/archivedBy to be stamped, and the
# restore fields to remain unset (never archived+restored yet).
$toColdBody = @{
    'entity-type' = 'document'
    uid           = $archiveDoc.uid
    properties    = @{ 'broadcast:archiveState' = 'cold' }
} | ConvertTo-Json -Depth 5
try {
    Invoke-RestMethod -Uri "$restUrl/id/$($archiveDoc.uid)" -Headers $jsonHeaders -Method Put `
                      -Body $toColdBody -TimeoutSec 15 | Out-Null
} catch { Collect-LogsAndFail "Archive audit probe hot->cold transition failed: $($_.Exception.Message)" }
try {
    $afterCold = Invoke-RestMethod -Uri "$restUrl/id/$($archiveDoc.uid)" `
                                   -Headers ($authHeaders + @{ 'X-NXproperties' = '*' }) -TimeoutSec 15
} catch { Collect-LogsAndFail "Archive audit probe read-back after hot->cold failed: $($_.Exception.Message)" }

if ($afterCold.properties.'broadcast:archiveState' -ne 'cold') {
    Collect-LogsAndFail "Archive audit probe: expected archiveState=cold after transition, got '$($afterCold.properties.'broadcast:archiveState')'."
}
if (-not $afterCold.properties.'broadcast:archiveDate') {
    Collect-LogsAndFail "Archive audit probe: broadcast:archiveDate was not stamped on hot->cold transition."
}
if ($afterCold.properties.'broadcast:archivedBy' -ne $adminUser) {
    Collect-LogsAndFail "Archive audit probe: expected broadcast:archivedBy='$adminUser', got '$($afterCold.properties.'broadcast:archivedBy')'."
}
if ($afterCold.properties.'broadcast:restoreDate' -or $afterCold.properties.'broadcast:restoredBy') {
    Collect-LogsAndFail "Archive audit probe: restore fields must remain unset before any restore has happened."
}
Write-Host "  hot->cold PASSED: archiveDate=$($afterCold.properties.'broadcast:archiveDate'), archivedBy=$($afterCold.properties.'broadcast:archivedBy')"

# 8b: cold -> hot (restore). Expect restoreDate/restoredBy to be stamped,
# and the earlier archiveDate/archivedBy to be PRESERVED as history (the
# listener never clears them -- see populateArchiveAuditFields).
$toHotBody = @{
    'entity-type' = 'document'
    uid           = $archiveDoc.uid
    properties    = @{ 'broadcast:archiveState' = 'hot' }
} | ConvertTo-Json -Depth 5
try {
    Invoke-RestMethod -Uri "$restUrl/id/$($archiveDoc.uid)" -Headers $jsonHeaders -Method Put `
                      -Body $toHotBody -TimeoutSec 15 | Out-Null
} catch { Collect-LogsAndFail "Archive audit probe cold->hot transition failed: $($_.Exception.Message)" }
try {
    $afterHot = Invoke-RestMethod -Uri "$restUrl/id/$($archiveDoc.uid)" `
                                  -Headers ($authHeaders + @{ 'X-NXproperties' = '*' }) -TimeoutSec 15
} catch { Collect-LogsAndFail "Archive audit probe read-back after cold->hot failed: $($_.Exception.Message)" }

if ($afterHot.properties.'broadcast:archiveState' -ne 'hot') {
    Collect-LogsAndFail "Archive audit probe: expected archiveState=hot after restore, got '$($afterHot.properties.'broadcast:archiveState')'."
}
if (-not $afterHot.properties.'broadcast:restoreDate') {
    Collect-LogsAndFail "Archive audit probe: broadcast:restoreDate was not stamped on cold->hot transition."
}
if ($afterHot.properties.'broadcast:restoredBy' -ne $adminUser) {
    Collect-LogsAndFail "Archive audit probe: expected broadcast:restoredBy='$adminUser', got '$($afterHot.properties.'broadcast:restoredBy')'."
}
if (-not $afterHot.properties.'broadcast:archiveDate' -or -not $afterHot.properties.'broadcast:archivedBy') {
    Collect-LogsAndFail "Archive audit probe: the prior archiveDate/archivedBy must be preserved as history after a restore, but were cleared."
}
Write-Host "  cold->hot PASSED: restoreDate=$($afterHot.properties.'broadcast:restoreDate'), restoredBy=$($afterHot.properties.'broadcast:restoredBy') (archivedBy history preserved: $($afterHot.properties.'broadcast:archivedBy'))"

Write-Host "  Archive metadata audit trail verified."

# ----- Cleanup + stop ----------------------------------------------------
Write-Host "Cleaning up test documents and stopping the stack..."
Remove-CreatedDocs
$createdPaths = @()
Invoke-Compose @('down')

Write-Host ""
Write-Host "INTEGRATION TEST PASSED" -ForegroundColor Green
exit 0
