// Browser-network-panel verification of the CSRF flow.
//
// Drives the app in a real Chromium instance and captures every HTTP
// request/response the browser makes to /nuxeo, mirroring what a
// developer would see in DevTools → Network. Emits a table of the
// relevant requests with method, URL, status, request `Cookie`/`CSRF-Token`
// headers, and response `Set-Cookie`/`CSRF-Token` headers. Also performs
// the two negative probes: mutation with the CSRF header stripped, and
// mutation with the session cookie stripped.
//
// The CSRF flow is baked into the client (nuxeoClient.ts + uploadApi.ts).
// Requires: dev server on http://localhost:5173 and Nuxeo smoke stack on
// http://localhost:8080 with `nuxeo.csrf.token.enabled=true`.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const APP = 'http://localhost:5173';
const NUXEO = 'http://localhost:8080/nuxeo';
const AUTH = 'Basic ' + Buffer.from('Administrator:Administrator').toString('base64');
const FIXTURE = process.env.MAM_UPLOAD_FIXTURE ?? resolve(tmpdir(), 'mam-fixture.mp4');

function fmt(v, n) {
  if (v == null) return '';
  const s = String(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function shortToken(h) {
  const t = h?.['csrf-token'];
  if (!t) return '';
  return t === 'fetch' || t === 'invalid' ? t : `${t.slice(0, 8)}… (${t.length}ch)`;
}

function shortCookie(h) {
  const c = h?.['cookie'];
  if (!c) return '';
  const jsess = /JSESSIONID=([A-Z0-9.]+)/i.exec(c);
  return jsess ? `JSESSIONID=${jsess[1].slice(0, 10)}…` : c.slice(0, 30) + '…';
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e.message));

// Capture every /nuxeo/* HTTP exchange for the report.
const capture = [];
page.on('response', async (res) => {
  const req = res.request();
  const url = req.url();
  if (!url.includes('/nuxeo')) return;
  // `allHeaders()` includes browser-managed headers (Cookie, Origin, …)
  // that `headers()` filters out, so we can inspect the exact bytes on
  // the wire — the same view the DevTools Network panel shows.
  const reqH = await req.allHeaders();
  capture.push({
    method: req.method(),
    url: url.replace(APP, ''),
    status: res.status(),
    reqCsrf: reqH['csrf-token'] ?? '',
    reqCookie: reqH['cookie'] ?? '',
    reqOrigin: reqH['origin'] ?? '',
    resCsrf: (await res.headerValue('CSRF-Token')) ?? '',
    resSetCookie: (await res.headerValue('Set-Cookie')) ?? '',
  });
});

// -----------------------------------------------------------------------
// 1. Drive a real upload through the UI: batch init + binary upload + doc
//    create, all through nuxeoRequest / uploadApi (which fetch and attach
//    the CSRF token, and reuse the session cookie set by GET /nuxeo).
// -----------------------------------------------------------------------
console.log('== 1. Drive upload flow through the browser ==');
await page.goto(`${APP}/upload`, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type=file]', FIXTURE);
await page.fill('input.input[placeholder^="Evening Bulletin"]', `csrf-verify ${new Date().toISOString()}`);
await page.fill('input.input[placeholder="wildebeest-migration"]', 'csrf-verify-' + Math.random().toString(36).slice(2, 8));
await page.click('button[type=submit]');
await page.waitForSelector('.upload-success', { timeout: 60000 });
const uids = await page.$$eval('.upload-success-facts dd.mono', (nodes) => nodes.map((n) => n.textContent?.trim() ?? ''));
const uid = uids[1];
console.log('  Created BroadcastVideo uid:', uid);
await page.waitForURL(/\/asset\//, { timeout: 5000 });
await page.waitForFunction(() => typeof window.__mam?.runOperation === 'function');

// -----------------------------------------------------------------------
// 2. Workflow action through the CSRF-aware client.
// -----------------------------------------------------------------------
console.log('\n== 2. Workflow action (Document.SetProperty) ==');
const opRes = await page.evaluate(async (u) => {
  try { await window.__mam.runOperation(u, 'Document.SetProperty', { params: { xpath: 'dc:description', value: 'csrf-verify workflow' } }); return { ok: true }; }
  catch (e) { return { ok: false, message: e?.message, status: e?.status }; }
}, uid);
if (!opRes.ok) throw new Error(`Workflow action failed: ${JSON.stringify(opRes)}`);
console.log('  Workflow action succeeded');

// -----------------------------------------------------------------------
// 3. Print the browser-network-panel table for the flow so far.
// -----------------------------------------------------------------------
console.log('\n== 3. Browser network panel (captured requests) ==');
const relevant = capture.filter((c) => c.method !== 'GET' || c.url.endsWith('/nuxeo') || c.url.includes('/upload/') || c.url.includes('/@op'));
const hdr = ['METHOD', 'URL', 'STATUS', 'REQ CSRF-Token', 'REQ Cookie', 'RES CSRF-Token', 'RES Set-Cookie'];
const rows = relevant.map((c) => [c.method, c.url, String(c.status), shortToken({ 'csrf-token': c.reqCsrf }), shortCookie({ cookie: c.reqCookie }), c.resCsrf, fmt(c.resSetCookie, 60)]);
const widths = hdr.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r) => r.map((cell, i) => cell.padEnd(widths[i])).join('  ');
console.log(line(hdr));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const r of rows) console.log(line(r));

