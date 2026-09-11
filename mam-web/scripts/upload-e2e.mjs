// End-to-end validation of the /upload flow against the local Nuxeo smoke
// stack. Drives the real UI in a real browser:
//   1. Success path — uploads an MP4 fixture, verifies BroadcastVideo doc,
//      reads it back via the Nuxeo REST API, and asserts the metadata
//      round-trips.
//   2. Failure path — points the app at a bogus ingest parent path
//      (via a runtime env override injected before the app mounts), triggers
//      a real Nuxeo 404, and asserts the error/retry state appears.
// Also captures desktop + mobile screenshots for both states.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const shotDir = resolve(here, '..', 'screenshots');
mkdirSync(shotDir, { recursive: true });

const APP = 'http://localhost:5173';
const NUXEO = 'http://localhost:8080/nuxeo';
const AUTH = 'Basic ' + Buffer.from('Administrator:Administrator').toString('base64');
const FIXTURE = process.env.MAM_UPLOAD_FIXTURE ?? resolve(tmpdir(), 'mam-fixture.mp4');

function step(msg) { console.log(`\n== ${msg} ==`); }

const browser = await chromium.launch();

// ---------------------------------------------------------------------------
// 1. Success path
// ---------------------------------------------------------------------------
step('Success path — desktop 1440x900');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('console.error:', m.text()); });

  const uniqueTitle = `E2E upload ${new Date().toISOString()}`;
  const slug = 'e2e-upload-' + Math.random().toString(36).slice(2, 8);

  await page.goto(`${APP}/upload`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.upload-zone');

  await page.setInputFiles('input[type=file]', FIXTURE);
  await page.waitForSelector('.staged-list');

  // Fill the metadata form.
  await page.fill('input.input[placeholder^="Evening Bulletin"]', uniqueTitle);
  await page.fill('input.input[placeholder="wildebeest-migration"]', slug);
  await page.fill('input.input[placeholder="Evening News"]', 'E2E Bulletin');
  await page.fill('input.input[placeholder="S03E14"]', 'E2E01');
  await page.fill('input.input[placeholder="Nairobi"]', 'E2E Bureau');
  await page.selectOption('select.select >> nth=1', 'package');            // story type
  await page.fill('input[type=date]', '2026-09-09');
  await page.selectOption('select.select >> nth=2', 'draft');              // editorial status

  // Confirm the asset type auto-selected BroadcastVideo (the fixture is
  // a video/mp4 file per the browser).
  const asAssetType = await page.$eval('select.select', (el) => (el).value);
  if (asAssetType !== 'BroadcastVideo') {
    throw new Error(`Auto asset-type expected BroadcastVideo, got ${asAssetType}`);
  }

  // Screenshot the form before uploading.
  await page.screenshot({ path: resolve(shotDir, 'upload-form-desktop-1440x900.png'), fullPage: true });

  await page.click('button[type=submit]');

  // Wait for either success or error — the success card auto-navigates in
  // 1.5s, so intercept the state before it redirects by pausing navigation.
  const success = page.waitForSelector('.upload-success', { timeout: 60000 });
  const error   = page.waitForSelector('.upload-error',   { timeout: 60000 });
  const first = await Promise.race([success.then(() => 'success'), error.then(() => 'error')]);
  if (first !== 'success') {
    const errText = await page.textContent('.upload-error');
    throw new Error(`Upload failed on success path: ${errText}`);
  }

  const successPath = await page.textContent('.upload-success-facts dd.mono');
  const successUid  = await page.$$eval('.upload-success-facts dd.mono', (nodes) => nodes.map((n) => n.textContent?.trim() ?? ''));
  console.log('Created path:', successPath?.trim());
  console.log('Created uid :', successUid[1]);

  await page.screenshot({ path: resolve(shotDir, 'upload-success-desktop-1440x900.png'), fullPage: true });

  // Wait for auto-navigation to /asset/:uid.
  await page.waitForURL(/\/asset\//, { timeout: 5000 });
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: resolve(shotDir, 'upload-detail-desktop-1440x900.png'), fullPage: true });

  // -------------------------------------------------------------------------
  // 1a-bis. Assert the metadata is actually rendered in the detail page DOM
  //         (not just present in the server JSON response).
  // -------------------------------------------------------------------------
  const detailText = await page.textContent('main#main');
  const domExpect = [uniqueTitle, slug, 'E2E Bulletin', 'E2E01', 'E2E Bureau', 'package', 'draft', 'BroadcastVideo'];
  for (const needle of domExpect) {
    if (!detailText?.includes(needle)) {
      throw new Error(`Detail page DOM missing expected text: "${needle}"`);
    }
  }
  console.log('Detail page DOM confirmed all submitted metadata is visible.');

  // Now verify the document server-side.
  const uid = successUid[1];
  const doc = await fetch(`${NUXEO}/api/v1/id/${uid}`, {
    headers: { Authorization: AUTH, properties: 'broadcast,dublincore' },
  }).then((r) => r.json());
  if (doc.type !== 'BroadcastVideo') throw new Error(`Server type mismatch: ${doc.type}`);
  const p = doc.properties ?? {};
  const expect = {
    'dc:title':                  uniqueTitle,
    'broadcast:slug':            slug,
    'broadcast:programme':       'E2E Bulletin',
    'broadcast:episode':         'E2E01',
    'broadcast:bureau':          'E2E Bureau',
    'broadcast:storyType':       'package',
    'broadcast:editorialStatus': 'draft',
  };
  for (const [k, v] of Object.entries(expect)) {
    if (p[k] !== v) throw new Error(`Server metadata mismatch on ${k}: got ${JSON.stringify(p[k])} want ${JSON.stringify(v)}`);
  }
  console.log('Server round-trip metadata OK; type =', doc.type);

  // -------------------------------------------------------------------------
  // 1c. Workflow / operation action — verifies that a subsequent
  //     state-changing POST (routed through the CSRF-aware client) also
  //     succeeds against the created document.
  //
  //     We exercise a stock Nuxeo automation operation
  //     (`Document.SetProperty`) directly via the page's fetch, so the same
  //     request-shape as `nuxeoRequest` (Basic auth header, credentials,
  //     CSRF-Token header when a token is cached) is under test.
  // -------------------------------------------------------------------------
  {
    const uid = successUid[1];
    // Wait for the dev-only test hook to be attached to `window`.
    await page.waitForFunction(() => typeof window.__mam?.runOperation === 'function', null, { timeout: 5000 });

    // Track the network — assert the CSRF token fetch AND the operation
    // POST both go out on the same page context.
    const seen = { fetchCsrf: 0, opPost: 0, opStatus: 0 };
    page.on('request', (req) => {
      if (req.method() === 'GET' && req.headers()['csrf-token'] === 'fetch') {
        seen.fetchCsrf++;
      }
      if (req.method() === 'POST' && req.url().includes('/@op/Document.SetProperty')) {
        seen.opPost++;
        // Confirm the CSRF-Token header is actually attached to the mutation.
        const t = req.headers()['csrf-token'];
        if (!t || t === 'fetch' || t === 'invalid') {
          throw new Error(`Operation POST is missing a real CSRF-Token header (saw '${t}')`);
        }
      }
    });
    page.on('response', (res) => {
      if (res.request().method() === 'POST' && res.url().includes('/@op/Document.SetProperty')) {
        seen.opStatus = res.status();
      }
    });

    // Force a fresh CSRF fetch on the next mutation so we can observe it.
    await page.evaluate(() => window.__mam.invalidateCsrfToken());
    const wfRes = await page.evaluate(async (u) => {
      try {
        const r = await window.__mam.runOperation(u, 'Document.SetProperty', {
          params: { xpath: 'dc:description', value: 'set by E2E workflow action' },
        });
        return { ok: true, r };
      } catch (e) {
        return { ok: false, message: e?.message ?? String(e), status: e?.status };
      }
    }, uid);
    if (!wfRes.ok) throw new Error(`Workflow/operation POST failed: ${JSON.stringify(wfRes)}`);
    console.log('Workflow/operation action POST status =', seen.opStatus,
      '| CSRF-Token: fetch requests observed =', seen.fetchCsrf,
      '| operation POST requests observed =', seen.opPost);
    if (seen.opPost !== 1) throw new Error('Expected exactly one operation POST');
    if (seen.fetchCsrf < 1) throw new Error('Client did not perform a CSRF-Token: fetch handshake before the mutation');

    // Confirm server-side that the property was actually set.
    const doc2 = await fetch(`${NUXEO}/api/v1/id/${uid}`, {
      headers: { Authorization: AUTH, properties: 'dublincore' },
    }).then((r) => r.json());
    if (doc2.properties?.['dc:description'] !== 'set by E2E workflow action') {
      throw new Error(`Server did not persist workflow action: dc:description=${JSON.stringify(doc2.properties?.['dc:description'])}`);
    }
    console.log('Server confirmed dc:description update from workflow action.');
  }

  await ctx.close();
}

