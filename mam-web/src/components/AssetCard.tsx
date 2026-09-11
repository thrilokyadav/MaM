import { Link } from 'react-router-dom';
import type { MamDocument } from '../types/mam';
import { StatusBadge } from './StatusBadge';
import { Thumbnail } from './Thumbnail';
import './AssetCard.css';

interface AssetCardProps {
  asset: MamDocument;
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function pick(props: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!props) return undefined;
  const raw = props[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

export function AssetCard({ asset }: AssetCardProps) {
  const props = asset.properties ?? {};
  const slug = pick(props, 'broadcast:slug');
  const programme = pick(props, 'broadcast:programme');
  const bureau = pick(props, 'broadcast:bureau');
  const storyType = pick(props, 'broadcast:storyType');
  const editorialStatus = pick(props, 'broadcast:editorialStatus');
  const archiveState = pick(props, 'broadcast:archiveState');
  const lastModified = asset.lastModified ?? pick(props, 'dc:modified');

  return (
    <article className="asset-card">
      <Link
        to={`/asset/${encodeURIComponent(asset.uid)}`}
        className="asset-thumb"
        aria-label={`Open ${asset.title}`}
      >
        <Thumbnail doc={asset} />
      </Link>

      <div className="asset-card-main">
        <div className="asset-card-headline">
          <Link to={`/asset/${encodeURIComponent(asset.uid)}`} className="asset-title">
            {asset.title || '(untitled asset)'}
          </Link>
          <div className="asset-card-badges">
            {editorialStatus ? <StatusBadge value={editorialStatus} compact /> : null}
            {archiveState ? <StatusBadge value={archiveState} compact kindHint="archive" /> : null}
          </div>
        </div>
        <dl className="asset-meta">
          <div>
            <dt>Programme</dt>
            <dd>{programme ?? '—'}</dd>
          </div>
          <div>
            <dt>Bureau</dt>
            <dd>{bureau ?? '—'}</dd>
          </div>
          <div>
            <dt>Story</dt>
            <dd>{storyType ?? '—'}</dd>
          </div>
          <div>
            <dt>Slug</dt>
            <dd className="mono">{slug ?? '—'}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{asset.type}</dd>
          </div>
        </dl>
      </div>

      <div className="asset-card-side">
        <time className="asset-modified">{formatDate(lastModified)}</time>
      </div>
    </article>
  );
}
