/**
 * Archive / restore actions for approved MAM assets.
 *
 * There is no dedicated backend operation or workflow for this today.
 * `MAM_Archive` is documented (mam-security-contrib.xml, README "What
 * still requires identity-provider integration") as a contract-only
 * permission — no archive pipeline exists yet to enforce it explicitly.
 * In practice, writing `broadcast:archiveState` is gated by Nuxeo's stock
 * `Write`/`WriteProperties` ACL check, which `MAM_ArchivistAccess` (the
 * `mam-archivists` group bundle) already grants alongside `MAM_Archive`.
 *
 * These are therefore thin wrappers over the existing generic
 * `updateAsset` PUT (already CSRF-aware via `nuxeoClient`). The server's
 * own 403 remains the real authority; any client-side permission check
 * (see `canArchive`/`canRestore` below) is a UX convenience only.
 */

import { updateAsset } from './actionsApi';
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

/** Move an asset to the `cold` archive tier. */
export async function archiveAsset(uid: string, signal?: AbortSignal): Promise<NuxeoDocument> {
  return updateAsset(uid, { 'broadcast:archiveState': 'cold' }, signal);
}

/** Restore an asset from `cold` back to the `hot` tier. */
export async function restoreAsset(uid: string, signal?: AbortSignal): Promise<NuxeoDocument> {
  return updateAsset(uid, { 'broadcast:archiveState': 'hot' }, signal);
}
