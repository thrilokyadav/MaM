// End-to-end validation of the Review Queue against the local Nuxeo smoke
// stack. Creates real test assets, drives them through the real
// MAM_EDITORIAL_APPROVAL workflow, and exercises the Review Queue UI for:
//   1. Approve
//   2. Reject with a required reason
//   3. An unauthorized action (a non-editor principal attempting to
//      complete a task reserved for the `mam-editors` group)
// Also captures desktop + mobile screenshots.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const shotDir = resolve(here, '..', 'screenshots');
mkdirSync(shotDir, { recursive: true });

const APP = 'http://localhost:5173';
const NUXEO = 'http://localhost:8080/nuxeo';
const ADMIN_AUTH = 'Basic ' + Buffer.from('Administrator:Administrator').toString('base64');
const REPORTER_AUTH = 'Basic ' + Buffer.from('reporter1:reporter1Pass!').toString('base64');
const PARENT = '/default-domain/workspaces';

function step(msg) { console.log(`\n== ${msg} ==`); }

// Node's fetch does not persist cookies across calls the way a browser
// does, and Nuxeo's CSRF token is bound to the session cookie. A minimal
// per-principal cookie jar keeps the admin helper calls working exactly
// like a real browser session would.
const jars = new Map();

function jarFor(auth) {
  if (!jars.has(auth)) jars.set(auth, { cookie: null, token: null });
  return jars.get(auth);
}

function storeCookie(jar, res) {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jar.cookie = setCookie.split(';')[0];
}

