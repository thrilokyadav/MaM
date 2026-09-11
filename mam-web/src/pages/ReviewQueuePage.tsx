import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Undo2,
  X,
  XCircle,
} from 'lucide-react';
import {
  listReviewQueue,
  approveTask,
  rejectTask,
  sendBackToDraft,
  submitToEditorial,
} from '../api/reviewApi';
import type { ReviewQueueEntry } from '../api/reviewApi';
import { getCurrentUser } from '../api/meApi';
import { NuxeoApiError } from '../api/nuxeoClient';
import { StatusBadge } from '../components/StatusBadge';
import { Thumbnail } from '../components/Thumbnail';
import { LoadingState } from '../components/LoadingState';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import './pages.css';
import './ReviewQueuePage.css';

interface RowState {
  /** Task action name currently in flight for this task, if any. */
  busy?: string;
  /** Result of the most recently completed action, shown inline. */
  result?: { kind: 'success'; message: string } | { kind: 'denied'; message: string } | { kind: 'error'; message: string };
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function pick(props: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!props) return undefined;
  const raw = props[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
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

/** Human-readable label for a workflow node, falling back to the raw id. */
const NODE_LABELS: Record<string, string> = {
  NodeQC: 'Quality Control',
  NodeEditorial: 'Editorial Approval',
  NodeDraft: 'Draft',
};

export function ReviewQueuePage() {
  const [entries, setEntries] = useState<ReviewQueueEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [rejectTarget, setRejectTarget] = useState<ReviewQueueEntry | null>(null);
  const activeReq = useRef<AbortController | null>(null);

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    activeReq.current?.abort();
    const ac = new AbortController();
    activeReq.current = ac;
    // A "silent" refresh (after a successful action) keeps the current
    // list on screen — including the just-shown success/denied banner —
    // instead of dropping straight to a loading skeleton. The initial
    // load and manual Retry still show the skeleton.
    if (!opts.silent) setLoading(true);
    setQueueError(null);
    try {
      const me = await getCurrentUser();
      setCurrentUserId(me.id);
      const rows = await listReviewQueue(ac.signal);
      setEntries(rows);
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return;
      const msg = e instanceof NuxeoApiError ? e.message : (e as Error).message;
      setQueueError(msg);
      setEntries(null);
    } finally {
      if (activeReq.current === ac) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => activeReq.current?.abort();
  }, [load]);

  function setRow(taskId: string, patch: RowState) {
    setRowState((prev) => ({ ...prev, [taskId]: { ...prev[taskId], ...patch } }));
  }

  async function runAction(
    entry: ReviewQueueEntry,
    kind: string,
    fn: () => Promise<void>,
    successMessage: string,
  ) {
    const taskId = entry.task.id;
    setRow(taskId, { busy: kind, result: undefined });
    try {
      await fn();
      setRow(taskId, { busy: undefined, result: { kind: 'success', message: successMessage } });
      // Give the success banner a beat on screen before refreshing — a
      // completed task disappears from "my tasks" entirely, so without
      // this pause the banner would never be visible.
      await new Promise((r) => setTimeout(r, 1200));
      // Refresh tasks + document status from the server. Silent: keep the
      // list mounted instead of showing the loading skeleton again.
      await load({ silent: true });
    } catch (e) {
      const described = describeError(e);
      setRow(taskId, { busy: undefined, result: described });
    }
  }

  function onApprove(entry: ReviewQueueEntry) {
    void runAction(entry, 'approve', () => approveTask(entry), 'Approved.');
  }

  function onSubmit(entry: ReviewQueueEntry) {
    void runAction(entry, 'submit_to_editorial', () => submitToEditorial(entry), 'Submitted to Editorial Approval.');
  }

  function onSendBackToDraft(entry: ReviewQueueEntry) {
    void runAction(entry, 'draft', () => sendBackToDraft(entry), 'Sent back to draft.');
  }

  function onRejectConfirm(reason: string) {
    if (!rejectTarget) return;
    const entry = rejectTarget;
    setRejectTarget(null);
    void runAction(entry, 'reject', () => rejectTask(entry, reason), 'Rejected.');
  }

  const totalCount = entries?.length ?? 0;

  return (
    <div className="page stack-6">
      <header className="page-header">
        <div>
          <h1 className="page-title">Review queue</h1>
          <p className="page-subtitle">
            Your open editorial tasks from the live{' '}
            <code className="mono">MAM_EDITORIAL_APPROVAL</code> Nuxeo
            workflow{currentUserId ? <> — signed in as <code>{currentUserId}</code></> : null}.
            Only tasks assigned to you, or to a group you belong to, appear
            here; actions below complete the real workflow task.
          </p>
        </div>
        <div className="row">
          <span className="results-count" aria-live="polite">
            {loading ? 'Loading…' : `${totalCount} task${totalCount === 1 ? '' : 's'}`}
          </span>
          <Link to="/assets?editorialStatus=qc" className="btn btn-secondary">
            Open in Assets
          </Link>
        </div>
      </header>

      {loading ? (
        <LoadingState rows={4} label="Loading queue" />
      ) : queueError ? (
        <ErrorState
          message={queueError}
          action={
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
              Retry
            </button>
          }
        />
      ) : entries && entries.length === 0 ? (
        <EmptyState
          Icon={ClipboardCheck}
          title="Nothing to review"
          description="You have no open workflow tasks right now. Once an asset is submitted and assigned to you (or your team), it appears here."
        />
      ) : (
        <div className="stack">
          {entries?.map((entry) => (
            <ReviewRow
              key={entry.task.id}
              entry={entry}
              state={rowState[entry.task.id] ?? {}}
              onApprove={() => onApprove(entry)}
              onReject={() => setRejectTarget(entry)}
              onSubmit={() => onSubmit(entry)}
              onSendBackToDraft={() => onSendBackToDraft(entry)}
              onDismissResult={() => setRow(entry.task.id, { result: undefined })}
            />
          ))}
        </div>
      )}

      {rejectTarget ? (
        <RejectDialog
          entry={rejectTarget}
          onCancel={() => setRejectTarget(null)}
          onConfirm={onRejectConfirm}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface ReviewRowProps {
  entry: ReviewQueueEntry;
  state: RowState;
  onApprove: () => void;
  onReject: () => void;
  onSubmit: () => void;
  onSendBackToDraft: () => void;
  onDismissResult: () => void;
}

function ReviewRow({ entry, state, onApprove, onReject, onSubmit, onSendBackToDraft, onDismissResult }: ReviewRowProps) {
  const { task, asset, assetError } = entry;

  if (!asset) {
    return (
      <article className="review-row card">
        <div className="asset-thumb review-thumb review-thumb-error" aria-hidden="true">
          <ShieldAlert />
        </div>
        <div className="review-row-main">
          <div className="review-row-headline">
            <span className="asset-title">Task {task.id.slice(0, 8)}…</span>
          </div>
          <p className="review-task-note">
            Assigned step <span className="mono">{NODE_LABELS[task.nodeName ?? ''] ?? task.nodeName ?? '—'}</span>
          </p>
          <div className="review-result review-result-error" role="alert">
            <XCircle aria-hidden="true" />
            <span>{assetError ?? 'The document for this task could not be loaded.'}</span>
          </div>
        </div>
      </article>
    );
  }

  const props = asset.properties ?? {};
  const programme = pick(props, 'broadcast:programme');
  const bureau = pick(props, 'broadcast:bureau');
  const storyType = pick(props, 'broadcast:storyType');
  const editorialStatus = pick(props, 'broadcast:editorialStatus');
  const created = formatDate(task.created);
  const dueDate = formatDate(task.dueDate);
  const stepLabel = NODE_LABELS[task.nodeName ?? ''] ?? task.nodeName ?? '—';

  const buttons = task.taskInfo?.taskActions?.map((a) => a.name) ?? [];
  const canApprove = buttons.includes('approve');
  const canReject = buttons.includes('reject');
  const canSubmit = buttons.includes('submit_to_editorial');

  const busy = state.busy;
  const busyAny = Boolean(busy);

  return (
    <article className="review-row card">
      <Link
        to={`/asset/${encodeURIComponent(asset.uid)}`}
        className="asset-thumb review-thumb"
        aria-label={`Open ${asset.title}`}
      >
        <Thumbnail doc={asset} />
      </Link>

      <div className="review-row-main">
        <div className="review-row-headline">
          <Link to={`/asset/${encodeURIComponent(asset.uid)}`} className="asset-title">
            {asset.title || '(untitled asset)'}
          </Link>
          <div className="asset-card-badges">
            {editorialStatus ? <StatusBadge value={editorialStatus} compact /> : null}
            <span className="review-type-chip">{asset.type}</span>
          </div>
        </div>

        <dl className="asset-meta review-meta">
          <div><dt>Programme</dt><dd>{programme ?? '—'}</dd></div>
          <div><dt>Bureau</dt><dd>{bureau ?? '—'}</dd></div>
          <div><dt>Story</dt><dd>{storyType ?? '—'}</dd></div>
          <div><dt>Task created</dt><dd>{created}</dd></div>
          <div><dt>Due</dt><dd>{dueDate}</dd></div>
        </dl>

        <p className="review-task-note">
          Assigned step <span className="mono">{stepLabel}</span>
          {task.directive ? ` — ${task.directive}` : ''}
        </p>

        {state.result ? <RowResultBanner result={state.result} onDismiss={onDismissResult} /> : null}
      </div>

      <div className="review-row-actions">
        <Link to={`/asset/${encodeURIComponent(asset.uid)}`} className="btn btn-quiet btn-sm">
          <ExternalLink aria-hidden="true" /> Open detail
        </Link>
        {canSubmit && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onSubmit} disabled={busyAny}>
            {busy === 'submit_to_editorial' ? <Loader2 className="spin" aria-hidden="true" /> : null}
            Submit to Editorial
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onApprove}
          disabled={busyAny || !canApprove}
          title={!canApprove ? 'This task does not offer Approve' : undefined}
        >
          {busy === 'approve' ? <Loader2 className="spin" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
          Approve
        </button>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          onClick={onReject}
          disabled={busyAny || !canReject}
          title={!canReject ? 'This task does not offer Reject' : undefined}
        >
          {busy === 'reject' ? <Loader2 className="spin" aria-hidden="true" /> : <XCircle aria-hidden="true" />}
          Reject
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onSendBackToDraft}
          disabled={busyAny}
          title="Cancel the workflow and set status back to draft"
        >
          {busy === 'draft' ? <Loader2 className="spin" aria-hidden="true" /> : <Undo2 aria-hidden="true" />}
          Send back to draft
        </button>
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
  const Icon = result.kind === 'success' ? CheckCircle2 : result.kind === 'denied' ? ShieldAlert : XCircle;
  return (
    <div className={`review-result review-result-${result.kind}`} role={result.kind === 'success' ? 'status' : 'alert'}>
      <Icon aria-hidden="true" />
      <span>{result.message}</span>
      <button type="button" className="btn btn-quiet btn-sm review-result-dismiss" onClick={onDismiss} aria-label="Dismiss">
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reject dialog
// ---------------------------------------------------------------------------

function RejectDialog({
  entry,
  onCancel,
  onConfirm,
}: {
  entry: ReviewQueueEntry;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const title = entry.asset?.title || '(untitled asset)';

  return (
    <div className="modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className="modal-panel card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reject-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="reject-dialog-title" className="section-title">Reject asset</h2>
          <button type="button" className="btn btn-quiet btn-icon" onClick={onCancel} aria-label="Close">
            <X aria-hidden="true" />
          </button>
        </div>
        <p className="modal-body-text">
          Rejecting <strong>{title}</strong> requires a reason. It is
          recorded as a comment on the workflow task and visible to the
          submitter.
        </p>
        <label className="field field-wide">
          <span className="field-label">Reason *</span>
          <textarea
            className="input textarea"
            rows={4}
            required
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            placeholder="e.g. Audio levels too low; re-mix and resubmit."
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!trimmed}
            onClick={() => onConfirm(trimmed)}
          >
            <RotateCcw aria-hidden="true" /> Reject with reason
          </button>
        </div>
      </div>
    </div>
  );
}
