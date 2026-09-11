import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Film,
  ClipboardCheck,
  CheckCircle2,
  Timer,
  Upload,
  FolderSearch,
  Sparkles,
} from 'lucide-react';
import { searchAssets } from '../api/searchApi';
import { NuxeoApiError } from '../api/nuxeoClient';
import type { MamDocument } from '../types/mam';
import { AssetCard } from '../components/AssetCard';
import { MetricCard } from '../components/MetricCard';
import { LoadingState } from '../components/LoadingState';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import './pages.css';

interface Counts {
  total: number | null;
  draft: number | null;
  qc: number | null;
  approved: number | null;
}

function greetingFor(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return 'Working late, newsroom';
  if (h < 12) return 'Good morning, newsroom';
  if (h < 18) return 'Good afternoon, newsroom';
  return 'Good evening, newsroom';
}

export function DashboardPage() {
  const [entries, setEntries] = useState<MamDocument[] | null>(null);
  const [counts, setCounts] = useState<Counts>({ total: null, draft: null, qc: null, approved: null });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const ac = new AbortController();
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const [all, draft, qc, approved] = await Promise.all([
          searchAssets({ pageSize: 5, currentPageIndex: 0 }, ac.signal),
          searchAssets({ editorialStatus: 'draft', pageSize: 1 }, ac.signal),
          searchAssets({ editorialStatus: 'qc', pageSize: 1 }, ac.signal),
          searchAssets({ editorialStatus: 'approved', pageSize: 1 }, ac.signal),
        ]);
        setEntries(all.entries);
        setCounts({
          total: all.resultsCount,
          draft: draft.resultsCount,
          qc: qc.resultsCount,
          approved: approved.resultsCount,
        });
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return;
        const msg = e instanceof NuxeoApiError ? e.message : (e as Error).message;
        setError(msg);
      } finally {
        setLoading(false);
      }
    }
    void run();
    return () => ac.abort();
  }, []);

  const hasNothing = !loading && !error && counts.total === 0;

  return (
    <div className="page stack-8">
      <header className="hero card">
        <div className="hero-copy">
          <span className="hero-eyebrow">Newsroom console</span>
          <h1 className="hero-title">{greetingFor()}</h1>
          <p className="hero-sub">
            A calm view of your broadcast pipeline. Every number below reflects
            the live MAM search index.
          </p>
          <div className="hero-actions">
            <Link to="/upload" className="btn btn-primary btn-lg">
              <Upload aria-hidden="true" /> Upload media
            </Link>
            <Link to="/assets" className="btn btn-secondary btn-lg">
              <FolderSearch aria-hidden="true" /> Browse assets
            </Link>
          </div>
        </div>
      </header>

      <section aria-labelledby="metrics-heading" className="stack-6">
        <h2 id="metrics-heading" className="section-title">Pipeline overview</h2>
        <div className="metrics-grid">
          <MetricCard
            label="Total assets"
            value={counts.total ?? 0}
            Icon={Film}
            to="/assets"
            loading={loading}
            hint="Across BroadcastAsset and BroadcastVideo"
          />
          <MetricCard
            label="Awaiting QC"
            value={counts.qc ?? 0}
            Icon={Timer}
            tone="warning"
            to="/review"
            loading={loading}
            hint="Editorial status: qc"
          />
          <MetricCard
            label="Awaiting approval"
            value={counts.draft ?? 0}
            Icon={ClipboardCheck}
            tone="accent"
            to="/assets?editorialStatus=draft"
            loading={loading}
            hint="Editorial status: draft"
          />
          <MetricCard
            label="Approved"
            value={counts.approved ?? 0}
            Icon={CheckCircle2}
            tone="success"
            to="/assets?editorialStatus=approved"
            loading={loading}
            hint="Ready to distribute"
          />
        </div>
      </section>

      <section aria-labelledby="recent-heading" className="stack">
        <div className="between">
          <h2 id="recent-heading" className="section-title">Recent assets</h2>
          <Link to="/assets" className="btn btn-quiet btn-sm">View all</Link>
        </div>

        {loading ? (
          <LoadingState rows={4} label="Loading recent assets" />
        ) : error ? (
          <ErrorState message={error} />
        ) : hasNothing ? (
          <FirstRun />
        ) : entries && entries.length === 0 ? (
          <EmptyState
            title="No assets to show"
            description="Once assets are ingested, the five most recently modified will appear here."
            action={<Link to="/upload" className="btn btn-primary btn-sm"><Upload aria-hidden="true" /> Upload media</Link>}
          />
        ) : (
          <div className="stack">
            {entries?.map((a) => <AssetCard key={a.uid} asset={a} />)}
          </div>
        )}
      </section>
    </div>
  );
}

function FirstRun() {
  return (
    <div className="card first-run">
      <div className="first-run-mark" aria-hidden="true">
        <Sparkles />
      </div>
      <div className="first-run-body">
        <h3 className="first-run-title">Set up your newsroom</h3>
        <p className="first-run-sub">
          The connection to Nuxeo is live and no assets are indexed yet. Two
          practical next steps:
        </p>
        <ol className="first-run-steps">
          <li>
            <strong>Upload media</strong> — drag a video or script into the
            upload zone. The ingest pipeline will register the file as a
            BroadcastAsset or BroadcastVideo.
          </li>
          <li>
            <strong>Provision groups</strong> — mam-producers, mam-editors,
            mam-publishers, and mam-archivists live in your identity
            provider. Once wired, the editorial workflow routes tasks
            automatically.
          </li>
        </ol>
        <div className="first-run-actions">
          <Link to="/upload" className="btn btn-primary">
            <Upload aria-hidden="true" /> Upload media
          </Link>
          <Link to="/settings" className="btn btn-secondary">Open settings</Link>
        </div>
      </div>
    </div>
  );
}
