import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Archive as ArchiveIcon,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Lock,
  RotateCcw,
  ShieldAlert,
  X,
  XCircle,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { searchAssets, DEFAULT_PAGE_SIZE } from '../api/searchApi';
import { archiveAsset, restoreAsset, canArchive, canRestore, pollUntilRestored } from '../api/archiveApi';
import { NuxeoApiError } from '../api/nuxeoClient';
import type { AssetSearchParams, MamDocument } from '../types/mam';
import type { NuxeoPageProviderResult } from '../types/nuxeo';
import { StatusBadge } from '../components/StatusBadge';
import { Thumbnail } from '../components/Thumbnail';
import { LoadingState } from '../components/LoadingState';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import './pages.css';
import './ArchivePage.css';

// Archive is scoped to approved assets — everything else belongs to the
// editorial Review Queue, not this page.
const FIXED_EDITORIAL_STATUS = 'approved';

const STORY_TYPES: Array<{ value: string; label: string }> = [
  { value: 'package', label: 'Package' },
  { value: 'raw', label: 'Raw' },
  { value: 'interview', label: 'Interview' },
  { value: 'news', label: 'News' },
  { value: 'promo', label: 'Promo' },
];

const ARCHIVE_STATES: Array<{ value: string; label: string }> = [
  { value: 'hot', label: 'Hot' },
  { value: 'warm', label: 'Warm' },
  { value: 'cold', label: 'Cold' },
  { value: 'restore-pending', label: 'Restoring' },
];

function paramsFromUrl(url: URLSearchParams): AssetSearchParams {
  const idx = url.get('page');
  return {
    q: url.get('q') ?? undefined,
    programme: url.get('programme') ?? undefined,
    bureau: url.get('bureau') ?? undefined,
    storyType: url.get('storyType') ?? undefined,
    archiveState: url.get('archiveState') ?? undefined,
    airDateFrom: url.get('from') ?? undefined,
    airDateTo: url.get('to') ?? undefined,
    editorialStatus: FIXED_EDITORIAL_STATUS,
    currentPageIndex: idx ? Math.max(0, parseInt(idx, 10) || 0) : 0,
    pageSize: DEFAULT_PAGE_SIZE,
  };
}

function urlFromParams(p: AssetSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  if (p.q) out.set('q', p.q);
  if (p.programme) out.set('programme', p.programme);
  if (p.bureau) out.set('bureau', p.bureau);
  if (p.storyType) out.set('storyType', p.storyType);
  if (p.archiveState) out.set('archiveState', p.archiveState);
  if (p.airDateFrom) out.set('from', p.airDateFrom);
  if (p.airDateTo) out.set('to', p.airDateTo);
  if (p.currentPageIndex) out.set('page', String(p.currentPageIndex));
  return out;
}

