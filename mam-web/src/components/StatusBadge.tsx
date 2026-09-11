import './StatusBadge.css';

export type BadgeKind =
  | 'draft'
  | 'qc'
  | 'approved'
  | 'rejected'
  | 'hot'
  | 'warm'
  | 'cold'
  | 'restore-pending'
  | 'unknown';

interface StatusBadgeProps {
  value?: string;
  label?: string;
  /** Compact height for dense lists. */
  compact?: boolean;
  /** Force a specific badge kind, e.g. archive vs editorial. */
  kindHint?: 'editorial' | 'archive';
}

const EDITORIAL = new Set(['draft', 'qc', 'approved', 'rejected']);
const ARCHIVE = new Set(['hot', 'warm', 'cold', 'restore-pending']);

function humanize(v: string): string {
  if (v === 'qc') return 'QC';
  if (v === 'restore-pending') return 'Restoring';
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function resolveKind(value: string): BadgeKind {
  if (EDITORIAL.has(value)) return value as BadgeKind;
  if (ARCHIVE.has(value)) return value as BadgeKind;
  return 'unknown';
}

export function StatusBadge({ value, label, compact, kindHint }: StatusBadgeProps) {
  const raw = (value ?? '').toString().trim().toLowerCase();
  const kind = resolveKind(raw);
  const text = label ?? (raw ? humanize(raw) : 'Unspecified');
  const groupLabel = kindHint === 'archive' ? 'Archive' : 'Editorial';
  return (
    <span
      className={`status-badge status-${kind}${compact ? ' status-compact' : ''}`}
      aria-label={`${groupLabel} status: ${text}`}
    >
      <span className="status-dot" aria-hidden="true" />
      {text}
    </span>
  );
}
