/**
 * Nuxeo Batch Upload + document creation.
 *
 * Verified against nuxeo BatchUploadObject (see
 * modules/platform/rest-api/nuxeo-rest-api-server/.../BatchUploadObject.java)
 * and the local smoke-test script (mam-platform/scripts/smoke-test.ps1).
 *
 * Flow:
 *   1. POST /api/v1/upload/                       -> { batchId }
 *   2. POST /api/v1/upload/{batchId}/{fileIdx}    with the file bytes as
 *        the request body and X-File-Name / X-File-Type / X-Upload-Type
 *        request headers. Progress and cancel are exposed via XHR.
 *   3. POST /api/v1/path{parentPath}              JSON envelope referencing
 *        the batch via { "upload-batch": batchId, "upload-fileId": "0" }.
 *   4. DELETE /api/v1/upload/{batchId}            cancels a pending batch.
 *
 * Credentials are never embedded here. The Authorization: Bearer header
 * comes from nuxeoClient.authHeader(), sourced from the current OIDC
 * session (src/auth/tokenStore.ts). If no user is signed in, no
 * Authorization header is sent and Nuxeo responds 401.
 */

import {
  NUXEO_BASE_URL,
  NuxeoApiError,
  REST_ROOT,
  authHeader,
  nuxeoRequest,
} from './nuxeoClient';
import { fetchCsrfToken } from './csrf';
import type { NuxeoDocument } from '../types/nuxeo';
import type { BroadcastProperties, DublinCoreProperties } from './../types/mam';

/** Parent path new BroadcastAsset / BroadcastVideo documents are created under. */
export const INGEST_PARENT_PATH: string =
  (import.meta.env.VITE_MAM_INGEST_PATH as string | undefined) ??
  '/default-domain/workspaces';

export type BroadcastAssetType = 'BroadcastAsset' | 'BroadcastVideo';

export interface BatchInitResponse {
  batchId: string;
}

export interface UploadProgress {
  /** Bytes transferred so far. */
  loaded: number;
  /** Total bytes for the request (falls back to file.size). */
  total: number;
  /** 0..1 fraction, clamped. */
  fraction: number;
}

export interface UploadHandle {
  /** Resolves with the batchId once the byte transfer has completed. */
  done: Promise<string>;
  /** Abort the in-flight request. Rejects `done` with a NuxeoApiError(0). */
  cancel: () => void;
}

/** POST /api/v1/upload/ — create a new batch id. */
export async function initBatch(signal?: AbortSignal): Promise<string> {
  // Nuxeo's batch init endpoint requires a POST with no body. Passing an
  // empty JSON object is safe; the server ignores it.
  const res = await nuxeoRequest<BatchInitResponse>('/upload/', {
    method: 'POST',
    // Force JSON content-type off — spec allows empty body.
    body: undefined,
    signal,
  });
  if (!res?.batchId) {
    throw new NuxeoApiError('Batch init returned no batchId', 500, res as unknown as string);
  }
  return res.batchId;
}

/**
 * Upload a single file into an existing batch. Uses XMLHttpRequest so we
 * can surface upload-progress events and support cancellation — both of
 * which are awkward or unavailable with `fetch` in browsers today.
 */
export function uploadFileToBatch(
  batchId: string,
  fileIdx: number,
  file: File,
  onProgress?: (p: UploadProgress) => void,
): UploadHandle {
  const url = `${REST_ROOT}/upload/${encodeURIComponent(batchId)}/${fileIdx}`;
  const activeXhr: { current: XMLHttpRequest | null } = { current: null };
  let cancelled = false;

  const done = (async (): Promise<string> => {
    if (cancelled) {
      throw new NuxeoApiError('Upload cancelled', 0);
    }
    // This is a state-changing POST, so it needs the same CSRF token any
    // other write in this app attaches — see `csrf.ts`. XHR (not fetch) is
    // used below for upload-progress events, but the token still has to
    // be fetched with a plain `fetch` first.
    const csrf = await fetchCsrfToken();
    if (cancelled) {
      throw new NuxeoApiError('Upload cancelled', 0);
    }

    return new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeXhr.current = xhr;
      xhr.open('POST', url, true);
      xhr.withCredentials = true;

      for (const [k, v] of Object.entries(authHeader())) {
        xhr.setRequestHeader(k, v);
      }
      if (csrf) xhr.setRequestHeader('CSRF-Token', csrf);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('X-Upload-Type', 'normal');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.setRequestHeader('X-File-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader(
        'Content-Type',
        file.type || 'application/octet-stream',
      );

      xhr.upload.onprogress = (ev) => {
        if (!onProgress) return;
        const total = ev.lengthComputable ? ev.total : file.size;
        const loaded = ev.loaded;
        const fraction = total > 0 ? Math.min(1, loaded / total) : 0;
        onProgress({ loaded, total, fraction });
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (onProgress) onProgress({ loaded: file.size, total: file.size, fraction: 1 });
          resolve(batchId);
        } else {
          reject(parseXhrError(xhr));
        }
      };
      xhr.onerror = () => reject(new NuxeoApiError('Network error during upload', 0));
      xhr.onabort = () => reject(new NuxeoApiError('Upload cancelled', 0));

      xhr.send(file);
    });
  })();

  return {
    done,
    cancel: () => {
      cancelled = true;
      try { activeXhr.current?.abort(); } catch { /* no-op */ }
    },
  };
}

