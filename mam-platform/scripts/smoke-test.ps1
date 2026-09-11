<#
  (C) Copyright 2026 MAM Platform. All rights reserved.
  Proprietary and confidential.

  MAM smoke test:

  1. Brings up a disposable Nuxeo container from compose.smoke.yaml.
  2. Verifies BroadcastAsset is registered and metadata round-trips
     (dc + broadcast fields) via REST, including a CSRF-protected PUT
     metadata update.
  3. Verifies BroadcastVideo is registered.
  4. Generates a small MP4 fixture inside the container with the
     smoke image's ffmpeg, copies it to the host tmp dir, uploads it
     through Nuxeo's Batch Upload API, creates one BroadcastVideo,
     polls for `video:transcodedVideos` to become non-empty (up to
     180 s) and for a thumbnail rendition to be servable.
  5. Verifies server-enforced archive authorization
     (ArchiveStateGuardListener): an mam-archivists member can archive
     and restore; an mam-editors member with plain Write is rejected
     with HTTP 403; Administrator can override. Uses disposable test
     users (test_editor, test_archivist), deleted at the end.
  6. Cleans up all created test documents/users and the local fixture,
     then stops the stack (volumes preserved).

  All state-changing requests (POST/PUT/PATCH/DELETE) go through the
  CSRF-aware helpers below (Invoke-NxRestMethod / Invoke-NxWebRequest),
  which perform the documented Nuxeo CSRF handshake (GET /nuxeo with
  `CSRF-Token: fetch`, session cookie preserved via -WebSession) and
  retry once on a rotated-token 403. CSRF enforcement is never disabled
  or bypassed.

  On failure the script collects container logs into logs/ and exits
  non-zero. Named volumes are NEVER deleted automatically -- clean
  them manually with `docker volume rm` when needed.
#>
[CmdletBinding()]
param(
    [string] $ProjectDir  = '',
    [string] $ComposeFile = 'compose.smoke.yaml',
    [string] $EnvFile     = '.env.smoke',
    [int]    $HealthTimeoutSec = 600,
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
    $samplePath = Join-Path $ProjectDir '.env.smoke.example'
    Write-Host "No $EnvFile found, falling back to .env.smoke.example."
    $envPath = $samplePath
}
if (-not (Test-Path $envPath)) {
    throw "Neither $EnvFile nor .env.smoke.example is present."
}

$envMap = @{}
Get-Content $envPath | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $k, $v = $line -split '=', 2
        $envMap[$k.Trim()] = $v.Trim()
    }
}

$nuxeoImage    = $envMap['NUXEO_IMAGE']
$hostPort      = if ($envMap['SMOKE_HOST_PORT']) { [int]$envMap['SMOKE_HOST_PORT'] } else { 8080 }
$adminUser     = $envMap['SMOKE_ADMIN_USER']
$adminPassword = $envMap['SMOKE_ADMIN_PASSWORD']

if (-not $adminUser -or -not $adminPassword) {
    throw "SMOKE_ADMIN_USER and SMOKE_ADMIN_PASSWORD must be set in $EnvFile."
}

$baseUrl   = "http://localhost:$hostPort/nuxeo"
$restUrl   = "$baseUrl/api/v1"
$container = 'mam-smoke-nuxeo'
$logDir    = Join-Path $ProjectDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$basicAuth = 'Basic ' + [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes("${adminUser}:${adminPassword}"))
$authHeaders    = @{ Authorization = $basicAuth }
$jsonHeaders    = $authHeaders + @{ 'Content-Type' = 'application/json' }

# ----- JWT Bearer auth (smoke-only HS256 secret) ----------------------
# Generated fresh for this run and handed to the smoke image at build time
# (see compose.smoke.yaml / Dockerfile.smoke) as mam.jwt.hmac.secret, which
# JwtBearerAuthenticator's HS256 fallback verifies against. Never written
# to disk, never reused across runs, and meaningless outside this
# disposable container.
$jwtSecretBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($jwtSecretBytes)
$jwtSecret = -join ($jwtSecretBytes | ForEach-Object { '{0:x2}' -f $_ })
$env:MAM_SMOKE_JWT_SECRET = $jwtSecret

function ConvertTo-Base64UrlBytes {
    param([byte[]] $Bytes)
    [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertTo-Base64UrlText {
    param([string] $Text)
    ConvertTo-Base64UrlBytes ([Text.Encoding]::UTF8.GetBytes($Text))
}

# Mints a disposable HS256 JWT signed with $jwtSecret, matching the claim
# shape JwtBearerAuthenticator expects (sub, iss, aud, exp, groups).
function New-NxJwt {
    param(
        [string]   $Subject,
        [string[]] $Groups = @(),
        [int]      $ExpiresInSeconds = 300,
        [switch]   $Expired
    )
    $header = @{ alg = 'HS256'; typ = 'JWT' } | ConvertTo-Json -Compress
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $exp = if ($Expired) { $now - 60 } else { $now + $ExpiresInSeconds }
    $payload = @{
        sub    = $Subject
        iss    = 'mam-smoke-harness'
        aud    = 'mam-platform'
        iat    = $now
        exp    = $exp
        groups = $Groups
    } | ConvertTo-Json -Compress
    $encHeader  = ConvertTo-Base64UrlText $header
    $encPayload = ConvertTo-Base64UrlText $payload
    $toSign = "$encHeader.$encPayload"
    $hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($jwtSecret))
    $sigBytes = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($toSign))
    $encSig = ConvertTo-Base64UrlBytes $sigBytes
    return "$toSign.$encSig"
}

