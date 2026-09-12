/**
 * Search API. Wraps the MAM_BROADCAST_ASSET_SEARCH named page provider
 * shipped by the `mam-core` addon.
 *
 * Backend endpoint (verified against nuxeo-search-rest-api tests):
 *   GET /api/v1/search/pp/MAM_BROADCAST_ASSET_SEARCH/execute
 *     ?q=&storyType=&editorialStatus=&archiveState=
 *     &currentPageIndex=&pageSize=
 *
 * Empty / undefined filters are dropped by the client so the backend's
 * predicates fall through cleanly.
 *
 * `q` is matched case-insensitively against `dc:title`, `broadcast:slug`,
 * `broadcast:programme`, and `broadcast:bureau` (OR'd together) by
 * mam-core's BroadcastAssetSearchPageProvider, not just the title.
 */

import { IS_MOCK_MODE, NuxeoApiError, nuxeoRequest } from './nuxeoClient';
import type { AssetSearchParams, MamDocument } from '../types/mam';
import type { NuxeoPageProviderResult } from '../types/nuxeo';

export const PROVIDER_NAME = 'MAM_BROADCAST_ASSET_SEARCH';
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Wraps a free-text query in SQL `LIKE` wildcards so it matches anywhere
 * within the searched columns (title, slug, programme, bureau), not just
 * an exact match. Escapes any `%`/`_` the user actually typed first so
 * they're treated as literal characters, not wildcards of their own —
 * otherwise a title containing a literal percent sign could silently
 * widen the match in surprising ways.
 */
