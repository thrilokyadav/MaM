import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import './MetricCard.css';

interface MetricCardProps {
  label: string;
  value: number | string | null;
  Icon: LucideIcon;
  /** Optional link to a filtered view. */
  to?: string;
  /** Optional short caption under the value. */
  hint?: ReactNode;
  loading?: boolean;
  /** Colour treatment for the icon chip. */
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
}

export function MetricCard({
  label,
  value,
  Icon,
  to,
  hint,
  loading,
  tone = 'neutral',
}: MetricCardProps) {
  const inner = (
    <>
      <div className={`metric-icon metric-icon-${tone}`}>
        <Icon aria-hidden="true" />
      </div>
      <div className="metric-body">
        <span className="metric-label">{label}</span>
        <span className="metric-value">
          {loading ? <span className="skeleton metric-skeleton" /> : value === null ? '—' : value}
        </span>
        {hint ? <span className="metric-hint">{hint}</span> : null}
      </div>
    </>
  );

  if (to) {
    return (
      <Link to={to} className="metric-card metric-card-link">
        {inner}
      </Link>
    );
  }
  return <div className="metric-card">{inner}</div>;
}
