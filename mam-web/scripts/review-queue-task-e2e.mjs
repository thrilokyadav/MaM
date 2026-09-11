// End-to-end validation of the task-driven Review Queue against the local
// Nuxeo smoke stack.
//
// Validates:
//   1. Tasks assigned to `mam-editors` are visible to editor1 (a member)
//      and invisible to reporter1 (not a member) — server-enforced via
//      GET /api/v1/task?userId=<self>, where <self> comes only from
//      GET /api/v1/me (never a UI input).
//   2. Approve, through the real UI, driven as editor1.
//   3. Reject with a mandatory reason, through the real UI, driven as
//      editor1, with the reason persisted as a task comment.
//   4. An unauthorized user (reporter1) cannot complete a task reserved
//      for mam-editors — real 403 from the server, both via direct REST
//      and via the UI's own permission-denied banner.
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
const EDITOR_AUTH = 'Basic ' + Buffer.from('editor1:editor1Pass!').toString('base64');
const REPORTER_AUTH = 'Basic ' + Buffer.from('reporter1:reporter1Pass!').toString('base64');
const PARENT = '/default-domain/workspaces';

function step(msg) { console.log(`\n== ${msg} ==`); }

// Minimal per-principal cookie jar — Node's fetch doesn't persist cookies
// across calls, and Nuxeo's CSRF token is bound to the session cookie.
const jars = new Map();
function jarFor(auth) {
  if (!jars.has(auth)) jars.set(auth, { cookie: null });
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
    headers: { Authorization: auth, Accept: 'application/json', ...(jar.cookie ? { Cookie: jar.cookie } : {}), ...(opts.headers ?? {}) },
  });
  storeCookie(jar, res);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${opts.method ?? 'GET'} ${path} (as ${auth === ADMIN_AUTH ? 'admin' : auth === EDITOR_AUTH ? 'editor1' : 'reporter1'}) -> ${res.status}: ${text.slice(0, 300)}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('application/json') ? res.json() : res.text();
}
async function csrfToken(auth = ADMIN_AUTH) {
  const jar = jarFor(auth);
  const res = await fetch(`${NUXEO}`, { headers: { Authorization: auth, 'CSRF-Token': 'fetch', ...(jar.cookie ? { Cookie: jar.cookie } : {}) } });
  storeCookie(jar, res);
  return res.headers.get('CSRF-Token');
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
      'broadcast:programme': 'Task Queue E2E',
      'broadcast:bureau': 'London',
      'broadcast:storyType': 'vosot',
      'broadcast:editorialStatus': 'draft',
    },
  });
  return nxMutate(`/api/v1/path${PARENT}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
}
async function startWorkflow(uid) {
  const body = JSON.stringify({ 'entity-type': 'workflow', workflowModelName: 'MAM_EDITORIAL_APPROVAL', attachedDocumentIds: [uid] });
  return nxMutate('/api/v1/workflow', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
}
async function myTasks(auth) {
  const me = await nx('/api/v1/me', {}, auth);
  const result = await nx(`/api/v1/task?userId=${encodeURIComponent(me.id)}&pageSize=100`, {}, auth);
  return { me, tasks: result.entries ?? [] };
}
async function completeTaskAs(taskId, action, comment, auth) {
  const body = JSON.stringify({ 'entity-type': 'task', id: taskId, ...(comment ? { comment } : {}) });
  return nxMutate(`/api/v1/task/${taskId}/${action}`, { method: 'PUT', body, headers: { 'Content-Type': 'application/json' } }, auth);
}
async function getDoc(uid) {
  return nx(`/api/v1/id/${uid}`, { headers: { properties: 'broadcast,dublincore' } });
}
async function getTask(taskId) {
  return nx(`/api/v1/task/${taskId}`);
}
async function deleteDoc(uid) {
  try { await nxMutate(`/api/v1/id/${uid}`, { method: 'DELETE' }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// 1. Per-user task isolation (server-enforced).
// ---------------------------------------------------------------------------
step('Per-user task isolation — server-enforced via GET /task?userId=<self>');

const stamp = Date.now().toString(36);
const approveDoc = await createDraftAsset(`tq-approve-${stamp}`, `TQ Approve target ${stamp}`);
const rejectDoc = await createDraftAsset(`tq-reject-${stamp}`, `TQ Reject target ${stamp}`);
const unauthDoc = await createDraftAsset(`tq-unauth-${stamp}`, `TQ Unauthorized-probe target ${stamp}`);
console.log('  Created:', approveDoc.uid, rejectDoc.uid, unauthDoc.uid);

await startWorkflow(approveDoc.uid);
await startWorkflow(rejectDoc.uid);
await startWorkflow(unauthDoc.uid);

// Advance approve/reject targets to NodeEditorial (offers approve+reject);
// leave unauthDoc at NodeQC (offers reject) for the 403 probe.
{
  const { tasks } = await myTasks(ADMIN_AUTH);
  const approveTask = tasks.find((t) => t.targetDocumentIds?.[0]?.id === approveDoc.uid);
  const rejectTask = tasks.find((t) => t.targetDocumentIds?.[0]?.id === rejectDoc.uid);
  await completeTaskAs(approveTask.id, 'submit_to_editorial', 'advancing for E2E approve case', ADMIN_AUTH);
  await completeTaskAs(rejectTask.id, 'submit_to_editorial', 'advancing for E2E reject case', ADMIN_AUTH);
}

const editorView = await myTasks(EDITOR_AUTH);
const reporterView = await myTasks(REPORTER_AUTH);
console.log(`  editor1  (groups visible via /me) sees ${editorView.tasks.length} task(s)`);
console.log(`  reporter1 sees ${reporterView.tasks.length} task(s)`);
if (editorView.tasks.length < 3) throw new Error(`Expected editor1 to see at least 3 tasks, got ${editorView.tasks.length}`);
if (reporterView.tasks.length !== 0) throw new Error(`Expected reporter1 to see 0 tasks, got ${reporterView.tasks.length}`);
console.log('  Confirmed: editor1 (mam-editors member) sees the tasks; reporter1 (not a member) sees none.');

// ---------------------------------------------------------------------------
// 2. Drive the real UI as editor1 (route-level credential swap).
// ---------------------------------------------------------------------------
const browser = await chromium.launch();

async function asEditorContext() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/nuxeo/**', async (route, request) => {
    const headers = {};
    for (const [k, v] of Object.entries(request.headers())) {
      if (k.toLowerCase() !== 'authorization') headers[k] = v;
    }
    headers.authorization = EDITOR_AUTH;
    return route.continue({ headers });
  });
  return ctx;
}

step('Review queue as editor1 — desktop, before any action');
const editorCtx = await asEditorContext();
const page = await editorCtx.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`${APP}/review`, { waitUntil: 'load' });
await page.waitForSelector('.review-row', { timeout: 30000 });
const signedInAs = await page.textContent('.page-subtitle');
console.log('  Page subtitle reports:', signedInAs?.trim());
if (!signedInAs?.includes('editor1')) {
  throw new Error(`Expected the page to report "editor1" as the signed-in user, got: ${signedInAs}`);
}
const rowCount = await page.locator('.review-row').count();
console.log('  Rows visible to editor1:', rowCount);
if (rowCount < 3) throw new Error(`Expected at least 3 rows for editor1, saw ${rowCount}`);
await page.screenshot({ path: resolve(shotDir, 'review-queue-desktop-1440x900.png'), fullPage: true });

step('Approve one task via the real UI (as editor1)');
{
  const row = page.locator('.review-row', { hasText: `TQ Approve target ${stamp}` });
  await row.locator('button', { hasText: 'Approve' }).click();
  await row.locator('.review-result-success', { hasText: 'Approved.' }).waitFor({ timeout: 15000 });
  console.log('  UI reported success.');
}
{
  const doc = await getDoc(approveDoc.uid);
  if (doc.properties['broadcast:editorialStatus'] !== 'approved') {
    throw new Error(`Server state mismatch after approve: ${doc.properties['broadcast:editorialStatus']}`);
  }
  console.log('  Server confirms broadcast:editorialStatus = approved.');
}

step('Reject one task with a mandatory reason via the real UI (as editor1)');
let rejectTaskId;
{
  await page.waitForTimeout(300);
  const row = page.locator('.review-row', { hasText: `TQ Reject target ${stamp}` });
  await row.locator('button', { hasText: 'Reject' }).click();

  const dialog = page.locator('.modal-panel');
  await dialog.waitFor({ timeout: 5000 });
  const confirmBtn = dialog.locator('button', { hasText: 'Reject with reason' });
  if (!(await confirmBtn.isDisabled())) throw new Error('Reject dialog should disable submit when reason is empty');
  console.log('  Confirmed: reject is blocked without a reason.');

  const reasonText = 'Story lacks attribution for the archive footage; re-source and resubmit.';
  await dialog.locator('textarea').fill(reasonText);

  // Capture the task id being acted on before it disappears from the list.
  const { tasks } = await myTasks(EDITOR_AUTH);
  const t = tasks.find((tt) => tt.targetDocumentIds?.[0]?.id === rejectDoc.uid);
  rejectTaskId = t?.id;

  await confirmBtn.click();
  await row.locator('.review-result-success', { hasText: 'Rejected.' }).waitFor({ timeout: 15000 });
  console.log('  UI reported success.');
}
{
  const doc = await getDoc(rejectDoc.uid);
  if (doc.properties['broadcast:editorialStatus'] !== 'rejected') {
    throw new Error(`Server state mismatch after reject: ${doc.properties['broadcast:editorialStatus']}`);
  }
  console.log('  Server confirms broadcast:editorialStatus = rejected.');

  if (rejectTaskId) {
    const task = await getTask(rejectTaskId);
    const comments = task.comments ?? [];
    const found = comments.some((c) => c.text?.includes('lacks attribution'));
    if (!found) {
      throw new Error(`Rejection reason not found in task comments: ${JSON.stringify(comments)}`);
    }
    console.log('  Server confirms the rejection reason is persisted as a task comment:', comments.map((c) => c.text).join(' | '));
  }
}

await page.screenshot({ path: resolve(shotDir, 'review-queue-after-actions-desktop-1440x900.png'), fullPage: true });

// ---------------------------------------------------------------------------
// 3. Unauthorized action — reporter1 (not in mam-editors) cannot complete
//    a task reserved for that group.
// ---------------------------------------------------------------------------
step('Unauthorized action — reporter1 attempts to complete a task directly');
{
  const { tasks } = await myTasks(ADMIN_AUTH);
  const unauthTask = tasks.find((t) => t.targetDocumentIds?.[0]?.id === unauthDoc.uid);
  if (!unauthTask) throw new Error('Expected an open task for the unauthorized-probe target');

  const reporterToken = await csrfToken(REPORTER_AUTH);
  const reporterJar = jarFor(REPORTER_AUTH);
  const res = await fetch(`${NUXEO}/api/v1/task/${unauthTask.id}/reject`, {
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

  const doc = await getDoc(unauthDoc.uid);
  if (doc.properties['broadcast:editorialStatus'] !== 'qc') {
    throw new Error(`Unauthorized attempt should not have changed state, got ${doc.properties['broadcast:editorialStatus']}`);
  }
  console.log('  Confirmed: document state unchanged (still qc) after the rejected attempt.');
}

step('Unauthorized action — reporter1 sees no such task in their own queue UI');
{
  const reporterCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await reporterCtx.route('**/nuxeo/**', async (route, request) => {
    const headers = {};
    for (const [k, v] of Object.entries(request.headers())) {
      if (k.toLowerCase() !== 'authorization') headers[k] = v;
    }
    headers.authorization = REPORTER_AUTH;
    return route.continue({ headers });
  });
  const rpage = await reporterCtx.newPage();
  await rpage.goto(`${APP}/review`, { waitUntil: 'load' });
  await rpage.waitForSelector('text=Nothing to review', { timeout: 30000 }).catch(() => {});
  const emptyState = await rpage.locator('text=Nothing to review').count();
  console.log('  reporter1 review queue shows empty state:', emptyState > 0);
  if (emptyState === 0) throw new Error("Expected reporter1's queue to be empty (no visible tasks)");
  await rpage.screenshot({ path: resolve(shotDir, 'review-queue-reporter-empty-desktop-1440x900.png'), fullPage: true });
  await reporterCtx.close();
}

step('UI permission-denied banner — task PUT rerouted to reporter1 mid-session (editor1 can see the task, reporter1 cannot act on it)');
{
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

  await page.goto(`${APP}/review`, { waitUntil: 'load' });
  await page.waitForSelector('.review-row', { timeout: 30000 });
  const row = page.locator('.review-row', { hasText: `TQ Unauthorized-probe target ${stamp}` });
  await row.locator('button', { hasText: 'Reject' }).click();
  await page.locator('.modal-panel textarea').fill('Testing unauthorized reject through the UI.');
  await page.locator('.modal-panel button', { hasText: 'Reject with reason' }).click();

  await row.locator('.review-result-denied', { timeout: 15000 }).waitFor();
  const deniedText = (await row.locator('.review-result-denied').textContent())?.trim() ?? '';
  console.log('  UI permission-denied banner:', deniedText);
  if (/<html|<!doctype/i.test(deniedText)) throw new Error(`Denied banner leaked raw HTML: ${deniedText}`);
  if (!/forbidden|403/i.test(deniedText)) throw new Error(`Expected Forbidden/403 in denied banner, got: ${deniedText}`);

  await page.screenshot({ path: resolve(shotDir, 'review-queue-denied-desktop-1440x900.png'), fullPage: true });
  await page.unroute('**/nuxeo/api/v1/task/**');
}

// ---------------------------------------------------------------------------
// 4. Mobile screenshots.
// ---------------------------------------------------------------------------
step('Review queue — mobile 390x844 (as editor1)');
{
  const mctx = await asEditorContext();
  mctx._viewport = undefined;
  const mpage = await mctx.newPage();
  await mpage.setViewportSize({ width: 390, height: 844 });
  await mpage.goto(`${APP}/review`, { waitUntil: 'load' });
  await mpage.waitForSelector('.review-row', { timeout: 30000 });
  await mpage.screenshot({ path: resolve(shotDir, 'review-queue-mobile-390x844.png'), fullPage: true });

  const row = mpage.locator('.review-row').first();
  const rejectBtn = row.locator('button', { hasText: 'Reject' });
  if (await rejectBtn.count() > 0 && await rejectBtn.isEnabled()) {
    await rejectBtn.click();
    await mpage.waitForSelector('.modal-panel');
    await mpage.screenshot({ path: resolve(shotDir, 'review-queue-reject-dialog-mobile-390x844.png'), fullPage: true });
  }
  await mctx.close();
}

await editorCtx.close();
await browser.close();

// ---------------------------------------------------------------------------
// 5. Cleanup.
// ---------------------------------------------------------------------------
step('Cleanup');
await deleteDoc(approveDoc.uid);
await deleteDoc(rejectDoc.uid);
await deleteDoc(unauthDoc.uid);
console.log('  Removed the three test assets.');

console.log('\nAll task-driven review-queue E2E checks passed.');
