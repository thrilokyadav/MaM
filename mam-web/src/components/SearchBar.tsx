import { useEffect, useId, useState } from 'react';
import { Search, XCircle } from 'lucide-react';
import type { AssetSearchParams } from '../types/mam';
import './SearchBar.css';

interface SearchBarProps {
  value: AssetSearchParams;
  onChange: (next: AssetSearchParams) => void;
  onSubmit: () => void;
  busy?: boolean;
}

const STATUSES: Array<{ value: string; label: string }> = [
  { value: 'draft', label: 'Draft' },
  { value: 'qc', label: 'QC' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

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
];

export function SearchBar({ value, onChange, onSubmit, busy }: SearchBarProps) {
  const [localQ, setLocalQ] = useState<string>(value.q ?? '');
  const qFieldId = useId();

  useEffect(() => {
    setLocalQ(value.q ?? '');
  }, [value.q]);

  function commit(next: Partial<AssetSearchParams>) {
    onChange({ ...value, ...next, currentPageIndex: 0 });
  }

  function toggleFilter(key: 'editorialStatus' | 'storyType' | 'archiveState', val: string) {
    commit({ [key]: value[key] === val ? undefined : val } as Partial<AssetSearchParams>);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    commit({ q: localQ.trim() || undefined });
    onSubmit();
  }

  const hasFilters = Boolean(
    value.q || value.editorialStatus || value.storyType || value.archiveState,
  );

  return (
    <section className="search-panel card" aria-label="Search assets">
      <form className="search-form" role="search" onSubmit={handleSubmit}>
        <div className="input-with-icon search-input">
          <Search aria-hidden="true" />
          <label htmlFor={qFieldId} className="sr-only">Search</label>
          <input
            id={qFieldId}
            type="search"
            className="input input-lg"
            placeholder="Search by title…"
            value={localQ}
            onChange={(e) => setLocalQ(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>

      <div className="search-filters" role="group" aria-label="Filters">
        <FilterGroup label="Status" active={value.editorialStatus}>
          {STATUSES.map((o) => (
            <FilterChip
              key={o.value}
              active={value.editorialStatus === o.value}
              onClick={() => toggleFilter('editorialStatus', o.value)}
            >
              {o.label}
            </FilterChip>
          ))}
        </FilterGroup>

        <FilterGroup label="Story" active={value.storyType}>
          {STORY_TYPES.map((o) => (
            <FilterChip
              key={o.value}
              active={value.storyType === o.value}
              onClick={() => toggleFilter('storyType', o.value)}
            >
              {o.label}
            </FilterChip>
          ))}
        </FilterGroup>

        <FilterGroup label="Archive" active={value.archiveState}>
          {ARCHIVE_STATES.map((o) => (
            <FilterChip
              key={o.value}
              active={value.archiveState === o.value}
              onClick={() => toggleFilter('archiveState', o.value)}
            >
              {o.label}
            </FilterChip>
          ))}
        </FilterGroup>

        <div className="search-filters-tail">
          {hasFilters ? (
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() => {
                setLocalQ('');
                onChange({});
                onSubmit();
              }}
            >
              <XCircle aria-hidden="true" /> Clear filters
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function FilterGroup({
  label,
  active,
  children,
}: {
  label: string;
  active?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="filter-group">
      <span className="filter-group-label">
        {label}
        {active ? <span className="filter-group-dot" aria-hidden="true" /> : null}
      </span>
      <div className="filter-chips">{children}</div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="chip"
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
