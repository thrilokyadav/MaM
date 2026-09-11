/**
 * Blob download helper for the Asset Detail page.
 *
 * Nuxeo blob properties (see `NuxeoBlob` in `types/mam.ts`) already carry
 * a ready-to-use absolute download URL in their `data` field — produced by
 * `DownloadService#getFullDownloadUrl` (see
 * `DocumentPropertyJsonWriter#getBlobUrl`, nuxeo-core-io) — there is no
 * separate "resolve the blob URL" call needed; `GET /api/v1/id/{uid}` with
 * `properties: file` (or `video`) already returns it.
 *
 * A bare `<a href={url}>` can't carry this app's `Authorization: Bearer`
 * header, so the browser would get a 401 on direct navigation (this app
 * never relies on a Nuxeo session cookie — see `nuxeoClient.ts`). Instead,
 * fetch the bytes with the header attached, then trigger a save-as via a
 * synthetic anchor click on a local `blob:` object URL — the standard
 * workaround for authenticated file downloads in a fetch-only client.
 */

import { authHeader } from './nuxeoClient';

export class DownloadError extends Error {}

/**
 * Fetches `url` with the current Bearer auth header and triggers a browser
 * "Save As" for the resulting bytes under `filename`.
 */
export async function downloadBlobUrl(
  url: string,
  filename: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, { headers: { ...authHeader() }, signal });
  if (!res.ok) {
    throw new DownloadError(`Download failed: HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Give the browser a beat to pick up the object URL before revoking.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}