// -----------------------------------------------------------------------
// 4. Assertions on the captured traffic.
// -----------------------------------------------------------------------
const bootstrap = capture.find((c) => c.method === 'GET' && c.url.endsWith('/nuxeo') && c.reqCsrf === 'fetch');
if (!bootstrap) throw new Error('No GET /nuxeo with CSRF-Token: fetch observed');
if (bootstrap.status !== 200) throw new Error(`Bootstrap status ${bootstrap.status}, expected 200`);
if (!/^[A-Za-z0-9]{40}$/.test(bootstrap.resCsrf)) throw new Error(`Bootstrap did not return a 40-char CSRF token, got '${bootstrap.resCsrf}'`);
if (!/JSESSIONID=[A-Z0-9.]+/i.test(bootstrap.resSetCookie)) throw new Error(`Bootstrap did not Set-Cookie JSESSIONID, got '${bootstrap.resSetCookie}'`);
console.log('\n  ✔ GET /nuxeo returned 200 with a 40-char CSRF-Token and Set-Cookie: JSESSIONID');

const mutations = capture.filter((c) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.method) && (c.url.includes('/api/v1/') || c.url.startsWith('/nuxeo/api/v1/')));
if (mutations.length < 3) throw new Error(`Expected at least 3 mutating requests (batch init, upload, doc create), got ${mutations.length}`);
for (const m of mutations) {
  if (!m.reqCsrf || m.reqCsrf === 'fetch' || m.reqCsrf === 'invalid')
    throw new Error(`${m.method} ${m.url} missing real CSRF-Token header (saw '${m.reqCsrf}')`);
  if (!/JSESSIONID/i.test(m.reqCookie))
    throw new Error(`${m.method} ${m.url} missing JSESSIONID cookie (saw '${m.reqCookie}')`);
  if (m.status >= 400)
    throw new Error(`${m.method} ${m.url} unexpectedly failed with ${m.status}`);
}
console.log('  ✔ Every mutating request carried the CSRF-Token header and JSESSIONID cookie');
console.log('  ✔ Observed mutations:', mutations.map((m) => `${m.method} ${m.url.split('?')[0]} → ${m.status}`).join(' | '));

// -----------------------------------------------------------------------
// 5. Negative probes — issued through the browser's real cookie jar so the
//    session cookie is present unless we explicitly strip it.
// -----------------------------------------------------------------------
console.log('\n== 5. Negative probes (should each 403) ==');

const neg1 = await page.evaluate(async () => {
  // Same session cookie, but no CSRF-Token header at all.
  const r = await fetch('/nuxeo/api/v1/upload/', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Authorization: 'Basic ' + btoa('Administrator:Administrator'),
      Accept: 'application/json',
    },
  });
  return { status: r.status, csrf: r.headers.get('CSRF-Token') };
});
console.log('  No CSRF header:', neg1);
if (neg1.status !== 403 || neg1.csrf !== 'invalid') {
  throw new Error(`Expected 403 CSRF-Token: invalid when header is stripped, got ${JSON.stringify(neg1)}`);
}

const neg2 = await page.evaluate(async (t) => {
  // No session cookie: `credentials: 'omit'`. Real CSRF-Token header but no
  // JSESSIONID in the request. The server has no session-bound token so it
  // must reject.
  const r = await fetch('/nuxeo/api/v1/upload/', {
    method: 'POST',
    credentials: 'omit',
    headers: {
      Authorization: 'Basic ' + btoa('Administrator:Administrator'),
      Accept: 'application/json',
      'CSRF-Token': t,
    },
  });
  return { status: r.status, csrf: r.headers.get('CSRF-Token') };
}, bootstrap.resCsrf);
console.log('  No cookie:', neg2);
if (neg2.status !== 403 || neg2.csrf !== 'invalid') {
  throw new Error(`Expected 403 CSRF-Token: invalid when cookie is stripped, got ${JSON.stringify(neg2)}`);
}
console.log('  ✔ Stripping either the header or the cookie yields 403 CSRF-Token: invalid');

// -----------------------------------------------------------------------
// 6. Server-side verification of the uploaded document.
// -----------------------------------------------------------------------
const doc = await fetch(`${NUXEO}/api/v1/id/${uid}`, {
  headers: { Authorization: AUTH, properties: 'broadcast,dublincore' },
}).then((r) => r.json());
if (doc.type !== 'BroadcastVideo') throw new Error(`Server type mismatch: ${doc.type}`);
if (doc.properties?.['dc:description'] !== 'csrf-verify workflow')
  throw new Error(`Server did not persist workflow update: ${JSON.stringify(doc.properties?.['dc:description'])}`);
console.log('\n  ✔ Server confirms uploaded doc:');
console.log('    path=', doc.path);
console.log('    type=', doc.type);
console.log('    dc:description=', doc.properties['dc:description']);

await ctx.close();
await browser.close();
console.log('\nAll CSRF network-panel checks passed.');
