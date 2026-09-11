import './states.css';

interface LoadingStateProps {
  rows?: number;
  label?: string;
  variant?: 'list' | 'grid';
}

export function LoadingState({ rows = 4, label = 'Loading', variant = 'list' }: LoadingStateProps) {
  return (
    <div className="state-container" role="status" aria-live="polite">
      <span className="sr-only">{label}…</span>
      <ul className={variant === 'grid' ? 'skeleton-grid' : 'skeleton-list'} aria-hidden="true">
        {Array.from({ length: rows }).map((_, i) => (
          <li key={i} className="skeleton-row">
            <span className="skeleton skeleton-thumb" />
            <span className="skeleton-lines">
              <span className="skeleton skeleton-title" />
              <span className="skeleton skeleton-line" />
              <span className="skeleton skeleton-line short" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