function pick(props: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!props) return undefined;
  const raw = props[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function describeError(e: unknown): { kind: 'denied' | 'error'; message: string } {
  if (e instanceof NuxeoApiError) {
    if (e.status === 403) {
      return { kind: 'denied', message: e.message || 'You do not have permission to perform this action.' };
    }
    return { kind: 'error', message: e.message || `Request failed (HTTP ${e.status || 'network error'}).` };
  }
  return { kind: 'error', message: e instanceof Error ? e.message : 'Unknown error.' };
}

interface RowState {
  busy?: 'archive' | 'restore';
  /** Set while MamRestoreWork is running (restore-pending polling active). */
  restoring?: boolean;
  result?: { kind: 'success'; message: string } | { kind: 'denied'; message: string } | { kind: 'error'; message: string };
}

export function ArchivePage() {
  const [url, setUrl] = useSearchParams();
  const params = useMemo(() => paramsFromUrl(url), [url]);

  const [result, setResult] = useState<NuxeoPageProviderResult<MamDocument> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const activeReq = useRef<AbortController | null>(null);

  // Local, uncommitted text-field state for programme/bureau/date so typing
  // doesn't re-run the search on every keystroke; committed on submit.
  const [localProgramme, setLocalProgramme] = useState(params.programme ?? '');
  const [localBureau, setLocalBureau] = useState(params.bureau ?? '');
  const [localFrom, setLocalFrom] = useState(params.airDateFrom ?? '');
  const [localTo, setLocalTo] = useState(params.airDateTo ?? '');

  useEffect(() => {
    setLocalProgramme(params.programme ?? '');
    setLocalBureau(params.bureau ?? '');
    setLocalFrom(params.airDateFrom ?? '');
    setLocalTo(params.airDateTo ?? '');
  }, [params.programme, params.bureau, params.airDateFrom, params.airDateTo]);

  const runSearch = useCallback(async (p: AssetSearchParams, opts: { silent?: boolean } = {}) => {
    activeReq.current?.abort();
    const ac = new AbortController();
    activeReq.current = ac;
    if (!opts.silent) setLoading(true);
    setError(null);
    try {
      // Fetch a larger page than the default: programme/bureau/date are
      // applied client-side (no backend predicate exists for them), so a
      // wider page keeps the visible filtered results reasonably complete.
      const r = await searchAssets({ ...p, pageSize: 60 }, ac.signal);
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
    return () => activeReq.current?.abort();
  }, [params, runSearch]);

  function setParams(next: AssetSearchParams) {
    setUrl(urlFromParams({ ...next, currentPageIndex: 0 }), { replace: true });
  }

  function goToPage(idx: number) {
    setUrl(urlFromParams({ ...params, currentPageIndex: Math.max(0, idx) }), { replace: true });
  }

  function handleFilterSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setParams({
      ...params,
      programme: localProgramme.trim() || undefined,
      bureau: localBureau.trim() || undefined,
      airDateFrom: localFrom || undefined,
      airDateTo: localTo || undefined,
    });
  }

  function toggleChip(key: 'storyType' | 'archiveState', val: string) {
    setParams({ ...params, [key]: params[key] === val ? undefined : val });
  }

  function clearFilters() {
    setLocalProgramme('');
    setLocalBureau('');
    setLocalFrom('');
    setLocalTo('');
    setUrl(urlFromParams({ editorialStatus: FIXED_EDITORIAL_STATUS }), { replace: true });
  }

  function setRow(uid: string, patch: RowState) {
    setRowState((prev) => ({ ...prev, [uid]: { ...prev[uid], ...patch } }));
  }

  async function runRowAction(
    doc: MamDocument,
    kind: 'archive' | 'restore',
    fn: () => Promise<unknown>,
    successMessage: string,
  ) {
    setRow(doc.uid, { busy: kind, result: undefined });
    try {
      await fn();
      setRow(doc.uid, { busy: undefined, result: { kind: 'success', message: successMessage } });
      await new Promise((r) => setTimeout(r, 900));
      await runSearch(params, { silent: true });
    } catch (e) {
      setRow(doc.uid, { busy: undefined, result: describeError(e) });
    }
  }

  function onArchive(doc: MamDocument) {
    void runRowAction(doc, 'archive', () => archiveAsset(doc.uid), 'Archived to cold storage.');
  }

  /**
   * Restore flow:
   * 1. Call MAM.RestoreAsset (sets archiveState=restore-pending synchronously).
   * 2. Mark row as restoring=true so the UI shows a live spinner.
   * 3. Poll every 3s via pollUntilRestored until archiveState != restore-pending.
   * 4. Refresh the full list when the worker completes.
   */
  function onRestore(doc: MamDocument) {
    const uid = doc.uid;
    setRow(uid, { busy: 'restore', result: undefined });
    void (async () => {
      try {
        await restoreAsset(uid);
        // Blob move in progress — switch to polling mode.
        setRow(uid, { busy: undefined, restoring: true, result: undefined });
        await pollUntilRestored(uid, undefined, 3000);
        setRow(uid, { restoring: false, result: { kind: 'success', message: 'Restored to hot storage.' } });
        await new Promise((r) => setTimeout(r, 900));
        await runSearch(params, { silent: true });
      } catch (e) {
        setRow(uid, { busy: undefined, restoring: false, result: describeError(e) });
      }
    })();
  }

  const hasClientFilters = Boolean(params.programme || params.bureau || params.airDateFrom || params.airDateTo);
  const serverEntries = result?.entries ?? [];
  const entries = hasClientFilters
    ? serverEntries.filter((a) => {
        const props = a.properties ?? {};
        if (params.programme && pick(props, 'broadcast:programme') !== params.programme) return false;
        if (params.bureau && pick(props, 'broadcast:bureau') !== params.bureau) return false;
        const airDate = pick(props, 'broadcast:airDate');
        if (params.airDateFrom && (!airDate || airDate < params.airDateFrom)) return false;
        if (params.airDateTo && (!airDate || airDate > params.airDateTo)) return false;
        return true;
      })
    : serverEntries;

  const total = hasClientFilters ? entries.length : (result?.resultsCount ?? 0);
  const idx = result?.currentPageIndex ?? 0;
  const numPages = result?.numberOfPages ?? 0;
  const hasFilters = Boolean(
    params.programme || params.bureau || params.storyType || params.archiveState || params.airDateFrom || params.airDateTo,
  );

  return (
    <div className="page stack-6">
      <header className="page-header">
        <div>
          <h1 className="page-title">Archive</h1>
          <p className="page-subtitle">
            Approved assets, by storage tier. Search and filter by programme,
            bureau, story type, air date, and archive state. Archivists and
            administrators can move assets between tiers below.
          </p>
        </div>
      </header>

      <section className="card archive-filters" aria-label="Archive filters">
        <form className="archive-filter-form" onSubmit={handleFilterSubmit}>
          <label className="archive-field">
            <span className="archive-field-label">Programme</span>
            <input
              type="text"
              className="input"
              placeholder="e.g. Evening News"
              value={localProgramme}
              onChange={(e) => setLocalProgramme(e.target.value)}
            />
          </label>
          <label className="archive-field">
            <span className="archive-field-label">Bureau</span>
            <input
              type="text"
              className="input"
              placeholder="e.g. Nairobi"
              value={localBureau}
              onChange={(e) => setLocalBureau(e.target.value)}
            />
          </label>
          <label className="archive-field">
            <span className="archive-field-label">Air date from</span>
            <input
              type="date"
              className="input"
              value={localFrom}
              onChange={(e) => setLocalFrom(e.target.value)}
            />
          </label>
          <label className="archive-field">
            <span className="archive-field-label">Air date to</span>
            <input
              type="date"
              className="input"
              value={localTo}
              onChange={(e) => setLocalTo(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-primary">Apply</button>
        </form>

        <div className="search-filters" role="group" aria-label="Story type and archive state">
          <div className="filter-group">
            <span className="filter-group-label">
              Story
              {params.storyType ? <span className="filter-group-dot" aria-hidden="true" /> : null}
            </span>
            <div className="filter-chips">
              {STORY_TYPES.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className="chip"
                  aria-pressed={params.storyType === o.value}
                  onClick={() => toggleChip('storyType', o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <span className="filter-group-label">
              Tier
              {params.archiveState ? <span className="filter-group-dot" aria-hidden="true" /> : null}
            </span>
            <div className="filter-chips">
              {ARCHIVE_STATES.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className="chip"
                  aria-pressed={params.archiveState === o.value}
                  onClick={() => toggleChip('archiveState', o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="search-filters-tail">
            {hasFilters ? (
              <button type="button" className="btn btn-quiet btn-sm" onClick={clearFilters}>
                <XCircle aria-hidden="true" /> Clear filters
              </button>
            ) : null}
          </div>
        </div>

        {hasClientFilters ? (
          <p className="archive-filter-note">
            Programme, bureau, and date filters are applied to the current
            page of results (not the full server-side result set).
          </p>
        ) : null}
      </section>

      <div className="results-header">
        <span className="results-count" aria-live="polite">
          {loading ? 'Loading…' : error ? 'Search failed' : `${total.toLocaleString()} ${total === 1 ? 'asset' : 'assets'}`}
        </span>
      </div>

      {loading ? (
        <LoadingState rows={5} label="Loading archive" />
      ) : error ? (
        <ErrorState
          message={error}
          action={
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void runSearch(params)}>
              Retry
            </button>
          }
        />
      ) : entries.length === 0 ? (
        <EmptyState
          Icon={ArchiveIcon}
          title="No archived assets match"
          description="Approved assets appear here once broadcast:editorialStatus is approved. Try clearing a filter, or check back once assets have been through editorial review."
        />
      ) : (
        <div className="stack">
          {entries.map((doc) => (
            <ArchiveRow
              key={doc.uid}
              doc={doc}
              state={rowState[doc.uid] ?? {}}
              onArchive={() => onArchive(doc)}
              onRestore={() => onRestore(doc)}
              onDismissResult={() => setRow(doc.uid, { result: undefined })}
            />
          ))}
        </div>
      )}

      {!loading && !error && !hasClientFilters && numPages > 1 && (
        <nav className="pagination" aria-label="Pagination">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => goToPage(idx - 1)} disabled={idx <= 0}>
            <ChevronLeft aria-hidden="true" /> Previous
          </button>
          <span className="pagination-info">Page {idx + 1} of {numPages}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => goToPage(idx + 1)} disabled={idx >= numPages - 1}>
            Next <ChevronRight aria-hidden="true" />
          </button>
        </nav>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface ArchiveRowProps {
  doc: MamDocument;
  state: RowState;
  onArchive: () => void;
  onRestore: () => void;
  onDismissResult: () => void;
}


function ArchiveRow({ doc, state, onArchive, onRestore, onDismissResult }: ArchiveRowProps) {
  const props = doc.properties ?? {};
  const programme = pick(props, 'broadcast:programme');
  const bureau = pick(props, 'broadcast:bureau');
  const storyType = pick(props, 'broadcast:storyType');
  const archiveState = pick(props, 'broadcast:archiveState');
  const airDate = pick(props, 'broadcast:airDate');
  const archiveDate = pick(props, 'broadcast:archiveDate');
  const lastModified = doc.lastModified ?? pick(props, 'dc:modified');

  const isCold = archiveState === 'cold' || archiveState === 'restore-pending';
  const isRestorePending = archiveState === 'restore-pending' || state.restoring;
  const allowedToArchive = canArchive(doc);
  const allowedToRestore = canRestore(doc);
  const busy = state.busy;
  const busyAny = Boolean(busy) || Boolean(state.restoring);

  return (
    <article className="asset-card archive-row">
      <Link to={`/asset/${encodeURIComponent(doc.uid)}`} className="asset-thumb" aria-label={`Open ${doc.title}`}>
        <Thumbnail doc={doc} />
      </Link>

      <div className="asset-card-main">
        <div className="asset-card-headline">
          <Link to={`/asset/${encodeURIComponent(doc.uid)}`} className="asset-title">
            {doc.title || '(untitled asset)'}
          </Link>
          <div className="asset-card-badges">
            <StatusBadge value="approved" compact />
            {archiveState ? <StatusBadge value={archiveState} compact kindHint="archive" /> : null}
          </div>
        </div>

        <dl className="asset-meta">
          <div><dt>Programme</dt><dd>{programme ?? '—'}</dd></div>
          <div><dt>Bureau</dt><dd>{bureau ?? '—'}</dd></div>
          <div><dt>Story</dt><dd>{storyType ?? '—'}</dd></div>
          <div><dt>Air date</dt><dd>{formatDate(airDate)}</dd></div>
          {archiveDate ? <div><dt>Archived</dt><dd>{formatDate(archiveDate)}</dd></div> : null}
          <div><dt>Last updated</dt><dd>{formatDate(lastModified)}</dd></div>
        </dl>

        {state.result ? <RowResultBanner result={state.result} onDismiss={onDismissResult} /> : null}
      </div>

      <div className="archive-row-actions">
        <Link to={`/asset/${encodeURIComponent(doc.uid)}`} className="btn btn-quiet btn-sm">
          <ExternalLink aria-hidden="true" /> Open detail
        </Link>
        {isCold ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onRestore}
            disabled={busyAny || !allowedToRestore || isRestorePending}
            title={
              isRestorePending
                ? 'Restore in progress — the background worker is copying the file back to hot storage.'
                : !allowedToRestore
                  ? 'Requires MAM_Archive (mam-archivists) or Write on this asset.'
                  : undefined
            }
          >
            {isRestorePending
              ? <><Loader2 aria-hidden="true" className="spin" /> Restoring…</>
              : <><RotateCcw aria-hidden="true" /> Restore</>}
            {!allowedToRestore && !isRestorePending
              ? <Lock aria-hidden="true" style={{ width: 12, height: 12, opacity: 0.6 }} />
              : null}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onArchive}
            disabled={busyAny || !allowedToArchive}
            title={!allowedToArchive ? 'Requires MAM_Archive (mam-archivists) or Write on this asset.' : undefined}
          >
            {busy === 'archive'
              ? <><Loader2 aria-hidden="true" className="spin" /> Archiving…</>
              : <><ArchiveIcon aria-hidden="true" /> Archive</>}
            {!allowedToArchive ? <Lock aria-hidden="true" style={{ width: 12, height: 12, opacity: 0.6 }} /> : null}
          </button>
        )}
      </div>
    </article>
  );
}

function RowResultBanner({
  result,
  onDismiss,
}: {
  result: NonNullable<RowState['result']>;
  onDismiss: () => void;
}) {
  const Icon = result.kind === 'success' ? ArchiveIcon : result.kind === 'denied' ? ShieldAlert : XCircle;
  return (
    <div className={`archive-result archive-result-${result.kind}`} role={result.kind === 'success' ? 'status' : 'alert'}>
      <Icon aria-hidden="true" />
      <span>{result.message}</span>
      <button type="button" className="btn btn-quiet btn-sm archive-result-dismiss" onClick={onDismiss} aria-label="Dismiss">
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
