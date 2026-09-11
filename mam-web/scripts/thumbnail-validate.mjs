// Validation-only script for the Thumbnail component against the live
// Nuxeo smoke stack. Does not modify any app source. Captures one desktop
// and one mobile screenshot and checks the four required cases:
//   1. BroadcastVideo with a generated thumbnail (finished transcoding)
//   2. Non-video BroadcastAsset with a real thumbnail
//   3. Asset with no blob -> fallback monogram
//   4. Forced rendition failure -> error/unavailable fallback
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const shotDir = resolve(here, '..', 'screenshots');
mkdirSync(shotDir, { recursive: true });

const APP = 'http://localhost:5173';

// Known uids set up for this validation pass.
const VIDEO_UID = '81f1838b-ddeb-4733-8b2f-39235c42e764'; // BroadcastVideo, transcoded, has thumbnail
const ASSET_UID = 'b012d755-711d-4619-8a38-54bcea84afd8'; // BroadcastAsset, real file, has thumbnail
const NOBLOB_UID = '2540f622-4666-4fbc-8273-316cd78c2f4e'; // BroadcastAsset, no blob -> fallback

function step(msg) { console.log(`\n== ${msg} ==`); }

const browser = await chromium.launch();

// ---------------------------------------------------------------------------
// 1 & 2 & 3. Dashboard / Assets search / Asset detail — real thumbnails and
//            fallback, on a real (unmodified) session.
// ---------------------------------------------------------------------------
/** True once the <img>'s decoded pixel data has non-zero dimensions (loaded blob: URL). */
async function isImageLoaded(locator) {
  const count = await locator.count();
  if (count === 0) return false;
  return locator.evaluate((img) => img instanceof HTMLImageElement && img.naturalWidth > 0);
}

step('Dashboard — recent assets thumbnails');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  await page.goto(`${APP}/`, { waitUntil: 'load' });
  await page.waitForSelector('.asset-card', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const thumbCount = await page.locator('.asset-card .thumb').count();
  const loadedImgs = await page.locator('.asset-card .thumb-img').evaluateAll(
    (imgs) => imgs.filter((img) => img.naturalWidth > 0).length,
  );
  console.log(`  .thumb containers: ${thumbCount}, loaded <img> (naturalWidth>0): ${loadedImgs}`);
  if (thumbCount === 0) throw new Error('No .thumb containers found on dashboard');
  if (loadedImgs === 0) throw new Error('No thumbnail images actually loaded on dashboard');
  await ctx.close();
}

step('Assets search results — thumbnails');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${APP}/assets`, { waitUntil: 'load' });
  await page.waitForSelector('.asset-card', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const thumbCount = await page.locator('.asset-card .thumb').count();
  const loadedImgs = await page.locator('.asset-card .thumb-img').evaluateAll(
    (imgs) => imgs.filter((img) => img.naturalWidth > 0).length,
  );
  console.log(`  .thumb containers on /assets: ${thumbCount}, loaded <img>: ${loadedImgs}`);
  if (thumbCount === 0) throw new Error('No .thumb containers found on /assets');
  if (loadedImgs === 0) throw new Error('No thumbnail images actually loaded on /assets');
  await ctx.close();
}

step('Asset detail header — video (transcoded) thumbnail');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${APP}/asset/${VIDEO_UID}`, { waitUntil: 'load' });
  await page.waitForSelector('.detail-media .thumb', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const loaded = await isImageLoaded(page.locator('.detail-media .thumb-img'));
  console.log(`  video detail thumb image loaded: ${loaded}`);
  if (!loaded) throw new Error('Expected a loaded thumbnail image on the video asset detail header');
  await ctx.close();
}

step('Asset detail header — non-video asset thumbnail');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${APP}/asset/${ASSET_UID}`, { waitUntil: 'load' });
  await page.waitForSelector('.detail-media .thumb', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const loaded = await isImageLoaded(page.locator('.detail-media .thumb-img'));
  console.log(`  non-video asset detail thumb image loaded: ${loaded}`);
  if (!loaded) throw new Error('Expected a loaded thumbnail image on the non-video asset detail header');
  await ctx.close();
}

step('Asset detail header — no-blob asset fallback');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${APP}/asset/${NOBLOB_UID}`, { waitUntil: 'load' });
  await page.waitForSelector('.detail-media .thumb', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const hasFallback = await page.locator('.detail-media .thumb-fallback-mono').count();
  const loaded = await isImageLoaded(page.locator('.detail-media .thumb-img'));
  console.log(`  no-blob fallback monogram present: ${hasFallback > 0}, image loaded: ${loaded}`);
  if (hasFallback === 0) throw new Error('Expected the fallback monogram for a document with no blob');
  if (loaded) throw new Error('No image should have loaded for a document with no blob');
  await ctx.close();
}

// ---------------------------------------------------------------------------
// 4. Forced rendition failure -> error/unavailable fallback. Route-level
//    interception only (network-layer), no source changes.
// ---------------------------------------------------------------------------
step('Forced rendition failure -> unavailable fallback');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await ctx.route('**/@rendition/thumbnail**', (route) => route.abort('failed'));
  await page.goto(`${APP}/asset/${ASSET_UID}`, { waitUntil: 'load' });
  await page.waitForSelector('.detail-media .thumb', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const hasFallback = await page.locator('.detail-media .thumb-fallback').count();
  const loaded = await isImageLoaded(page.locator('.detail-media .thumb-img'));
  console.log(`  after forced failure: fallback shown=${hasFallback > 0}, image loaded=${loaded}`);
  if (loaded) throw new Error('Image should not have loaded after a forced network failure');
  if (hasFallback === 0) throw new Error('Expected the error/unavailable fallback after a forced rendition failure');
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Review Queue — verify thumbnail on the open task's row.
// ---------------------------------------------------------------------------
step('Review Queue — thumbnail on task row');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${APP}/review`, { waitUntil: 'load' });
  await page.waitForSelector('.review-row', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const thumbCount = await page.locator('.review-row .thumb').count();
  const loaded = await isImageLoaded(page.locator('.review-row .thumb-img').first());
  console.log(`  .thumb containers: ${thumbCount}, first row image loaded: ${loaded}`);
  if (thumbCount === 0) throw new Error('No .thumb containers found in the review queue');
  if (!loaded) throw new Error('Expected the review queue row thumbnail to load');
  await page.screenshot({ path: resolve(shotDir, 'thumbnail-validate-desktop-1440x900.png'), fullPage: true });
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Mobile screenshot — Assets search results (thumbnails visible + responsive).
// ---------------------------------------------------------------------------
step('Mobile screenshot — Assets search results');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`${APP}/assets`, { waitUntil: 'load' });
  await page.waitForSelector('.asset-card', { timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: resolve(shotDir, 'thumbnail-validate-mobile-390x844.png'), fullPage: true });
  await ctx.close();
}

await browser.close();
console.log('\nAll thumbnail validation checks passed.');