# Temporary host fixture path (cleaned up in the finally-style block).
$fixtureHost = Join-Path $env:TEMP ("mam-fixture-{0}.mp4" -f ([Guid]::NewGuid().ToString('N').Substring(0,8)))

# Track created documents so failure paths can still remove them.
$createdPaths = @()

# ----- Local helpers -------------------------------------------------
function Invoke-Compose {
    param([string[]] $ComposeArgs)
    & docker compose --env-file $EnvFile -f $ComposeFile @ComposeArgs
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose $($ComposeArgs -join ' ') failed with exit $LASTEXITCODE"
    }
}

# ----- CSRF/session bootstrap -----------------------------------------
# Nuxeo's NuxeoCorsCsrfFilter requires state-changing requests (POST/PUT/
# PATCH/DELETE) to carry a valid `CSRF-Token` header once
# `nuxeo.csrf.token.enabled=true` (as set by Dockerfile.smoke). The token
# is obtained via the documented handshake -- `GET /nuxeo` with header
# `CSRF-Token: fetch` -- and is bound to the session cookie returned by
# that same call, so the cookie must be preserved and replayed on every
# subsequent request. This mirrors the working Node smoke scripts
# (scripts/review-queue-task-e2e.mjs, etc.): GET /nuxeo -> keep the
# session cookie -> attach CSRF-Token to every unsafe verb -> on a
# 403 + `CSRF-Token: invalid` response (rotated token), refetch once and
# retry the original request. GET requests never need the header and are
# left untouched by this logic; a 403 without that specific invalidation
# signal (e.g. a real permission denial from the archive guard) is never
# swallowed or retried -- it propagates exactly as before.
# Sessions are keyed by the exact Authorization header value, one
# per principal (WebSession/JSESSIONID cookie + CSRF-Token pair). This
# is required, not just a defensive choice: Nuxeo's authentication
# binds identity to the session cookie once established, so replaying
# a *different* Basic-auth header on top of an *already-established*
# session cookie continues to resolve as whichever principal first
# created that session -- reusing a single shared session across
# multiple test users would silently authenticate every later call as
# the first user (e.g. Administrator), masking real 403s. This mirrors
# the per-principal cookie-jar pattern used by the working Node smoke
# scripts (scripts/review-queue-task-e2e.mjs: `jarFor(auth)`).
$script:NxSessions = @{}

function Get-NxSessionState {
    param([hashtable] $AuthHeader)
    $key = $AuthHeader.Authorization
    if (-not $script:NxSessions.ContainsKey($key)) {
        $script:NxSessions[$key] = @{ WebSession = $null; CsrfToken = $null }
    }
    return $script:NxSessions[$key]
}

function Get-NxCsrfToken {
    param([hashtable] $AuthHeader, [switch] $Force)
    $state = Get-NxSessionState -AuthHeader $AuthHeader
    if (-not $Force -and $state.CsrfToken) { return $state.CsrfToken }
    $fetchHeaders = $AuthHeader + @{ 'CSRF-Token' = 'fetch' }
    if ($state.WebSession) {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri $baseUrl -Headers $fetchHeaders `
                                  -WebSession $state.WebSession -TimeoutSec 15
    } else {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri $baseUrl -Headers $fetchHeaders `
                                  -SessionVariable nxSess -TimeoutSec 15
        $state.WebSession = $nxSess
    }
    $token = $resp.Headers['CSRF-Token']
    if ($token -is [array]) { $token = $token[0] }
    $state.CsrfToken = $token
    return $state.CsrfToken
}

# Shared core for both the JSON (Invoke-RestMethod) and raw
# (Invoke-WebRequest) call shapes used throughout this script. Ensures
# the session/cookie for the calling principal (identified by its
# Authorization header) is established, attaches CSRF-Token only to
# unsafe methods, and retries exactly once if the server signals the
# token was rotated (`CSRF-Token: invalid` on a 403 response). Any
# other error -- including a genuine 403 permission denial from the
# archive guard -- propagates unmodified.
function Invoke-NxHttp {
    param(
        [string]    $Uri,
        [string]    $Method  = 'GET',
        [hashtable] $Headers = @{},
        $Body        = $null,
        [int]       $TimeoutSec = 30,
        [switch]    $Raw
    )
    if (-not $Headers.Authorization) {
        throw "Invoke-NxHttp: Headers must include an Authorization entry identifying the calling principal."
    }
    $authOnly = @{ Authorization = $Headers.Authorization }
    $state = Get-NxSessionState -AuthHeader $authOnly
    if (-not $state.WebSession) { Get-NxCsrfToken -AuthHeader $authOnly | Out-Null }
    $unsafe = $Method -in @('POST', 'PUT', 'PATCH', 'DELETE')

    $send = {
        param([hashtable] $h)
        $params = @{
            Uri        = $Uri
            Method     = $Method
            Headers    = $h
            WebSession = $state.WebSession
            TimeoutSec = $TimeoutSec
        }
        if ($null -ne $Body) { $params['Body'] = $Body }
        if ($Raw) { Invoke-WebRequest -UseBasicParsing @params } else { Invoke-RestMethod @params }
    }

    $reqHeaders = $Headers + @{}
    if ($unsafe -and $state.CsrfToken) { $reqHeaders['CSRF-Token'] = $state.CsrfToken }

    try {
        return & $send $reqHeaders
    } catch {
        $resp = $_.Exception.Response
        $csrfInvalid = $false
        if ($unsafe -and $resp) {
            try {
                $vals = $resp.Headers.GetValues('CSRF-Token')
                if ($vals -contains 'invalid') { $csrfInvalid = $true }
            } catch { }
        }
        if (-not $csrfInvalid) { throw }
        Get-NxCsrfToken -AuthHeader $authOnly -Force | Out-Null
        $reqHeaders['CSRF-Token'] = $state.CsrfToken
        return & $send $reqHeaders
    }
}

