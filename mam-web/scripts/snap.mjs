// Screenshot harness. Runs against `npm run dev` at localhost:5173.
// Captures each key page at three viewports.
//
// Prerequisites (not committed to package.json — this is a dev tool):
//   npm i -D playwright
//   npx playwright install chromium
// Then start `npm run dev` and:
//   node scripts/snap.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'screenshots');
mkdirSync(outDir, { recursive: true });

const viewports = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'tablet-1024x768',  width: 1024, height: 768 },
  { name: 'mobile-390x844',   width: 390,  height: 844 },
];

const pages = [
  { name: 'dashboard',    path: '/' },
  { name: 'assets',       path: '/assets' },
  { name: 'assets-filter',path: '/assets?editorialStatus=qc' },
  { name: 'assets-empty', path: '/assets?editorialStatus=unlikely-value-does-not-exist' },
  { name: 'review',       path: '/review' },
  { name: 'archive',      path: '/archive' },
  { name: 'upload',       path: '/upload' },
  { name: 'settings',     path: '/settings' },
];

const browser = await chromium.launch();
for (const vp of viewports) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  for (const p of pages) {
    const page = await ctx.newPage();
    const url = `http://localhost:5173${p.path}`;
    console.log(`[${vp.name}] ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
    // Give lazy loading + skeleton fade a moment.
    await page.waitForTimeout(600);
    await page.screenshot({
      path: resolve(outDir, `${p.name}-${vp.name}.png`),
      fullPage: true,
    });
    await page.close();
  }

  // Also snap a detail page using the first asset uid.
  const listPage = await ctx.newPage();
  await listPage.goto('http://localhost:5173/assets', { waitUntil: 'networkidle' });
  const detailHref = await listPage.locator('a.asset-title').first().getAttribute('href');
  if (detailHref) {
    console.log(`[${vp.name}] http://localhost:5173${detailHref}`);
    await listPage.goto(`http://localhost:5173${detailHref}`, { waitUntil: 'networkidle' });
    await listPage.waitForTimeout(400);
    await listPage.screenshot({
      path: resolve(outDir, `asset-detail-${vp.name}.png`),
      fullPage: true,
    });
  }
  await listPage.close();

  await ctx.close();
}
await browser.close();
console.log(`Wrote screenshots to ${outDir}`);