function parseXhrError(xhr: XMLHttpRequest): NuxeoApiError {
  const status = xhr.status || 0;
  const contentType = xhr.getResponseHeader('content-type') ?? '';
  const raw = xhr.responseText ?? '';
  if (contentType.includes('application/json') && raw) {
    try {
      const body = JSON.parse(raw);
      const message =
        (body && typeof body.message === 'string' && body.message) ||
        xhr.statusText ||
        `HTTP ${status}`;
      return new NuxeoApiError(message, status, body);
    } catch {
      /* fall through */
    }
  }
  return new NuxeoApiError(raw || xhr.statusText || `HTTP ${status}`, status, raw);
}

/** DELETE /api/v1/upload/{batchId} — best effort cleanup. Never throws. */
export async function cancelBatch(batchId: string): Promise<void> {
  try {
    await nuxeoRequest<void>(`/upload/${encodeURIComponent(batchId)}`, {
      method: 'DELETE',
    });
  } catch {
    /* Cleanup is best-effort. If the batch already timed out or the
       server is unreachable there is nothing sensible to do here. */
  }
}

export interface CreateAssetInput {
  parentPath?: string;
  /** Doc name (path segment). Auto-derived from title/slug if omitted. */
  name?: string;
  type: BroadcastAssetType;
  batchId: string;
  fileIdx?: number;
  dublinCore?: DublinCoreProperties;
  broadcast?: BroadcastProperties;
}

/**
 * POST /api/v1/path{parent} — create a BroadcastAsset / BroadcastVideo
 * document with the uploaded blob attached.
 */
export async function createAssetFromBatch(
  input: CreateAssetInput,
  signal?: AbortSignal,
): Promise<NuxeoDocument> {
  const parent = (input.parentPath ?? INGEST_PARENT_PATH).replace(/\/+$/, '');
  const properties: Record<string, unknown> = {
    ...(input.dublinCore ?? {}),
    ...(input.broadcast ?? {}),
    'file:content': {
      'upload-batch': input.batchId,
      'upload-fileId': String(input.fileIdx ?? 0),
    },
  };
  const body = {
    'entity-type': 'document',
    name: input.name ?? generateName(input),
    type: input.type,
    properties,
  };
  return nuxeoRequest<NuxeoDocument>(`/path${parent}`, {
    method: 'POST',
    body,
    headers: {
      properties: 'broadcast,dublincore',
    },
    signal,
  });
}

/**
 * Video mime detection. Uses the browser-supplied File.type first, then
 * falls back to a handful of common video extensions the browser might
 * refuse to type (e.g. .mxf, .mkv on some platforms).
 */
export function isProbablyVideo(file: File): boolean {
  if (file.type && file.type.startsWith('video/')) return true;
  const name = file.name.toLowerCase();
  return /\.(mp4|mov|m4v|mkv|webm|avi|mxf|mpg|mpeg|ts|m2ts)$/.test(name);
}

/** Slugify a title into a Nuxeo-safe doc name (path segment). */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function generateName(input: CreateAssetInput): string {
  const source =
    input.broadcast?.['broadcast:slug'] ||
    input.dublinCore?.['dc:title'] ||
    input.type;
  const base = slugify(String(source)) || 'asset';
  // Ensure uniqueness at the filesystem level without depending on server
  // deduplication rules.
  const stamp = Date.now().toString(36);
  return `${base}-${stamp}`;
}

/** Build the browser link to Nuxeo's own doc UI for debugging. */
export function nuxeoAdminUrl(uid: string): string {
  return `${NUXEO_BASE_URL}/ui/#!/browse/id/${encodeURIComponent(uid)}`;
}
