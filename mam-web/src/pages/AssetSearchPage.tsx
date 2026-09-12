import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowUpDown, ChevronLeft, ChevronRight, Inbox } from 'lucide-react';
import { searchAssets, DEFAULT_PAGE_SIZE } from '../api/searchApi';
import { NuxeoApiError } from '../api/nuxeoClient';
import type { AssetSearchParams, MamDocument } from '../types/mam';
import type { NuxeoPageProviderResult } from '../types/nuxeo';
import { SearchBar } from '../components/SearchBar';
import { AssetCard } from '../components/AssetCard';
import { LoadingState } from '../components/LoadingState';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import './pages.css';

function paramsFromUrl(url: URLSearchParams): AssetSearchParams {
  const idx = url.get('page');
  const size = url.get('size');
  return {
    q: url.get('q') ?? undefined,
    storyType: url.get('storyType') ?? undefined,
    editorialStatus: url.get('editorialStatus') ?? undefined,
    archiveState: url.get('archiveState') ?? undefined,
    currentPageIndex: idx ? Math.max(0, parseInt(idx, 10) || 0) : 0,
    pageSize: size ? parseInt(size, 10) || DEFAULT_PAGE_SIZE : DEFAULT_PAGE_SIZE,
  };
}

function urlFromParams(p: AssetSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  if (p.q) out.set('q', p.q);
  if (p.storyType) out.set('storyType', p.storyType);
  if (p.editorialStatus) out.set('editorialStatus', p.editorialStatus);
  if (p.archiveState) out.set('archiveState', p.archiveState);
  if (p.currentPageIndex) out.set('page', String(p.currentPageIndex));
  if (p.pageSize && p.pageSize !== DEFAULT_PAGE_SIZE) out.set('size', String(p.pageSize));
  return out;
}

export function AssetSearchPage() {
  const [url, setUrl] = useSearchParams();
  const params = useMemo(() => paramsFromUrl(url), [url]);

  const [result, setResult] = useState<NuxeoPageProviderResult<MamDocument> | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const activeReq = useRef<AbortController | null>(null);

  const runSearch = useCallback(async (p: AssetSearchParams) => {
    activeReq.current?.abort();
    const ac = new AbortController();
    activeReq.current = ac;
    setLoading(true);
    setError(null);
    try {
      const r = await searchAssets(p, ac.signal);
      setResult(r);
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return;
      const msg = e instanceof NuxeoApiError ? e.message : (e as Error).message;
      setError(msg);
      setResult(null);
    } finally {
      if (activeReq.current === ac) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runSearch(params);
  }, [params, runSearch]);

  function setParams(next: AssetSearchParams) {
    setUrl(urlFromParams(next), { replace: true });
  }

  function goToPage(idx: number) {
    setParams({ ...params, currentPageIndex: Math.max(0, idx) });
  }

  const total = result?.resultsCount ?? 0;
  const idx = result?.currentPageIndex ?? 0;
  const size = result?.pageSize ?? DEFAULT_PAGE_SIZE;
  const numPages = result?.numberOfPages ?? 0;
  const rangeStart = total === 0 ? 0 : idx * size + 1;
  const rangeEnd = Math.min(total, (idx + 1) * size);

  return (
    <div className="page stack-6">
      <header className="page-header">
        <div>
          <h1 className="page-title">Assets</h1>
          <p className="page-subtitle">
            Live search across BroadcastAsset and BroadcastVideo. Filters
            combine with AND; empty filters are dropped server-side.
          </p>
        </div>
      </header>

      <SearchBar
        value={params}
        onChange={setParams}
        onSubmit={() => void runSearch(params)}
        busy={loading}
      />

      <div className="results-header">
        <span className="results-count" aria-live="polite">
          {loading
            ? 'Searching…'
            : error
            ? 'Search failed'
            : `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'}`}
          {!loading && !error && total > 0 && (
            <span className="results-range"> · showing {rangeStart}–{rangeEnd}</span>
          )}
        </span>
        <div className="results-sort" role="group" aria-label="Sort">
          <ArrowUpDown aria-hidden="true" />
          <span className="results-sort-label">Sorted by</span>
          <span className="results-sort-value">Most recently modified</span>
        </div>
      </div>

      {loading ? (
        <LoadingState rows={5} label="Searching" />
      ) : error ? (
        <ErrorState
          message={error}
          action={
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void runSearch(params)}
            >
              Retry
            </button>
          }
        />
      ) : result && result.entries.length === 0 ? (
        <EmptyState
          Icon={Inbox}
          title="No matching assets"
          description="Try a different search term or clear a filter."
        />
      ) : (
        <div className="stack">
          {result?.entries.map((a) => <AssetCard key={a.uid} asset={a} />)}
        </div>
      )}

      {!loading && !error && numPages > 1 && (
        <nav className="pagination" aria-label="Pagination">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => goToPage(idx - 1)}
            disabled={idx <= 0}
          >
            <ChevronLeft aria-hidden="true" /> Previous
          </button>
          <span className="pagination-info">
            Page {idx + 1} of {numPages}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => goToPage(idx + 1)}
            disabled={idx >= numPages - 1}
          >
            Next <ChevronRight aria-hidden="true" />
          </button>
        </nav>
      )}
    </div>
  );
}