async function nx(path, opts = {}, auth = ADMIN_AUTH) {
  const jar = jarFor(auth);
  const res = await fetch(`${NUXEO}${path}`, {
    ...opts,
    headers: {
      Authorization: auth,
      Accept: 'application/json',
      ...(jar.cookie ? { Cookie: jar.cookie } : {}),
      ...(opts.headers ?? {}),
    },
  });
  storeCookie(jar, res);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${opts.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('application/json') ? res.json() : res.text();
}

async function csrfToken(auth = ADMIN_AUTH) {
  const jar = jarFor(auth);
  const res = await fetch(`${NUXEO}`, {
    headers: { Authorization: auth, 'CSRF-Token': 'fetch', ...(jar.cookie ? { Cookie: jar.cookie } : {}) },
  });
  storeCookie(jar, res);
  jar.token = res.headers.get('CSRF-Token');
  return jar.token;
}

async function nxMutate(path, opts = {}, auth = ADMIN_AUTH) {
  const token = await csrfToken(auth);
  return nx(path, { ...opts, headers: { ...(opts.headers ?? {}), ...(token ? { 'CSRF-Token': token } : {}) } }, auth);
}

async function createDraftAsset(name, title) {
  const body = JSON.stringify({
    'entity-type': 'document',
    name,
    type: 'BroadcastAsset',
    properties: {
      'dc:title': title,
      'broadcast:slug': name,
      'broadcast:programme': 'Review Queue E2E',
      'broadcast:bureau': 'Nairobi',
      'broadcast:storyType': 'package',
      'broadcast:editorialStatus': 'draft',
    },
  });
  return nxMutate(`/api/v1/path${PARENT}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
}

async function startWorkflow(uid) {
  const body = JSON.stringify({ 'entity-type': 'workflow', workflowModelName: 'MAM_EDITORIAL_APPROVAL', attachedDocumentIds: [uid] });
  return nxMutate('/api/v1/workflow', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
}

async function getOpenTasks() {
  const result = await nx('/api/v1/task?pageSize=100');
  return result.entries ?? [];
}

async function completeTaskAsAdmin(taskId, action, comment) {
  const body = JSON.stringify({ 'entity-type': 'task', id: taskId, ...(comment ? { comment } : {}) });
  return nxMutate(`/api/v1/task/${taskId}/${action}`, { method: 'PUT', body, headers: { 'Content-Type': 'application/json' } });
}

async function getDoc(uid) {
  return nx(`/api/v1/id/${uid}`, { headers: { properties: 'broadcast,dublincore' } });
}

async function deleteDoc(uid) {
  try { await nxMutate(`/api/v1/id/${uid}`, { method: 'DELETE' }); } catch { /* best effort cleanup */ }
}

// ---------------------------------------------------------------------------
// 1. Set up three test assets:
//    - approveTarget: draft -> submitted to QC (task open at NodeQC)
//    - rejectTarget:  draft -> submitted to QC -> advanced to NodeEditorial (task open there)
//    - unauthorizedTarget: draft -> submitted to QC (task open at NodeQC, for the 403 probe)
// ---------------------------------------------------------------------------
step('Creating test assets and starting the real MAM_EDITORIAL_APPROVAL workflow');

const stamp = Date.now().toString(36);
const approveDoc = await createDraftAsset(`rq-approve-${stamp}`, `RQ Approve target ${stamp}`);
const rejectDoc = await createDraftAsset(`rq-reject-${stamp}`, `RQ Reject target ${stamp}`);
const unauthDoc = await createDraftAsset(`rq-unauth-${stamp}`, `RQ Unauthorized-probe target ${stamp}`);
console.log('  Created:', approveDoc.uid, rejectDoc.uid, unauthDoc.uid);

await startWorkflow(approveDoc.uid);
await startWorkflow(rejectDoc.uid);
await startWorkflow(unauthDoc.uid);

// Advance approveTarget and rejectTarget to NodeEditorial, whose task
// offers both "approve" and "reject" buttons. unauthTarget is deliberately
// left at NodeQC to exercise its "reject" button for the 403 probe.
{
  const tasks = await getOpenTasks();
  const approveTask = tasks.find((t) => t.targetDocumentIds?.[0]?.id === approveDoc.uid);
  const rejectTask = tasks.find((t) => t.targetDocumentIds?.[0]?.id === rejectDoc.uid);
  if (!approveTask) throw new Error('Expected an open QC task for the approve target');
  if (!rejectTask) throw new Error('Expected an open QC task for the reject target');
  await completeTaskAsAdmin(approveTask.id, 'submit_to_editorial', 'moving to editorial for the E2E approve case');
  await completeTaskAsAdmin(rejectTask.id, 'submit_to_editorial', 'moving to editorial for the E2E reject case');
}

const tasksAfterSetup = await getOpenTasks();
console.log('  Open tasks after setup:', tasksAfterSetup.map((t) => `${t.nodeName}:${t.targetDocumentIds?.[0]?.id?.slice(0, 8)}`).join(', '));

// ---------------------------------------------------------------------------
// 2. Drive the real UI: open the review queue, approve one asset.
// ---------------------------------------------------------------------------
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e.message));

step('Review queue — desktop, before any action');
await page.goto(`${APP}/review`, { waitUntil: 'networkidle' });
await page.waitForSelector('.review-row');
const rowCountBefore = await page.locator('.review-row').count();
console.log('  Rows visible:', rowCountBefore);
if (rowCountBefore < 3) throw new Error(`Expected at least 3 review rows, saw ${rowCountBefore}`);
await page.screenshot({ path: resolve(shotDir, 'review-queue-desktop-1440x900.png'), fullPage: true });

step('Approve one asset via the real UI');
{
  const row = page.locator('.review-row', { hasText: `RQ Approve target ${stamp}` });
  await row.locator('button', { hasText: 'Approve' }).click();
  await row.locator('.review-result-success', { hasText: 'Approved.' }).waitFor({ timeout: 15000 });
  console.log('  UI reported success.');
}
// Server-side verification.
{
  const doc = await getDoc(approveDoc.uid);
  if (doc.properties['broadcast:editorialStatus'] !== 'approved') {
    throw new Error(`Server state mismatch after approve: ${doc.properties['broadcast:editorialStatus']}`);
  }
  console.log('  Server confirms broadcast:editorialStatus = approved.');
}

step('Reject one asset with a required reason via the real UI');
{
  // Refresh listing (approved asset should now have left the queue).
  await page.waitForTimeout(500);
  const row = page.locator('.review-row', { hasText: `RQ Reject target ${stamp}` });
  await row.locator('button', { hasText: 'Reject' }).click();

  // The dialog should be open; confirm the reject button is disabled with
  // no reason typed (required-reason enforcement).
  const dialog = page.locator('.modal-panel');
  await dialog.waitFor({ timeout: 5000 });
  const confirmBtn = dialog.locator('button', { hasText: 'Reject with reason' });
  const disabledEmpty = await confirmBtn.isDisabled();
  if (!disabledEmpty) throw new Error('Reject dialog should disable submit when reason is empty');
  console.log('  Confirmed: reject is blocked without a reason.');

  await dialog.locator('textarea').fill('Audio levels too low; re-mix and resubmit.');
  await confirmBtn.click();
  await row.locator('.review-result-success', { hasText: 'Rejected.' }).waitFor({ timeout: 15000 });
  console.log('  UI reported success.');
}
// Server-side verification: status + reason recorded as a task comment.
{
  const doc = await getDoc(rejectDoc.uid);
  if (doc.properties['broadcast:editorialStatus'] !== 'rejected') {
    throw new Error(`Server state mismatch after reject: ${doc.properties['broadcast:editorialStatus']}`);
  }
  console.log('  Server confirms broadcast:editorialStatus = rejected.');
}

await page.screenshot({ path: resolve(shotDir, 'review-queue-after-actions-desktop-1440x900.png'), fullPage: true });

// ---------------------------------------------------------------------------
// 3. Unauthorized action — `reporter1` (member of `members`, not
//    `mam-editors`) tries to complete the open QC task directly against
//    the real server. Must be a real 403, not a UI-only guess.
// ---------------------------------------------------------------------------
step('Unauthorized action — non-editor user attempts to complete a task');
{
  const tasks = await getOpenTasks();
  const unauthTask = tasks.find((t) => t.targetDocumentIds?.[0]?.id === unauthDoc.uid);
  if (!unauthTask) throw new Error('Expected an open QC task for the unauthorized-probe target');

  const reporterToken = await csrfToken(REPORTER_AUTH);
  const reporterJar = jarFor(REPORTER_AUTH);
  const res = await fetch(`${NUXEO}/api/v1/task/${unauthTask.id}/submit_to_editorial`, {
    method: 'PUT',
    headers: {
      Authorization: REPORTER_AUTH,
      'Content-Type': 'application/json',
      ...(reporterJar.cookie ? { Cookie: reporterJar.cookie } : {}),
      ...(reporterToken ? { 'CSRF-Token': reporterToken } : {}),
    },
    body: JSON.stringify({ 'entity-type': 'task', id: unauthTask.id, comment: 'reporter1 should not be able to do this' }),
  });
  console.log('  reporter1 PUT status:', res.status);
  if (res.status !== 403) {
    const text = await res.text();
    throw new Error(`Expected 403 for unauthorized task completion, got ${res.status}: ${text.slice(0, 300)}`);
  }
  console.log('  Confirmed: real 403 Forbidden from Nuxeo for the non-editor principal.');

  // Confirm the document was NOT changed by the failed attempt.
  const doc = await getDoc(unauthDoc.uid);
  if (doc.properties['broadcast:editorialStatus'] !== 'qc') {
    throw new Error(`Unauthorized attempt should not have changed state, got ${doc.properties['broadcast:editorialStatus']}`);
  }
  console.log('  Confirmed: document state unchanged (still qc) after the rejected attempt.');
}

// Also demonstrate the UI's own permission-denied surfacing by pointing a
// row's action at a task id that reporter1 cannot complete, through the
// app's own fetch (same-origin, using the app's Administrator dev-auth —
// so instead we directly assert the API layer's classification of 403s
// by calling the app's exposed test hook with a doctored auth header via
// route interception).
step('UI permission-denied state (403 surfaced through the CSRF-aware client)');
{
  // Nuxeo's Task documents carry an ACL that only grants read to their
  // assignees (plus admins/powerusers). A real reporter1 session
  // therefore sees zero open tasks in its own /api/v1/task listing — the
  // review queue correctly shows no actionable rows for them, which is
  // itself correct least-privilege behaviour, not a bug to work around.
  //
  // To exercise the *action* 403 through the UI (as opposed to the
  // already-covered "task invisible" case), keep the admin's view — which
  // does see the task — and reroute only the outgoing task-completion PUT
  // to carry reporter1's Basic auth and session cookie. Every other
  // request on the page (including the CSRF-Token fetch used to populate
  // the header) still runs as Administrator, so this isolates exactly one
  // thing: the server-side authorization check on the task PUT itself.
  const reporterToken = await csrfToken(REPORTER_AUTH);
  const reporterJar = jarFor(REPORTER_AUTH);

  await page.route('**/nuxeo/api/v1/task/**', async (route, request) => {
    if (request.method() !== 'PUT') return route.continue();
    const headers = {};
    for (const [k, v] of Object.entries(request.headers())) {
      if (!['authorization', 'cookie', 'csrf-token'].includes(k.toLowerCase())) headers[k] = v;
    }
    headers.authorization = REPORTER_AUTH;
    if (reporterJar.cookie) headers.cookie = reporterJar.cookie;
    if (reporterToken) headers['csrf-token'] = reporterToken;
    return route.continue({ headers });
  });
  page.on('response', (res) => {
    if (res.url().includes('/api/v1/task/') && res.request().method() === 'PUT') {
      console.log('  [debug] task PUT ->', res.status(), res.url());
    }
  });

  await page.goto(`${APP}/review`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.review-row');
  const row = page.locator('.review-row', { hasText: `RQ Unauthorized-probe target ${stamp}` });
  // The unauth target's task is at NodeQC, which offers "Reject" (not
  // "Approve"). reporter1 is not in the `mam-editors` group, so the real
  // server must reject the completion with 403.
  await row.locator('button', { hasText: 'Reject' }).click();
  await page.locator('.modal-panel textarea').fill('Testing unauthorized reject.');
  await page.locator('.modal-panel button', { hasText: 'Reject with reason' }).click();

  await row.locator('.review-result-denied', { timeout: 15000 }).waitFor();
  const deniedText = (await row.locator('.review-result-denied').textContent())?.trim() ?? '';
  console.log('  UI permission-denied banner:', deniedText);
  if (/<html|<!doctype/i.test(deniedText)) {
    throw new Error(`Permission-denied banner leaked raw HTML instead of a clean message: ${deniedText}`);
  }
  if (!/forbidden|403/i.test(deniedText)) {
    throw new Error(`Expected the permission-denied banner to mention Forbidden/403, got: ${deniedText}`);
  }

  await page.screenshot({ path: resolve(shotDir, 'review-queue-denied-desktop-1440x900.png'), fullPage: true });
  await page.unroute('**/nuxeo/api/v1/task/**');
}

// ---------------------------------------------------------------------------
// 4. Mobile screenshot.
// ---------------------------------------------------------------------------
step('Review queue — mobile 390x844');
{
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mpage = await mctx.newPage();
  await mpage.goto(`${APP}/review`, { waitUntil: 'networkidle' });
  await mpage.waitForSelector('.review-row');
  await mpage.screenshot({ path: resolve(shotDir, 'review-queue-mobile-390x844.png'), fullPage: true });

  // Also capture the reject dialog on mobile.
  const row = mpage.locator('.review-row').first();
  const rejectBtn = row.locator('button', { hasText: 'Reject' });
  if (await rejectBtn.count() > 0 && await rejectBtn.isEnabled()) {
    await rejectBtn.click();
    await mpage.waitForSelector('.modal-panel');
    await mpage.screenshot({ path: resolve(shotDir, 'review-queue-reject-dialog-mobile-390x844.png'), fullPage: true });
  }
  await mctx.close();
}

await ctx.close();
await browser.close();

// ---------------------------------------------------------------------------
// 5. Cleanup.
// ---------------------------------------------------------------------------
step('Cleanup');
await deleteDoc(approveDoc.uid);
await deleteDoc(rejectDoc.uid);
await deleteDoc(unauthDoc.uid);
console.log('  Removed the three test assets.');

console.log('\nAll review-queue E2E checks passed.');
