/**
 * Archive / restore actions for approved MAM assets.
 *
 * Both operations now call real Nuxeo Automation Operations that perform
 * actual blob movement between the hot and cold MinIO S3 buckets:
 *
 *   MAM.ArchiveAsset  -- CopyObject(hot->cold) + HeadObject verify + delete hot
 *   MAM.RestoreAsset  -- sets archiveState="restore-pending" immediately, then
 *                        schedules async MamRestoreWork (CopyObject cold->hot +
 *                        HeadObject verify + delete cold + stamp "hot")
 *
 * The server''s own 403 remains the real authority; the client-side
 * canArchive / canRestore checks (see below) are UX conveniences only.
 *
 * Polling: after calling restoreAsset() the caller receives a document with
 * archiveState="restore-pending". Use pollUntilRestored() to drive a progress
 * indicator while waiting for the async worker to finish.
 */

import { runOperation } from './actionsApi';
import { nuxeoRequest } from './nuxeoClient';
import type { MamDocument } from '../types/mam';
import type { NuxeoDocument } from '../types/nuxeo';

/** Reads the `permissions` document enricher populated by `searchAssets`/`fetchAsset`. */
export function docPermissions(doc: MamDocument): string[] {
  const raw = doc.contextParameters?.['permissions'];
  return Array.isArray(raw) ? (raw as string[]) : [];
}

function hasPermission(permissions: string[], name: string): boolean {
  return permissions.includes(name) || permissions.includes('Everything');
}

/** Whether the current principal appears entitled to archive this document. */
export function canArchive(doc: MamDocument): boolean {
  const permissions = docPermissions(doc);
  return hasPermission(permissions, 'MAM_Archive') || hasPermission(permissions, 'Write');
}

/** Whether the current principal appears entitled to restore this document. */
export function canRestore(doc: MamDocument): boolean {
  return canArchive(doc);
}

/**
 * Move an asset primary blob from the hot MinIO bucket to the cold MinIO
 * bucket. Calls the MAM.ArchiveAsset automation operation which:
 *   1. Reads the blob digest from file:content
 *   2. S3 CopyObject (hot -> cold)
 *   3. HeadObject verify on cold
 *   4. DeleteObject from hot
 *   5. Sets broadcast:archiveState = "cold", archiveDate, archivedBy
 *
 * This can take several seconds for large video files. The returned promise
 * resolves only once the server responds (blob has moved).
 */
export async function archiveAsset(uid: string, signal?: AbortSignal): Promise<NuxeoDocument> {
  return runOperation<NuxeoDocument>(uid, 'MAM.ArchiveAsset', {}, signal);
}

/**
 * Initiate an async restore of an asset primary blob from cold back to hot.
 * Calls the MAM.RestoreAsset automation operation which:
 *   1. Sets broadcast:archiveState = "restore-pending" (immediate)
 *   2. Schedules MamRestoreWork on the mam-restore work queue
 *
 * The returned document will have archiveState = "restore-pending".
 * Use pollUntilRestored() to track completion.
 */
export async function restoreAsset(uid: string, signal?: AbortSignal): Promise<NuxeoDocument> {
  return runOperation<NuxeoDocument>(uid, 'MAM.RestoreAsset', {}, signal);
}

/**
 * Polls broadcast:archiveState every intervalMs milliseconds until it
 * leaves "restore-pending" (resolves to "hot" on success, or "cold" on
 * failure/revert by MamRestoreWork).
 *
 * @param uid        Document UID to poll
 * @param onState    Called with the current state on every poll tick
 * @param intervalMs Poll interval in milliseconds (default 3000)
 * @param signal     AbortSignal to stop polling early
 * @returns          The final document once archiveState != "restore-pending"
 */
export async function pollUntilRestored(
  uid: string,
  onState?: (state: string | undefined) => void,
  intervalMs = 3000,
  signal?: AbortSignal,
): Promise<NuxeoDocument> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('Polling aborted', 'AbortError');

    await new Promise<void>((res) => {
      const t = setTimeout(res, intervalMs);
      signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
    });

    if (signal?.aborted) throw new DOMException('Polling aborted', 'AbortError');

    const doc = await nuxeoRequest<NuxeoDocument>(`/id/${encodeURIComponent(uid)}`, {
      method: 'GET',
      headers: { properties: 'broadcast' },
      signal,
    });

    const props = doc.properties as Record<string, unknown> | undefined;
    const state = props?.['broadcast:archiveState'] as string | undefined;

    onState?.(state);

    if (state !== 'restore-pending') return doc;
  }
}