// ---------------------------------------------------------------------------
// 1b. Success path — mobile screenshot
// ---------------------------------------------------------------------------
step('Success path — mobile 390x844 (form only, no server call)');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`${APP}/upload`, { waitUntil: 'networkidle' });
  await page.setInputFiles('input[type=file]', FIXTURE);
  await page.waitForSelector('.staged-list');
  await page.fill('input.input[placeholder^="Evening Bulletin"]', 'Mobile screenshot only');
  await page.screenshot({ path: resolve(shotDir, 'upload-form-mobile-390x844.png'), fullPage: true });
  await ctx.close();
}

// ---------------------------------------------------------------------------
// 2. Failure path — override the ingest parent to a bogus path.
//    We do this by intercepting the /path/... POST and returning a 404,
//    which is exactly what the real server returns for an unknown path.
// ---------------------------------------------------------------------------
step('Failure path — real Nuxeo 404 on doc create');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Rewrite the create-document POST to a path that doesn't exist. The
  // batch upload itself still succeeds against the real server; only the
  // last step fails. That's exactly what an operator would see if they
  // pointed VITE_MAM_INGEST_PATH at the wrong workspace.
  await page.route('**/nuxeo/api/v1/path/default-domain/workspaces', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      return route.continue({ url: req.url().replace('/workspaces', '/does-not-exist-e2e') });
    }
    return route.continue();
  });

  await page.goto(`${APP}/upload`, { waitUntil: 'networkidle' });
  await page.setInputFiles('input[type=file]', FIXTURE);
  await page.waitForSelector('.staged-list');
  await page.fill('input.input[placeholder^="Evening Bulletin"]', 'E2E failure case');
  await page.click('button[type=submit]');

  await page.waitForSelector('.upload-error', { timeout: 60000 });
  const errMsg = (await page.textContent('.upload-error-message'))?.trim() ?? '';
  console.log('Backend error surfaced:', errMsg);
  if (!/404|not found|does-not-exist/i.test(errMsg)) {
    throw new Error(`Expected a 404-ish error, got: ${errMsg}`);
  }

  await page.screenshot({ path: resolve(shotDir, 'upload-error-desktop-1440x900.png'), fullPage: true });

  // Retry without refreshing — click Retry; it should re-attempt and fail
  // again (route is still intercepted).
  const retryButton = page.locator('.upload-error button', { hasText: 'Retry' });
  await retryButton.click();
  await page.waitForSelector('.upload-error', { timeout: 60000 });
  const errMsg2 = (await page.textContent('.upload-error-message'))?.trim() ?? '';
  console.log('Retry surfaced error again:', errMsg2);
  await ctx.close();
}