function Invoke-NxRestMethod {
    param([string] $Uri, [string] $Method = 'GET', [hashtable] $Headers = @{}, $Body = $null, [int] $TimeoutSec = 30)
    Invoke-NxHttp -Uri $Uri -Method $Method -Headers $Headers -Body $Body -TimeoutSec $TimeoutSec
}

function Invoke-NxWebRequest {
    param([string] $Uri, [string] $Method = 'GET', [hashtable] $Headers = @{}, $Body = $null, [int] $TimeoutSec = 30)
    Invoke-NxHttp -Uri $Uri -Method $Method -Headers $Headers -Body $Body -TimeoutSec $TimeoutSec -Raw
}

function Remove-CreatedDocs {
    foreach ($p in $createdPaths) {
        try {
            Invoke-NxWebRequest -Uri "$restUrl/path$p" -Headers $authHeaders `
                                -Method Delete -TimeoutSec 15 | Out-Null
            Write-Host "  Deleted: $p"
        } catch {
            Write-Host "  WARN: cleanup of $p failed: $($_.Exception.Message)"
        }
    }
    if (Test-Path $fixtureHost) { Remove-Item -Force $fixtureHost }
}

function Collect-LogsAndFail {
    param([string] $Reason)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $logFile = Join-Path $logDir ("nuxeo-{0}.log" -f $stamp)
    $serverLogFile = Join-Path $logDir ("nuxeo-server-{0}.log" -f $stamp)
    Write-Host "Collecting container logs into $logFile and $serverLogFile"
    try { docker logs $container *>&1 | Out-File -FilePath $logFile -Encoding utf8 } catch { }
    try {
        docker exec $container bash -c 'tail -n 500 /var/log/nuxeo/server.log' *>&1 |
            Out-File -FilePath $serverLogFile -Encoding utf8
    } catch { }
    Remove-CreatedDocs
    Write-Host "Stopping the stack (volumes preserved)..."
    try { docker compose --env-file $EnvFile -f $ComposeFile down } catch { }
    Write-Host "SMOKE TEST FAILED: $Reason" -ForegroundColor Red
    exit 1
}

# ----- 1. Verify prerequisite image exists ---------------------------
Write-Host "[1/9] Checking base image $nuxeoImage exists locally..."
$img = docker image inspect $nuxeoImage --format '{{.Id}}' 2>$null
if (-not $img) {
    Write-Host "SMOKE TEST FAILED: base image $nuxeoImage is not present in the local daemon." -ForegroundColor Red
    exit 1
}

# ----- 2. Verify addon zip exists ------------------------------------
Write-Host "[2/9] Checking mam-package ZIP exists..."
$zipPath = Join-Path $ProjectDir 'mam-package\target\mam-package-1.0.0-SNAPSHOT.zip'
if (-not (Test-Path $zipPath)) {
    Write-Host "SMOKE TEST FAILED: $zipPath is missing. Run 'mvn -DskipTests package' first." -ForegroundColor Red
    exit 1
}

# ----- 3. Build and start the smoke stack ----------------------------
Write-Host "[3/9] Building smoke image and starting the stack..."
Invoke-Compose @('build')
Invoke-Compose @('up', '-d')

# ----- 4. Wait for /runningstatus ------------------------------------
Write-Host "[4/9] Waiting for Nuxeo to become healthy (up to $HealthTimeoutSec s)..."
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
Write-Host "  Nuxeo is up."

# ----- 5. BroadcastAsset: doctype + metadata round-trip --------------
Write-Host "[5/9] Verifying BroadcastAsset registration and metadata round-trip..."
try {
    $ba = Invoke-NxRestMethod -Uri "$restUrl/config/types/BroadcastAsset" `
                              -Headers $authHeaders -TimeoutSec 15
} catch { Collect-LogsAndFail "GET /config/types/BroadcastAsset failed: $($_.Exception.Message)" }
if ($ba.name -ne 'BroadcastAsset' -or $ba.'entity-type' -ne 'docType') {
    Collect-LogsAndFail "BroadcastAsset not reported by /config/types."
}
if (-not ($ba.schemas | Where-Object { $_.name -eq 'broadcast' })) {
    Collect-LogsAndFail "BroadcastAsset is missing the 'broadcast' schema."
}
Write-Host "  Doctype BroadcastAsset is registered."

$targetPath = '/default-domain/workspaces'
try {
    Invoke-NxRestMethod -Uri "$restUrl/path$targetPath" -Headers $authHeaders -TimeoutSec 15 | Out-Null
} catch { Collect-LogsAndFail "Cannot read $targetPath : $($_.Exception.Message)" }

$assetName  = "mam-smoke-asset-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$assetTitle = "MAM smoke asset $(Get-Date -Format o)"
$assetBody = @{
    'entity-type' = 'document'
    name          = $assetName
    type          = 'BroadcastAsset'
    properties    = @{
        'dc:title'                 = $assetTitle
        'broadcast:slug'           = 'smoke-slug-asset'
        'broadcast:programme'      = 'Smoke Test Bulletin'
        'broadcast:editorialStatus'= 'draft'
        'broadcast:archiveState'   = 'hot'
    }
} | ConvertTo-Json -Depth 5

try {
    $createdAsset = Invoke-NxRestMethod -Uri "$restUrl/path$targetPath" `
                                        -Headers $jsonHeaders -Method Post `
                                        -Body $assetBody -TimeoutSec 30
} catch { Collect-LogsAndFail "BroadcastAsset create failed: $($_.Exception.Message)" }
if ($createdAsset.type -ne 'BroadcastAsset') {
    Collect-LogsAndFail "Created doc type mismatch: $($createdAsset.type)"
}
$createdPaths += $createdAsset.path
Write-Host "  Created: $($createdAsset.path)"

try {
    $fetched = Invoke-NxRestMethod -Uri "$restUrl/path$($createdAsset.path)" `
                                   -Headers ($authHeaders + @{ 'X-NXproperties' = '*' }) `
                                   -TimeoutSec 15
} catch { Collect-LogsAndFail "Asset read-back failed: $($_.Exception.Message)" }

$expected = @{
    'dc:title'                  = $assetTitle
    'broadcast:slug'            = 'smoke-slug-asset'
    'broadcast:programme'       = 'Smoke Test Bulletin'
    'broadcast:editorialStatus' = 'draft'
    'broadcast:archiveState'    = 'hot'
}
foreach ($k in $expected.Keys) {
    $actual = $fetched.properties.$k
    if ($actual -ne $expected[$k]) {
        Collect-LogsAndFail "Asset property mismatch on $k : expected '$($expected[$k])', got '$actual'."
    }
    Write-Host "  OK  $k = $actual"
}

# 5b: Metadata update round-trip (PUT) -- exercises the CSRF-protected
#     update path distinctly from document creation above.
$updatedProgramme = 'Smoke Test Bulletin (updated)'
$updateBody = @{
    'entity-type' = 'document'
    uid           = $fetched.uid
    properties    = @{ 'broadcast:programme' = $updatedProgramme }
} | ConvertTo-Json -Depth 5
try {
    Invoke-NxRestMethod -Uri "$restUrl/id/$($fetched.uid)" -Headers $jsonHeaders `
                        -Method Put -Body $updateBody -TimeoutSec 15 | Out-Null
} catch { Collect-LogsAndFail "Asset metadata update (PUT) failed: $($_.Exception.Message)" }
try {
    $reupdated = Invoke-NxRestMethod -Uri "$restUrl/path$($createdAsset.path)" `
                                     -Headers ($authHeaders + @{ 'X-NXproperties' = '*' }) `
                                     -TimeoutSec 15
} catch { Collect-LogsAndFail "Asset read-back after update failed: $($_.Exception.Message)" }
if ($reupdated.properties.'broadcast:programme' -ne $updatedProgramme) {
    Collect-LogsAndFail "Metadata update did not persist: expected '$updatedProgramme', got '$($reupdated.properties.'broadcast:programme')'."
}
Write-Host "  OK  metadata update persisted: broadcast:programme = $($reupdated.properties.'broadcast:programme')"

# ----- 6. BroadcastVideo: registration, upload, transcode ------------
Write-Host "[6/9] Verifying BroadcastVideo pipeline (registration + upload + transcode)..."

# 6a: Doctype + Video facet inherited from BroadcastAsset chain.
try {
    $bv = Invoke-NxRestMethod -Uri "$restUrl/config/types/BroadcastVideo" `
                              -Headers $authHeaders -TimeoutSec 15
} catch { Collect-LogsAndFail "GET /config/types/BroadcastVideo failed: $($_.Exception.Message)" }
if ($bv.name -ne 'BroadcastVideo' -or $bv.'entity-type' -ne 'docType') {
    Collect-LogsAndFail "BroadcastVideo not reported by /config/types (name='$($bv.name)')."
}
if ($bv.parent -ne 'BroadcastAsset') {
    Collect-LogsAndFail "BroadcastVideo parent expected BroadcastAsset, got '$($bv.parent)'."
}
if (-not ($bv.facets -contains 'Video')) {
    Collect-LogsAndFail "BroadcastVideo does not carry the Video facet (facets=$($bv.facets -join ','))."
}
if (-not ($bv.schemas | Where-Object { $_.name -eq 'broadcast' })) {
    Collect-LogsAndFail "BroadcastVideo inherited schemas missing 'broadcast'."
}
if (-not ($bv.schemas | Where-Object { $_.name -eq 'video' })) {
    Collect-LogsAndFail "BroadcastVideo is missing the 'video' schema attached by the Video facet."
}
Write-Host "  Doctype BroadcastVideo is registered with the Video facet."

# 6b: Verify FFmpeg is present in the smoke image.
$ffmpegVersion = docker exec $container bash -c 'ffmpeg -version 2>/dev/null | head -n1'
if (-not $ffmpegVersion) {
    Collect-LogsAndFail "ffmpeg not present in the smoke image; cannot generate fixture."
}
Write-Host "  In-container ffmpeg: $ffmpegVersion"

# 6c: Generate an ~12s H.264/AAC MP4 fixture inside the container,
#     then copy it to the host tmp dir.
$fixtureInContainer = '/tmp/mam-fixture.mp4'
$ffmpegCmd = @(
    'ffmpeg -y -v error',
    '-f lavfi -i testsrc=duration=12:size=320x240:rate=25',
    '-f lavfi -i sine=frequency=1000:duration=12',
    '-c:v libx264 -preset ultrafast -pix_fmt yuv420p',
    '-c:a aac -b:a 64k',
    '-shortest',
    "$fixtureInContainer"
) -join ' '
docker exec $container bash -c $ffmpegCmd
if ($LASTEXITCODE -ne 0) {
    Collect-LogsAndFail "In-container ffmpeg fixture generation failed."
}
docker cp "${container}:${fixtureInContainer}" $fixtureHost | Out-Null
if (-not (Test-Path $fixtureHost) -or (Get-Item $fixtureHost).Length -lt 10000) {
    Collect-LogsAndFail "Fixture MP4 was not copied to the host (or is too small)."
}
Write-Host "  Fixture created: $fixtureHost ($((Get-Item $fixtureHost).Length) bytes)"

# 6d: Nuxeo Batch Upload.
try {
    $batch = Invoke-NxRestMethod -Uri "$restUrl/upload/" -Headers $authHeaders `
                                 -Method Post -TimeoutSec 30
} catch { Collect-LogsAndFail "Batch init failed: $($_.Exception.Message)" }
$batchId = $batch.batchId
if (-not $batchId) { Collect-LogsAndFail "Batch init returned no batchId." }

$fixtureBytes = [IO.File]::ReadAllBytes($fixtureHost)
# Note: Content-Length is deliberately not set here. It's computed
# automatically from the body, and -- now that requests share a
# WebSession for CSRF/cookie continuity -- a manually pinned
# Content-Length header persists on the underlying HttpClient's default
# headers across subsequent requests on the same session, corrupting
# later calls (e.g. the BroadcastVideo JSON create right after this).
$uploadHeaders = $authHeaders + @{
    'Content-Type'         = 'video/mp4'
    'X-File-Name'          = 'fixture.mp4'
    'X-File-Type'          = 'video/mp4'
    'X-Upload-Type'        = 'normal'
}
try {
    Invoke-NxRestMethod -Uri "$restUrl/upload/$batchId/0" -Headers $uploadHeaders `
                        -Method Post -Body $fixtureBytes -TimeoutSec 120 | Out-Null
} catch { Collect-LogsAndFail "Batch upload failed: $($_.Exception.Message)" }
Write-Host "  Uploaded fixture as batchId=$batchId file 0."

# 6e: Create BroadcastVideo.
$videoName  = "mam-smoke-video-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$videoTitle = "MAM smoke video $(Get-Date -Format o)"
$videoBody = @{
    'entity-type' = 'document'
    name          = $videoName
    type          = 'BroadcastVideo'
    properties    = @{
        'dc:title'                 = $videoTitle
        'file:content'             = @{
            'upload-batch'  = $batchId
            'upload-fileId' = '0'
        }
        'broadcast:slug'           = 'smoke-slug-video'
        'broadcast:programme'      = 'Smoke Test Bulletin'
        'broadcast:editorialStatus'= 'draft'
        'broadcast:archiveState'   = 'hot'
    }
} | ConvertTo-Json -Depth 6

try {
    $createdVideo = Invoke-NxRestMethod -Uri "$restUrl/path$targetPath" `
                                        -Headers $jsonHeaders -Method Post `
                                        -Body $videoBody -TimeoutSec 60
} catch { Collect-LogsAndFail "BroadcastVideo create failed: $($_.Exception.Message)" }
if ($createdVideo.type -ne 'BroadcastVideo') {
    Collect-LogsAndFail "Created video doc type mismatch: '$($createdVideo.type)'."
}
$videoUid  = $createdVideo.uid
$videoPath = $createdVideo.path
$createdPaths += $videoPath
Write-Host "  Created BroadcastVideo: $videoPath"

# 6f: Poll for transcoded renditions.
Write-Host "  Polling up to ${TranscodeTimeoutSec}s for video:transcodedVideos..."
$pollDeadline = (Get-Date).AddSeconds($TranscodeTimeoutSec)
$transcoded   = @()
$videoInfo    = $null
while ((Get-Date) -lt $pollDeadline) {
    try {
        $doc = Invoke-NxRestMethod -Uri "$restUrl/id/$videoUid" `
                                   -Headers ($authHeaders + @{ 'properties' = '*' }) `
                                   -TimeoutSec 15
        # Nuxeo's video schema is registered with prefix `vid`, so the
        # property is exposed as `vid:transcodedVideos` (not `video:...`).
        $tv  = $doc.properties.'vid:transcodedVideos'
        if ($tv -and $tv.Count -gt 0) {
            $transcoded = $tv
            $videoInfo  = $doc.properties.'vid:info'
            break
        }
    } catch { }
    Start-Sleep -Seconds 5
}
if ($transcoded.Count -eq 0) {
    Collect-LogsAndFail "vid:transcodedVideos remained empty after ${TranscodeTimeoutSec}s."
}
$names = ($transcoded | ForEach-Object { $_.name }) -join ','
Write-Host "  Transcoded renditions: $names"

# 6g: Broadcast fields still readable on BroadcastVideo.
try {
    $reread = Invoke-NxRestMethod -Uri "$restUrl/id/$videoUid" `
                                  -Headers ($authHeaders + @{ 'X-NXproperties' = '*' }) `
                                  -TimeoutSec 15
} catch { Collect-LogsAndFail "BroadcastVideo read-back failed: $($_.Exception.Message)" }

$expectedVideo = @{
    'dc:title'                  = $videoTitle
    'broadcast:slug'            = 'smoke-slug-video'
    'broadcast:programme'       = 'Smoke Test Bulletin'
    'broadcast:editorialStatus' = 'draft'
    'broadcast:archiveState'    = 'hot'
}
foreach ($k in $expectedVideo.Keys) {
    $actual = $reread.properties.$k
    if ($actual -ne $expectedVideo[$k]) {
        Collect-LogsAndFail "Video property mismatch on $k : expected '$($expectedVideo[$k])', got '$actual'."
    }
    Write-Host "  OK  $k = $actual"
}

# 6h: Thumbnail rendition fetch. Nuxeo's rendition endpoint is async
#     by default -- it returns 202 and expects the caller to poll --
#     but supports `?sync=true` to force synchronous computation and
#     return the JPEG in one call. That is what the thumbnail enricher
#     documents (its `url` contextParameter has sync=true set).
$thumbResp = $null
$thumbDeadline = (Get-Date).AddSeconds(120)
$lastErr = $null
while ((Get-Date) -lt $thumbDeadline) {
    try {
        $thumbResp = Invoke-NxWebRequest -Uri "$restUrl/id/$videoUid/@rendition/thumbnail?sync=true" `
                                         -Headers $authHeaders -TimeoutSec 60
        if ($thumbResp.StatusCode -eq 200 -and $thumbResp.Content.Length -ge 100) { break }
    } catch { $lastErr = $_.Exception.Message }
    Start-Sleep -Seconds 5
}
if (-not $thumbResp -or $thumbResp.StatusCode -ne 200 -or $thumbResp.Content.Length -lt 100) {
    Collect-LogsAndFail "Thumbnail rendition fetch failed within 120s: $lastErr"
}
if ($thumbResp.StatusCode -ne 200 -or $thumbResp.Content.Length -lt 100) {
    Collect-LogsAndFail "Thumbnail rendition unexpectedly empty (status=$($thumbResp.StatusCode), bytes=$($thumbResp.Content.Length))."
}
$thumbCT = $thumbResp.Headers['Content-Type']
Write-Host "  Thumbnail rendition: $($thumbResp.Content.Length) bytes, Content-Type=$thumbCT"

# ----- 7. Archive authorization enforcement (server-side guard) ------
# Exercises ArchiveStateGuardListener through the real REST API, using
# the same CSRF-aware helpers as every other call in this script.
# Isolated, disposable test users -- created here, deleted at the end
# regardless of outcome.
Write-Host "[7/9] Verifying archive authorization enforcement..."

$testEditorUser     = 'test_editor'
$testEditorPassword = 'TestEditor!2026'
$testArchivistUser     = 'test_archivist'
$testArchivistPassword = 'TestArchivist!2026'
$createdTestUsers = @()

function New-NxTestUser {
    param([string] $Username, [string] $Password, [string] $Group)
    $body = @{
        'entity-type' = 'user'
        properties    = @{
            username  = $Username
            firstName = $Username
            lastName  = 'Smoke'
            email     = "$Username@example.test"
            password  = $Password
            groups    = @($Group)
        }
    } | ConvertTo-Json -Depth 5
    try {
        Invoke-NxRestMethod -Uri "$restUrl/user" -Headers $jsonHeaders -Method Post -Body $body -TimeoutSec 15 | Out-Null
    } catch {
        # 409 = already exists from a previous interrupted run; safe to reuse.
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -ne 409) { throw }
    }
    $script:createdTestUsers += $Username
}

function Remove-NxTestUser {
    param([string] $Username)
    try {
        Invoke-NxWebRequest -Uri "$restUrl/user/$Username" -Headers $authHeaders -Method Delete -TimeoutSec 15 | Out-Null
        Write-Host "  Deleted test user: $Username"
    } catch {
        Write-Host "  WARN: cleanup of test user $Username failed: $($_.Exception.Message)"
    }
}

function Get-NxAuthHeader {
    param([string] $Username, [string] $Password)
    @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${Username}:${Password}")) }
}

try {
    New-NxTestUser -Username $testEditorUser -Password $testEditorPassword -Group 'mam-editors'
    New-NxTestUser -Username $testArchivistUser -Password $testArchivistPassword -Group 'mam-archivists'
    Write-Host "  Created test users: $testEditorUser (mam-editors), $testArchivistUser (mam-archivists)"

    # A fresh BroadcastAsset dedicated to the archive-guard checks, kept
    # separate from the asset created in step 5 above.
    $guardAssetName = "mam-smoke-guard-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
    $guardBody = @{
        'entity-type' = 'document'
        name          = $guardAssetName
        type          = 'BroadcastAsset'
        properties    = @{
            'dc:title'                  = "MAM smoke archive-guard asset $(Get-Date -Format o)"
            'broadcast:slug'            = 'smoke-slug-guard'
            'broadcast:editorialStatus' = 'approved'
            'broadcast:archiveState'    = 'hot'
        }
    } | ConvertTo-Json -Depth 5
    $guardDoc = Invoke-NxRestMethod -Uri "$restUrl/path$targetPath" -Headers $jsonHeaders -Method Post -Body $guardBody -TimeoutSec 30
    $createdPaths += $guardDoc.path
    Write-Host "  Created archive-guard test asset: $($guardDoc.path)"

    # Grant both test users standard Read+Write via ACL. The archivist
    # additionally needs the MAM_ArchivistAccess bundle (Read+Write+
    # MAM_EditMetadata+MAM_Archive) to actually be able to change
    # archiveState; the editor deliberately gets ONLY Write, to prove the
    # guard blocks archiveState changes even with Write already granted.
    $grantEditorBody = @{ input = "doc:$($guardDoc.uid)"; params = @{ username = $testEditorUser; permission = 'ReadWrite' } } | ConvertTo-Json -Depth 5
    Invoke-NxRestMethod -Uri "$restUrl/id/$($guardDoc.uid)/@op/Document.AddPermission" -Headers $jsonHeaders -Method Post -Body $grantEditorBody -TimeoutSec 15 | Out-Null

    $grantArchivistBody = @{ input = "doc:$($guardDoc.uid)"; params = @{ username = $testArchivistUser; permission = 'MAM_ArchivistAccess' } } | ConvertTo-Json -Depth 5
    Invoke-NxRestMethod -Uri "$restUrl/id/$($guardDoc.uid)/@op/Document.AddPermission" -Headers $jsonHeaders -Method Post -Body $grantArchivistBody -TimeoutSec 15 | Out-Null
    Write-Host "  Granted ACLs to both test users."

    # Test A: archivist CAN archive (hot -> cold).
    $archivistAuth = Get-NxAuthHeader -Username $testArchivistUser -Password $testArchivistPassword
    $archiveCold = @{ 'entity-type' = 'document'; uid = $guardDoc.uid; properties = @{ 'broadcast:archiveState' = 'cold' } } | ConvertTo-Json -Depth 5
    try {
        Invoke-NxRestMethod -Uri "$restUrl/id/$($guardDoc.uid)" -Headers ($archivistAuth + @{ 'Content-Type' = 'application/json' }) `
                            -Method Put -Body $archiveCold -TimeoutSec 15 | Out-Null
    } catch { Collect-LogsAndFail "Test A (archivist archives) unexpectedly failed: $($_.Exception.Message)" }
    $afterA = Invoke-NxRestMethod -Uri "$restUrl/id/$($guardDoc.uid)" -Headers ($authHeaders + @{ 'properties' = 'broadcast' }) -TimeoutSec 15
    if ($afterA.properties.'broadcast:archiveState' -ne 'cold') {
        Collect-LogsAndFail "Test A (archivist archives): expected archiveState=cold, got '$($afterA.properties.'broadcast:archiveState')'."
    }
    Write-Host "  Test A PASSED: $testArchivistUser (mam-archivists) archived the asset (archiveState=cold)."

    # Test B: editor CANNOT archive -- expect HTTP 403, state unchanged.
    # Current state after Test A is 'cold'; the editor attempts an actual
    # transition (cold -> hot). Attempting a no-op write of the SAME value
    # would trivially "succeed" without exercising the guard at all, since
    # ArchiveStateGuardListener only fires when the value actually changes.
    $editorAuth = Get-NxAuthHeader -Username $testEditorUser -Password $testEditorPassword
    $archiveHotAttempt = @{ 'entity-type' = 'document'; uid = $guardDoc.uid; properties = @{ 'broadcast:archiveState' = 'hot' } } | ConvertTo-Json -Depth 5
    $gotExpected403 = $false
    try {
        Invoke-NxRestMethod -Uri "$restUrl/id/$($guardDoc.uid)" -Headers ($editorAuth + @{ 'Content-Type' = 'application/json' }) `
                            -Method Put -Body $archiveHotAttempt -TimeoutSec 15 | Out-Null
    } catch {
        $resp = $_.Exception.Response
        if ($resp -and $resp.StatusCode.value__ -eq 403) { $gotExpected403 = $true }
        else { Collect-LogsAndFail "Test B (editor archives): expected HTTP 403, got: $($_.Exception.Message)" }
    }
    if (-not $gotExpected403) {
        Collect-LogsAndFail "Test B (editor archives): request unexpectedly succeeded; the archive guard did not block it."
    }
    $afterB = Invoke-NxRestMethod -Uri "$restUrl/id/$($guardDoc.uid)" -Headers ($authHeaders + @{ 'properties' = 'broadcast' }) -TimeoutSec 15
    if ($afterB.properties.'broadcast:archiveState' -ne 'cold') {
        Collect-LogsAndFail "Test B (editor archives): archiveState should remain unchanged (cold), got '$($afterB.properties.'broadcast:archiveState')'."
    }
    Write-Host "  Test B PASSED: $testEditorUser (mam-editors, Write only) got HTTP 403 attempting to change archiveState (cold -> hot); state unchanged."

    # Test C: Administrator CAN restore (cold -> hot).
    $restoreHot = @{ 'entity-type' = 'document'; uid = $guardDoc.uid; properties = @{ 'broadcast:archiveState' = 'hot' } } | ConvertTo-Json -Depth 5
    try {
        Invoke-NxRestMethod -Uri "$restUrl/id/$($guardDoc.uid)" -Headers $jsonHeaders -Method Put -Body $restoreHot -TimeoutSec 15 | Out-Null
    } catch { Collect-LogsAndFail "Test C (administrator restores) unexpectedly failed: $($_.Exception.Message)" }
    $afterC = Invoke-NxRestMethod -Uri "$restUrl/id/$($guardDoc.uid)" -Headers ($authHeaders + @{ 'properties' = 'broadcast' }) -TimeoutSec 15
    if ($afterC.properties.'broadcast:archiveState' -ne 'hot') {
        Collect-LogsAndFail "Test C (administrator restores): expected archiveState=hot, got '$($afterC.properties.'broadcast:archiveState')'."
    }
    Write-Host "  Test C PASSED: Administrator restored the asset (archiveState=hot)."

    Write-Host "  Archive authorization enforcement verified (archivist can archive/restore, editor with Write cannot, administrator can override)."
} finally {
    foreach ($u in $createdTestUsers) { Remove-NxTestUser -Username $u }
}

# ----- 8. OIDC/OAuth2 JWT Bearer authentication ------------------------
# Exercises com.mam.platform.security.auth.JwtBearerAuthenticator end to
# end via the smoke image's HS256 fallback (mam.jwt.hmac.secret, baked in
# at build time from $jwtSecret above). No cookie/session is involved:
# every request below is a bare GET with only an Authorization header,
# so none of it touches the CSRF token machinery.
Write-Host "[8/9] Verifying OIDC/OAuth2 JWT Bearer authentication..."

# 8a: No Authorization header at all -> 401.
try {
    Invoke-WebRequest -UseBasicParsing -Uri "$restUrl/me" -TimeoutSec 15 -ErrorAction Stop | Out-Null
    Collect-LogsAndFail "Test D (no credentials): expected HTTP 401, but the request unexpectedly succeeded."
} catch {
    $resp = $_.Exception.Response
    if (-not $resp -or $resp.StatusCode.value__ -ne 401) {
        Collect-LogsAndFail "Test D (no credentials): expected HTTP 401, got: $($_.Exception.Message)"
    }
}
Write-Host "  Test D PASSED: unauthenticated request to /me got HTTP 401."

# 8b: Garbage / unsigned Bearer token -> 401.
try {
    Invoke-WebRequest -UseBasicParsing -Uri "$restUrl/me" -TimeoutSec 15 -ErrorAction Stop `
                      -Headers @{ Authorization = 'Bearer not-a-real-jwt' } | Out-Null
    Collect-LogsAndFail "Test E (garbage bearer token): expected HTTP 401, but the request unexpectedly succeeded."
} catch {
    $resp = $_.Exception.Response
    if (-not $resp -or $resp.StatusCode.value__ -ne 401) {
        Collect-LogsAndFail "Test E (garbage bearer token): expected HTTP 401, got: $($_.Exception.Message)"
    }
}
Write-Host "  Test E PASSED: invalid Bearer token got HTTP 401."

# 8c: Expired Bearer token -> 401.
$expiredJwt = New-NxJwt -Subject 'mam_smoke_jwt_user' -Groups @('mam-editors') -Expired
try {
    Invoke-WebRequest -UseBasicParsing -Uri "$restUrl/me" -TimeoutSec 15 -ErrorAction Stop `
                      -Headers @{ Authorization = "Bearer $expiredJwt" } | Out-Null
    Collect-LogsAndFail "Test F (expired bearer token): expected HTTP 401, but the request unexpectedly succeeded."
} catch {
    $resp = $_.Exception.Response
    if (-not $resp -or $resp.StatusCode.value__ -ne 401) {
        Collect-LogsAndFail "Test F (expired bearer token): expected HTTP 401, got: $($_.Exception.Message)"
    }
}
Write-Host "  Test F PASSED: expired Bearer token got HTTP 401."

# 8d: Valid Bearer token -> 200, with claims correctly mapped onto MAM
#     groups (JIT-provisioned by JwtBearerAuthenticator on first use).
$validJwt = New-NxJwt -Subject 'mam_smoke_jwt_user' -Groups @('mam-archivists')
try {
    $me = Invoke-NxRestMethod -Uri "$restUrl/me" -TimeoutSec 15 `
                              -Headers @{ Authorization = "Bearer $validJwt" }
} catch { Collect-LogsAndFail "Test G (valid bearer token) unexpectedly failed: $($_.Exception.Message)" }
if ($me.properties.username -ne 'mam_smoke_jwt_user') {
    Collect-LogsAndFail "Test G: expected principal 'mam_smoke_jwt_user', got '$($me.properties.username)'."
}
if (-not ($me.properties.groups -contains 'mam-archivists')) {
    $meGroups = $me.properties.groups -join ','
    Collect-LogsAndFail "Test G: JWT 'groups' claim (mam-archivists) was not mapped onto the Nuxeo user (groups: $meGroups)."
}
Write-Host "  Test G PASSED: valid Bearer token authenticated as 'mam_smoke_jwt_user' with mam-archivists membership."

# 8e: The JIT-provisioned Bearer-only user must NOT be usable via Basic
#     auth (no password was ever set for it) -- this is the "Basic Auth
#     is not a viable path for JWT-issued identities" half of the
#     production lockdown requirement, provable without needing the
#     production-only basic-auth-disable-config.xml fragment (which is
#     deliberately not applied to the smoke image; see that file's
#     header comment for why).
$bearerUserBasicAuth = 'Basic ' + [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes('mam_smoke_jwt_user:anything'))
try {
    Invoke-WebRequest -UseBasicParsing -Uri "$restUrl/me" -TimeoutSec 15 -ErrorAction Stop `
                      -Headers @{ Authorization = $bearerUserBasicAuth } | Out-Null
    Collect-LogsAndFail "Test H (Basic auth against JWT-provisioned user): expected HTTP 401, but succeeded."
} catch {
    $resp = $_.Exception.Response
    if (-not $resp -or $resp.StatusCode.value__ -ne 401) {
        Collect-LogsAndFail "Test H (Basic auth against JWT-provisioned user): expected HTTP 401, got: $($_.Exception.Message)"
    }
}
Write-Host "  Test H PASSED: the JWT-provisioned user has no usable password; Basic auth against it got HTTP 401."

Write-Host "  OIDC/OAuth2 JWT Bearer authentication verified (401 without/with-invalid/with-expired token, 200 with a valid token, claims mapped to mam-archivists, no Basic-auth fallback for JWT-provisioned identities)."

# Clean up the JIT-provisioned smoke JWT user so no leftover test
# identity survives the run.
try {
    Invoke-NxWebRequest -Uri "$restUrl/user/mam_smoke_jwt_user" -Headers $authHeaders -Method Delete -TimeoutSec 15 | Out-Null
    Write-Host "  Deleted JWT smoke test user: mam_smoke_jwt_user"
} catch {
    Write-Host "  WARN: cleanup of mam_smoke_jwt_user failed: $($_.Exception.Message)"
}

# ----- 9. Cleanup + stop ---------------------------------------------
Write-Host "[9/9] Cleaning up test documents and stopping the stack..."
Remove-CreatedDocs
$createdPaths = @()
Invoke-Compose @('down')

Write-Host ""
Write-Host "SMOKE TEST PASSED" -ForegroundColor Green
exit 0
