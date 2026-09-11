import type { NuxeoDocument } from './nuxeo';

/** Controlled string values used across the MAM broadcast schema. */
export type EditorialStatus = 'draft' | 'qc' | 'approved' | 'rejected';
export type ArchiveState = 'hot' | 'warm' | 'cold' | 'restore-pending';

/**
 * Broadcast metadata as declared in mam-core's `broadcast` schema.
 * All fields are optional at the document level; the UI must handle
 * missing values gracefully.
 */
export interface BroadcastProperties {
  'broadcast:slug'?: string;
  'broadcast:programme'?: string;
  'broadcast:episode'?: string;
  'broadcast:bureau'?: string;
  'broadcast:storyType'?: string;
  'broadcast:airDate'?: string;
  'broadcast:embargoUntil'?: string;
  'broadcast:rightsHolder'?: string;
  'broadcast:rightsTerritory'?: string;
  'broadcast:rightsStart'?: string;
  'broadcast:rightsEnd'?: string;
  'broadcast:editorialStatus'?: EditorialStatus | string;
  'broadcast:archiveState'?: ArchiveState | string;
}

export interface DublinCoreProperties {
  'dc:title'?: string;
  'dc:description'?: string;
  'dc:created'?: string;
  'dc:modified'?: string;
  'dc:creator'?: string;
}

/**
 * A Nuxeo blob property as serialized by `DocumentPropertyJsonWriter`
 * (nuxeo-core-io): every blob field (e.g. `file:content`, or the
 * `content` sub-field of a `video:transcodedVideos` list item) becomes
 * this shape. `data` is a ready-to-use, absolute download URL (built by
 * `DownloadService#getFullDownloadUrl`) — fetch it with the same
 * `Authorization: Bearer` header as any other API call (never as a bare
 * `<a href>`/`<video src>`, since the browser won't attach that header
 * on a plain navigation/element load). See `Thumbnail.tsx` for the
 * established blob-fetch-then-object-URL pattern this type supports.
 */
export interface NuxeoBlob {
  name?: string | null;
  'mime-type'?: string | null;
  encoding?: string | null;
  digestAlgorithm?: string | null;
  digest?: string | null;
  length?: string;
  /** Absolute, ready-to-fetch download URL. */
  data?: string;
  blobUrl?: string;
}

/** One entry of the `video` schema's `vid:transcodedVideos` list (nuxeo-platform-video). */
export interface TranscodedVideoItem {
  name?: string;
  content?: NuxeoBlob;
  info?: {
    duration?: number;
    width?: number;
    height?: number;
    format?: string;
    frameRate?: number;
  };
}

export interface VideoProperties {
  'file:content'?: NuxeoBlob;
  'vid:transcodedVideos'?: TranscodedVideoItem[];
  'vid:storyboard'?: Array<{ content?: NuxeoBlob; timecode?: number; comment?: string }>;
  'picture:views'?: unknown[];
}

export type MamDocument = NuxeoDocument & {
  properties?: DublinCoreProperties & BroadcastProperties & VideoProperties & Record<string, unknown>;
};

export interface AssetSearchParams {
  /** Free-text (mapped to `ecm:fulltext`). */
  q?: string;
  storyType?: string;
  editorialStatus?: EditorialStatus | string;
  archiveState?: ArchiveState | string;
  /** 0-based. */
  currentPageIndex?: number;
  pageSize?: number;
  /**
   * Programme / bureau / air-date range. There is no backend predicate for
   * these on `MAM_BROADCAST_ASSET_SEARCH` (see mam-core-contrib.xml) — the
   * server ignores unbound query params silently, so these are applied as
   * a client-side refinement over the fetched page, not a true server-side
   * filter. Callers that need this to be exact across all pages should
   * request a larger `pageSize`.
   */
  programme?: string;
  bureau?: string;
  /** Inclusive, compared against `broadcast:airDate` (ISO date/time string). */
  airDateFrom?: string;
  airDateTo?: string;
}