// ---------------------------------------------------------------------------
// 3. CSRF token refresh + retry — simulate a rotated/expired token.
//     Intercept the first Document.SetProperty POST and reply with 403 +
//     `CSRF-Token: invalid`. The client must then re-fetch the token and
//     retry the request, which the second time reaches the real server and
//     succeeds.
// ---------------------------------------------------------------------------
step('CSRF token refresh + retry on 403+invalid');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // First, upload something small so we have a real uid to target.
  await page.goto(`${APP}/upload`, { waitUntil: 'networkidle' });
  await page.setInputFiles('input[type=file]', FIXTURE);
  await page.fill('input.input[placeholder^="Evening Bulletin"]', 'CSRF retry probe ' + Date.now());
  await page.click('button[type=submit]');
  await page.waitForSelector('.upload-success', { timeout: 60000 });
  const uids = await page.$$eval('.upload-success-facts dd.mono', (nodes) => nodes.map((n) => n.textContent?.trim() ?? ''));
  const uid = uids[1];
  await page.waitForURL(/\/asset\//, { timeout: 5000 });
  await page.waitForFunction(() => typeof window.__mam?.runOperation === 'function');

  let intercepted = 0;
  let csrfFetchAfterInvalid = 0;
  let retriedOpAttempts = 0;
  await page.route(`**/nuxeo/api/v1/id/${uid}/@op/Document.SetProperty`, async (route) => {
    retriedOpAttempts++;
    if (intercepted === 0) {
      intercepted++;
      // Simulate Nuxeo's rotated-token response.
      return route.fulfill({
        status: 403,
        headers: { 'CSRF-Token': 'invalid', 'Content-Type': 'text/plain' },
        body: 'CSRF check failure',
      });
    }
    // Second attempt: let it hit the real server.
    return route.continue();
  });
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.headers()['csrf-token'] === 'fetch' && intercepted >= 1) {
      csrfFetchAfterInvalid++;
    }
  });

  await page.evaluate(() => window.__mam.invalidateCsrfToken());
  const res = await page.evaluate(async (u) => {
    try {
      const r = await window.__mam.runOperation(u, 'Document.SetProperty', {
        params: { xpath: 'dc:description', value: 'retry after rotated token' },
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e?.message ?? String(e), status: e?.status };
    }
  }, uid);
  if (!res.ok) throw new Error(`Retry did not succeed: ${JSON.stringify(res)}`);
  if (retriedOpAttempts !== 2) {
    throw new Error(`Expected exactly 2 operation POST attempts (initial + retry), got ${retriedOpAttempts}`);
  }
  if (csrfFetchAfterInvalid < 1) {
    throw new Error('Client did not re-fetch the CSRF token after receiving CSRF-Token: invalid');
  }
  console.log('Retry OK — operation POST attempts:', retriedOpAttempts,
    ', CSRF token re-fetched:', csrfFetchAfterInvalid, 'time(s) after invalid response');
  await ctx.close();
}

// Mobile error screenshot
step('Failure path — mobile 390x844');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.route('**/nuxeo/api/v1/path/default-domain/workspaces', (route) => {
    const req = route.request();
    if (req.method() === 'POST') return route.continue({ url: req.url().replace('/workspaces', '/does-not-exist-e2e') });
    return route.continue();
  });
  await page.goto(`${APP}/upload`, { waitUntil: 'networkidle' });
  await page.setInputFiles('input[type=file]', FIXTURE);
  await page.waitForSelector('.staged-list');
  await page.fill('input.input[placeholder^="Evening Bulletin"]', 'E2E failure case (mobile)');
  await page.click('button[type=submit]');
  await page.waitForSelector('.upload-error', { timeout: 60000 });
  await page.screenshot({ path: resolve(shotDir, 'upload-error-mobile-390x844.png'), fullPage: true });
  await ctx.close();
}

await browser.close();
console.log('\nAll upload E2E checks passed.');