function likeWildcard(q: string | undefined): string | undefined {
  if (!q) return undefined;
  const escaped = q.replace(/[%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/** Execute the MAM page provider. Returns the raw Nuxeo page envelope. */
export async function searchAssets(
  params: AssetSearchParams = {},
  signal?: AbortSignal,
): Promise<NuxeoPageProviderResult<MamDocument>> {
  if (IS_MOCK_MODE) return mockSearch(params);
  return nuxeoRequest<NuxeoPageProviderResult<MamDocument>>(
    `/search/pp/${PROVIDER_NAME}/execute`,
    {
      method: 'GET',
      query: {
        // The backend's `q` handling is a case-insensitive `LIKE` OR'd
        // across `dc:title`/`broadcast:slug`/`broadcast:programme`/
        // `broadcast:bureau` (see BroadcastAssetSearchPageProvider —
        // deliberately not `FULLTEXT`, which the local H2 test database
        // cannot run at all). Wrapping in wildcards here, not on the
        // server, keeps the server-side contract a plain LIKE and lets
        // any future caller of this named page provider decide its own
        // matching semantics.
        q: likeWildcard(params.q),
        storyType: params.storyType,
        editorialStatus: params.editorialStatus,
        archiveState: params.archiveState,
        currentPageIndex: params.currentPageIndex,
        pageSize: params.pageSize ?? DEFAULT_PAGE_SIZE,
      },
      headers: {
        properties: 'broadcast,dublincore,video',
        // Populate contextParameters.permissions too (not just thumbnail) so
        // list views (e.g. the Archive page) can gate row-level actions like
        // Archive/Restore per-document, the same way AssetDetailPage does —
        // without this, a list view has no way to know what the current
        // principal is entitled to do on each row.
        'enrichers-document': 'permissions,thumbnail',
      },
      signal,
    },
  );
}

/** Fetch a single MAM document by uid, with broadcast metadata materialized. */
export async function fetchAsset(
  uid: string,
  signal?: AbortSignal,
): Promise<MamDocument> {
  if (IS_MOCK_MODE) return mockFetch(uid);
  return nuxeoRequest<MamDocument>(`/id/${encodeURIComponent(uid)}`, {
    method: 'GET',
    headers: {
      // `file` is included so `file:content` (the original blob, used by
      // the Asset Detail page's "Download Original" button) is returned
      // alongside the metadata schemas.
      properties: 'broadcast,dublincore,common,video,file',
      // Populate contextParameters.permissions so the detail page can
      // reason about which actions the current principal is entitled to,
      // and contextParameters.thumbnail for the rendition URL. Administrator's
      // `Everything` remains a superset for the permissions check.
      'enrichers-document': 'permissions,thumbnail',
    },
    signal,
  });
}

// ---------------------------------------------------------------------------
// Mock backend. Enabled only when `VITE_MOCK_MODE=true`. Deliberately quiet
// and small; the real backend is the source of truth.
// ---------------------------------------------------------------------------

const MOCK_DOCS: MamDocument[] = [
  {
    'entity-type': 'document',
    uid: 'mock-1',
    path: '/default-domain/workspaces/mock-1',
    type: 'BroadcastAsset',
    title: 'Evening Bulletin — Wildebeest migration package',
    lastModified: '2026-09-08T18:30:00Z',
    properties: {
      'dc:title': 'Evening Bulletin — Wildebeest migration package',
      'broadcast:slug': 'wildebeest-migration',
      'broadcast:programme': 'Evening News',
      'broadcast:bureau': 'Nairobi',
      'broadcast:storyType': 'package',
      'broadcast:editorialStatus': 'approved',
      'broadcast:archiveState': 'hot',
    },
  },
  {
    'entity-type': 'document',
    uid: 'mock-2',
    path: '/default-domain/workspaces/mock-2',
    type: 'BroadcastVideo',
    title: 'Morning Bulletin — Raw drone footage',
    lastModified: '2026-09-08T09:12:00Z',
    properties: {
      'dc:title': 'Morning Bulletin — Raw drone footage',
      'broadcast:slug': 'drone-footage',
      'broadcast:programme': 'Morning Bulletin',
      'broadcast:bureau': 'Nairobi',
      'broadcast:storyType': 'raw',
      'broadcast:editorialStatus': 'qc',
      'broadcast:archiveState': 'warm',
    },
  },
  {
    'entity-type': 'document',
    uid: 'mock-3',
    path: '/default-domain/workspaces/mock-3',
    type: 'BroadcastAsset',
    title: 'Business Desk — Interview draft script',
    lastModified: '2026-09-07T21:44:00Z',
    properties: {
      'dc:title': 'Business Desk — Interview draft script',
      'broadcast:slug': 'business-interview',
      'broadcast:programme': 'Business Hour',
      'broadcast:bureau': 'London',
      'broadcast:storyType': 'interview',
      'broadcast:editorialStatus': 'draft',
      'broadcast:archiveState': 'hot',
    },
  },
];

function mockSearch(
  params: AssetSearchParams,
): NuxeoPageProviderResult<MamDocument> {
  const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
  const idx = params.currentPageIndex ?? 0;
  const q = params.q?.trim().toLowerCase();
  const filtered = MOCK_DOCS.filter((d) => {
    const props = d.properties ?? {};
    if (q) {
      const hay = [
        d.title,
        String(props['broadcast:slug'] ?? ''),
        String(props['broadcast:programme'] ?? ''),
        String(props['broadcast:bureau'] ?? ''),
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (params.storyType && props['broadcast:storyType'] !== params.storyType) return false;
    if (params.editorialStatus && props['broadcast:editorialStatus'] !== params.editorialStatus)
      return false;
    if (params.archiveState && props['broadcast:archiveState'] !== params.archiveState) return false;
    if (params.programme && props['broadcast:programme'] !== params.programme) return false;
    if (params.bureau && props['broadcast:bureau'] !== params.bureau) return false;
    const airDate = props['broadcast:airDate'] as string | undefined;
    if (params.airDateFrom && (!airDate || airDate < params.airDateFrom)) return false;
    if (params.airDateTo && (!airDate || airDate > params.airDateTo)) return false;
    return true;
  });
  const start = idx * pageSize;
  const entries = filtered.slice(start, start + pageSize);
  return {
    'entity-type': 'documents',
    entries,
    currentPageIndex: idx,
    pageSize,
    numberOfPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
    resultsCount: filtered.length,
    hasNextPage: start + pageSize < filtered.length,
    hasPreviousPage: idx > 0,
  };
}

function mockFetch(uid: string): MamDocument {
  const found = MOCK_DOCS.find((d) => d.uid === uid);
  if (!found) throw new NuxeoApiError('Not found', 404);
  return found;
}
