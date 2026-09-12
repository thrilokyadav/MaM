import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  ChevronLeft,
  Pencil,
  Send,
  ThumbsUp,
  ThumbsDown,
  Archive as ArchiveIcon,
  Lock,
  Download,
  Loader2,
  Save,
  X as XIcon,
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
  RotateCcw,
  X,
} from 'lucide-react';
import { fetchAsset } from '../api/searchApi';
import { updateAsset, startWorkflow } from '../api/actionsApi';
import { getCurrentUser } from '../api/meApi';
import { approveTask, rejectTask, submitToEditorial, findMyTaskForDocument } from '../api/reviewApi';
import type { ReviewQueueEntry } from '../api/reviewApi';
import { archiveAsset, restoreAsset, pollUntilRestored } from '../api/archiveApi';
import { NuxeoApiError } from '../api/nuxeoClient';
import { downloadBlobUrl } from '../api/mediaApi';
import type { BroadcastProperties, DublinCoreProperties, MamDocument } from '../types/mam';
import { StatusBadge } from '../components/StatusBadge';
import { Thumbnail } from '../components/Thumbnail';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { VideoPlayer } from '../components/VideoPlayer';
import './pages.css';
import './AssetDetailPage.css';

interface FieldDef { key: string; label: string; }

const EDITORIAL_FIELDS: FieldDef[] = [
  { key: 'broadcast:slug',            label: 'Slug' },
  { key: 'broadcast:storyType',       label: 'Story type' },
  { key: 'broadcast:editorialStatus', label: 'Editorial status (read-only — see actions above)' },
];
const BROADCAST_FIELDS: FieldDef[] = [
  { key: 'broadcast:programme',       label: 'Programme' },
  { key: 'broadcast:episode',         label: 'Episode' },
  { key: 'broadcast:bureau',          label: 'Bureau' },
  { key: 'broadcast:airDate',         label: 'Air date' },
  { key: 'broadcast:embargoUntil',    label: 'Embargo until' },
];
const RIGHTS_FIELDS: FieldDef[] = [
  { key: 'broadcast:rightsHolder',    label: 'Rights holder' },
  { key: 'broadcast:rightsTerritory', label: 'Rights territory' },
  { key: 'broadcast:rightsStart',     label: 'Rights start' },
  { key: 'broadcast:rightsEnd',       label: 'Rights end' },
];
const PROCESSING_FIELDS: FieldDef[] = [
  { key: 'broadcast:archiveState',    label: 'Archive state' },
  { key: 'broadcast:archiveDate',     label: 'Archived date' },
  { key: 'broadcast:archivedBy',      label: 'Archived by' },
  { key: 'broadcast:restoreDate',     label: 'Restored date' },
  { key: 'broadcast:restoredBy',      label: 'Restored by' },
];

const STORY_TYPES: string[] = [
  'package',
  'vosot',
  'raw',
  'interview',
  'live',
  'graphics',
  'script',
];

/**
 * `broadcast:editorialStatus` is deliberately NOT part of the editable
 * metadata form below. It has no server-side guard (unlike
 * `broadcast:archiveState`, which `ArchiveStateGuardListener` protects) —
 * confirmed directly against the backend: a plain `Write`-permission PUT
 * can set it to any value, including `approved`, completely bypassing the
 * `MAM_EDITORIAL_APPROVAL` workflow (Submit → QC → Editorial Approval).
 * Exposing it as a free-text/dropdown field in this form let a Producer
 * "approve their own asset" by picking a value from a menu, which defeats
 * the entire point of having a separate editorial review step. The only
 * supported way to change it is through the real workflow actions
 * (Submit for review / Approve / Reject / Send back to draft — see
 * `deriveActions` below and `reviewApi.ts`), each of which is itself
 * gated by a real permission (`MAM_SubmitForReview`, `MAM_Approve`, etc.).
 * The value is still shown, read-only, in the Editorial section's detail
 * grid so it's always visible.
 */

/** Metadata fields the edit form exposes, matching `updateAsset`'s properties header (`broadcast,dublincore`). */
interface EditFormState {
  title: string;
  description: string;
  slug: string;
  programme: string;
  episode: string;
  bureau: string;
  storyType: string;
  airDate: string;
  embargoUntil: string;
  rightsHolder: string;
  rightsTerritory: string;
  rightsStart: string;
  rightsEnd: string;
}

/** ISO datetime -> `yyyy-MM-dd` for `<input type="date">`; passthrough otherwise. */
function toDateInputValue(v: unknown): string {
  if (typeof v !== 'string' || !v) return '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return m?.[1] ?? '';
}

function buildEditForm(props: Record<string, unknown>, title: string): EditFormState {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    title,
    description: str(props['dc:description']),
    slug: str(props['broadcast:slug']),
    programme: str(props['broadcast:programme']),
    episode: str(props['broadcast:episode']),
    bureau: str(props['broadcast:bureau']),
    storyType: str(props['broadcast:storyType']),
    airDate: toDateInputValue(props['broadcast:airDate']),
    embargoUntil: toDateInputValue(props['broadcast:embargoUntil']),
    rightsHolder: str(props['broadcast:rightsHolder']),
    rightsTerritory: str(props['broadcast:rightsTerritory']),
    rightsStart: toDateInputValue(props['broadcast:rightsStart']),
    rightsEnd: toDateInputValue(props['broadcast:rightsEnd']),
  };
}

/** Builds the PUT payload, omitting fields the form left blank so we don't clobber unrelated data. */
function toUpdatePayload(form: EditFormState): Record<string, unknown> {
  const dc: DublinCoreProperties = { 'dc:title': form.title };
  if (form.description) dc['dc:description'] = form.description;

  const broadcast: BroadcastProperties = {};
  if (form.slug) broadcast['broadcast:slug'] = form.slug;
  if (form.programme) broadcast['broadcast:programme'] = form.programme;
  if (form.episode) broadcast['broadcast:episode'] = form.episode;
  if (form.bureau) broadcast['broadcast:bureau'] = form.bureau;
  if (form.storyType) broadcast['broadcast:storyType'] = form.storyType;
  if (form.airDate) broadcast['broadcast:airDate'] = form.airDate;
  if (form.embargoUntil) broadcast['broadcast:embargoUntil'] = form.embargoUntil;
  if (form.rightsHolder) broadcast['broadcast:rightsHolder'] = form.rightsHolder;
  if (form.rightsTerritory) broadcast['broadcast:rightsTerritory'] = form.rightsTerritory;
  if (form.rightsStart) broadcast['broadcast:rightsStart'] = form.rightsStart;
  if (form.rightsEnd) broadcast['broadcast:rightsEnd'] = form.rightsEnd;
  // broadcast:editorialStatus is intentionally never included here — see
  // the comment above EditFormState.

  return { ...dc, ...broadcast };
}

type SavePhase =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string };

function stringValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

interface ActionState {
  label: string;
  reason?: string;
  enabled: boolean;
  danger?: boolean;
  primary?: boolean;
  Icon: LucideIcon;
}

/**
 * Derive available actions from the current editorial status. This is the UI's
 * best-effort mirror of the server-side permission contract; the backend
 * remains the source of truth and will reject unauthorised actions.
 */
function deriveActions(
  status: string | undefined,
  archiveState: string | undefined,
  permissions: string[],
  hasOpenTask: boolean | undefined,
): ActionState[] {
  const can = (name: string) => permissions.includes(name) || permissions.includes('Everything');
  const isDraft = status === 'draft' || !status;
  const isQC = status === 'qc';
  // "Reviewable" here means "has an open workflow task a reviewer could
  // act on" — approve/reject/submit-to-editorial all complete a task, so
  // they should only be offered once we know a task actually exists.
  // `hasOpenTask === undefined` means that lookup hasn't resolved yet;
  // treat it as not-yet-actionable rather than guessing.
  const isReviewable = isQC && hasOpenTask === true;
  const isCold = archiveState === 'cold' || archiveState === 'restore-pending';
  const isRestorePending = archiveState === 'restore-pending';

  const archiveAction: ActionState = isCold
    ? {
        label: isRestorePending ? 'Restoring…' : 'Restore',
        Icon: isRestorePending ? Loader2 : RotateCcw,
        enabled: !isRestorePending && (can('MAM_Archive') || can('Write')),
        reason: isRestorePending
          ? 'Restore in progress — background worker is copying blob back to hot storage.'
          : 'Requires MAM_Archive (mam-archivists) or Write on this asset.',
      }
    : {
        label: 'Archive',
        Icon: ArchiveIcon,
        enabled: (can('MAM_Archive') || can('Write')) && status === 'approved',
        reason:
          status !== 'approved'
            ? 'Only approved assets can be archived.'
            : 'Requires MAM_Archive (mam-archivists) or Write on this asset.',
      };

  return [
    {
      label: 'Edit metadata',
      Icon: Pencil,
      enabled: can('WriteProperties') || can('MAM_EditMetadata'),
      reason: 'Requires WriteProperties on this asset.',
    },
    {
      label: 'Submit for review',
      Icon: Send,
      primary: isDraft,
      enabled: isDraft && can('MAM_SubmitForReview'),
      reason: !isDraft
        ? 'Already in review or completed.'
        : 'Requires MAM_SubmitForReview.',
    },
    {
      label: 'Submit to Editorial',
      Icon: Send,
      enabled: isReviewable && can('MAM_SubmitForReview'),
      reason: !isReviewable
        ? 'Only available while an open QC task is assigned to you.'
        : 'Requires MAM_SubmitForReview.',
    },
    {
      label: 'Approve',
      Icon: ThumbsUp,
      enabled: isReviewable && can('MAM_Approve'),
      reason: !isReviewable
        ? 'Only available while an open review task is assigned to you.'
        : 'Requires MAM_Approve.',
    },
    {
      label: 'Reject',
      Icon: ThumbsDown,
      danger: true,
      enabled: isReviewable && can('MAM_Reject'),
      reason: !isReviewable
        ? 'Only available while an open review task is assigned to you.'
        : 'Requires MAM_Reject.',
    },
    archiveAction,
  ];
}

export function AssetDetailPage() {
  const { uid = '' } = useParams<{ uid: string }>();
  const [asset, setAsset] = useState<MamDocument | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<EditFormState | null>(null);
  const [savePhase, setSavePhase] = useState<SavePhase>({ kind: 'idle' });

  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Workflow/archive action state: which action is in flight, the result
  // banner shown after it completes, and the pending reject-reason dialog.
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<
    { kind: 'success' | 'denied' | 'error'; message: string } | null
  >(null);
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  // Whether the signed-in principal currently has an open workflow task
  // on this asset. `undefined` = not checked yet. Drives whether
  // Approve/Reject/Submit-to-Editorial are offered at all — see
  // `deriveActions`.
  const [hasOpenTask, setHasOpenTask] = useState<boolean | undefined>(undefined);

  const reload = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    setError(null);
    try {
      const doc = await fetchAsset(uid);
      setAsset(doc);
    } catch (e) {
      const msg = e instanceof NuxeoApiError ? e.message : (e as Error).message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [uid]);

  function describeActionError(e: unknown): { kind: 'denied' | 'error'; message: string } {
    if (e instanceof NuxeoApiError) {
      if (e.status === 403) {
        return { kind: 'denied', message: e.message || 'You do not have permission to perform this action.' };
      }
      return { kind: 'error', message: e.message || `Request failed (HTTP ${e.status || 'network error'}).` };
    }
    return { kind: 'error', message: e instanceof Error ? e.message : 'Unknown error.' };
  }

  async function runAssetAction(kind: string, fn: () => Promise<void>, successMessage: string) {
    setActionBusy(kind);
    setActionResult(null);
    try {
      await fn();
      setActionResult({ kind: 'success', message: successMessage });
      await new Promise((r) => setTimeout(r, 900));
      await reload({ silent: true });
    } catch (e) {
      setActionResult(describeActionError(e));
    } finally {
      setActionBusy(null);
    }
  }

  /**
   * Approve/Reject/Submit-to-Editorial act on the caller's open workflow
   * *task* for this document, not on the document directly — there is no
   * server endpoint to "approve a document"; the workflow engine only
   * exposes `PUT /task/{id}/{action}` on a task instance (see
   * `reviewApi.ts`, and the Review Queue page which already worked this
   * way). This looks up that task on demand rather than requiring the
   * caller to already have it, since a user arriving at an asset's detail
   * page via search/link — not via the queue — otherwise has no way to
   * discover it.
   */
  async function withMyTask(action: string, run: (entry: ReviewQueueEntry) => Promise<void>) {
    const me = await getCurrentUser();
    const task = await findMyTaskForDocument(me.id, uid);
    if (!task) {
      throw new NuxeoApiError(
        `No open review task assigned to you was found for this asset. It may already be reviewed, or assigned to a different reviewer/step.`,
        409,
      );
    }
    const entry: ReviewQueueEntry = { task, asset };
    await run(entry);
    void action; // kept for call-site readability; not otherwise used
  }

  function onSubmitForReview() {
    void runAssetAction(
      'submit',
      async () => {
        await startWorkflow(uid, 'MAM_EDITORIAL_APPROVAL');
      },
      'Submitted for review.',
    );
  }

  function onApprove() {
    void runAssetAction(
      'approve',
      () => withMyTask('approve', (entry) => approveTask(entry)),
      'Approved.',
    );
  }

  function onSubmitToEditorial() {
    void runAssetAction(
      'submit_to_editorial',
      () => withMyTask('submit_to_editorial', (entry) => submitToEditorial(entry)),
      'Submitted to Editorial Approval.',
    );
  }

  function onRejectConfirm(reason: string) {
    setShowRejectDialog(false);
    void runAssetAction(
      'reject',
      () => withMyTask('reject', (entry) => rejectTask(entry, reason)),
      'Rejected.',
    );
  }

  function onArchive() {
    void runAssetAction('archive', async () => { await archiveAsset(uid); }, 'Archived to cold storage.');
  }

  function onRestore() {
    setActionBusy('restore');
    setActionResult(null);
    void (async () => {
      try {
        await restoreAsset(uid);
        setActionResult({ kind: 'success', message: 'Restore initiated. Restoring blob from cold storage…' });
        await reload({ silent: true });
        await pollUntilRestored(uid, undefined, 3000);
        setActionResult({ kind: 'success', message: 'Restored to hot storage.' });
        await new Promise((r) => setTimeout(r, 900));
        await reload({ silent: true });
      } catch (e) {
        setActionResult(describeActionError(e));
      } finally {
        setActionBusy(null);
      }
    })();
  }

  useEffect(() => {
    if (!asset || asset.properties?.['broadcast:editorialStatus'] !== 'qc') {
      setHasOpenTask(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const me = await getCurrentUser();
        const task = await findMyTaskForDocument(me.id, uid);
        if (!cancelled) setHasOpenTask(Boolean(task));
      } catch {
        if (!cancelled) setHasOpenTask(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [asset, uid]);

  useEffect(() => {
    const ac = new AbortController();
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const doc = await fetchAsset(uid, ac.signal);
        setAsset(doc);
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
  }, [uid]);

  // Auto-refresh while Nuxeo's video pipeline (FFmpeg transcode + poster
  // frame + storyboard) is still running in the background. Without this,
  // a BroadcastVideo that finished uploading but hasn't finished
  // processing shows "Processing" forever until the user manually
  // reloads — and, worse, a thumbnail rendition request made while the
  // poster frame file doesn't exist yet throws a real 500 on Nuxeo's
  // side (ThumbnailVideoFactory's NullPointerException: null file). This
  // stops polling as soon as a transcoded proxy shows up, or after a
  // generous timeout, so it never polls forever on a genuinely stuck job.
  useEffect(() => {
    if (!asset || asset.type !== 'BroadcastVideo') return;
    const hasProxy = Array.isArray(asset.properties?.['vid:transcodedVideos'])
      && (asset.properties!['vid:transcodedVideos'] as unknown[]).length > 0;
    if (hasProxy) return;

    const ac = new AbortController();
    let attempts = 0;
    const maxAttempts = 24; // ~4 minutes at 10s intervals
    const interval = window.setInterval(() => {
      attempts += 1;
      if (attempts > maxAttempts) {
        window.clearInterval(interval);
        return;
      }
      fetchAsset(uid, ac.signal)
        .then((doc) => {
          const ready = Array.isArray(doc.properties?.['vid:transcodedVideos'])
            && (doc.properties!['vid:transcodedVideos'] as unknown[]).length > 0;
          setAsset(doc);
          if (ready) window.clearInterval(interval);
        })
        .catch(() => {
          /* transient poll failure — try again on the next tick */
        });
    }, 10_000);

    return () => {
      window.clearInterval(interval);
      ac.abort();
    };
  }, [uid, asset?.type, asset?.properties?.['vid:transcodedVideos']]);

  // Auto-refresh while restore from cold storage is in progress.
  useEffect(() => {
    if (!asset || asset.properties?.['broadcast:archiveState'] !== 'restore-pending') return;

    const ac = new AbortController();
    pollUntilRestored(uid, undefined, 3000, ac.signal)
      .then(() => {
        void reload({ silent: true });
      })
      .catch(() => {
        /* aborted or transient error */
      });

    return () => {
      ac.abort();
    };
  }, [uid, asset?.properties?.['broadcast:archiveState'], reload]);

  if (loading) return <LoadingState rows={3} label="Loading asset" />;
  if (error) {
    return (
      <ErrorState
        message={error}
        action={<Link to="/assets" className="btn btn-secondary btn-sm">Back to assets</Link>}
      />
    );
  }
  if (!asset) return null;

  const props = asset.properties ?? {};
  const editorialStatus = typeof props['broadcast:editorialStatus'] === 'string'
    ? (props['broadcast:editorialStatus'] as string)
    : undefined;
  const archiveState = typeof props['broadcast:archiveState'] === 'string'
    ? (props['broadcast:archiveState'] as string)
    : undefined;
  const permissions = Array.isArray(asset.contextParameters?.['permissions'])
    ? (asset.contextParameters?.['permissions'] as string[])
    : [];
  const actions = deriveActions(editorialStatus, archiveState, permissions, hasOpenTask);
  const editAction = actions.find((a) => a.label === 'Edit metadata');

  const actionHandlers: Record<string, () => void> = {
    'Edit metadata': onStartEdit,
    'Submit for review': onSubmitForReview,
    'Submit to Editorial': onSubmitToEditorial,
    Approve: onApprove,
    Reject: () => setShowRejectDialog(true),
    Archive: onArchive,
    Restore: onRestore,
    'Restoring…': () => {},
  };
  const actionBusyKeys: Record<string, string> = {
    'Submit for review': 'submit',
    'Submit to Editorial': 'submit_to_editorial',
    Approve: 'approve',
    Reject: 'reject',
    Archive: 'archive',
    Restore: 'restore',
    'Restoring…': 'restore',
  };
  const anyActionBusy = actionBusy !== null;

  const fileContent = props['file:content'];
  const originalUrl = typeof fileContent === 'object' && fileContent
    ? (fileContent as { data?: string }).data
    : undefined;
  const originalName = typeof fileContent === 'object' && fileContent
    ? (fileContent as { name?: string }).name
    : undefined;

  function onStartEdit() {
    setEditForm(buildEditForm(props, asset!.title));
    setSavePhase({ kind: 'idle' });
    setEditing(true);
  }

  function onCancelEdit() {
    setEditing(false);
    setEditForm(null);
    setSavePhase({ kind: 'idle' });
  }

  function updateField<K extends keyof EditFormState>(key: K, value: EditFormState[K]) {
    setEditForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function onSaveEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editForm) return;
    setSavePhase({ kind: 'saving' });
    try {
      const updated = await updateAsset(uid, toUpdatePayload(editForm));
      // The PUT response only carries broadcast+dublincore (see
      // updateAsset's `properties` header) — merge onto the existing
      // properties bag rather than replacing it wholesale, so video/file
      // metadata already loaded (proxy renditions, original blob) survive.
      setAsset((prev) =>
        prev
          ? { ...prev, title: updated.title ?? prev.title, properties: { ...prev.properties, ...updated.properties } }
          : prev,
      );
      setEditing(false);
      setEditForm(null);
      setSavePhase({ kind: 'idle' });
    } catch (err) {
      const message = err instanceof NuxeoApiError ? err.message : (err as Error).message;
      setSavePhase({ kind: 'error', message });
    }
  }

  async function onDownloadOriginal() {
    if (!originalUrl) return;
    setDownloadError(null);
    setDownloading(true);
    try {
      await downloadBlobUrl(originalUrl, originalName || asset!.title || 'download');
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="page stack-6">
      <Link to="/assets" className="btn btn-quiet btn-sm detail-back">
        <ChevronLeft aria-hidden="true" /> Back to assets
      </Link>

      <header className="detail-header card">
        <div className="detail-media">
          <Thumbnail doc={asset} size="large" />
        </div>
        <div className="detail-header-body">
          <div className="detail-headline">
            <h1 className="detail-title">{asset.title || '(untitled asset)'}</h1>
            <div className="detail-badges">
              {editorialStatus ? <StatusBadge value={editorialStatus} /> : null}
              {archiveState ? <StatusBadge value={archiveState} kindHint="archive" /> : null}
            </div>
          </div>
          <p className="detail-subline">
            <span className="detail-type-chip">{asset.type}</span>
            <span className="detail-uid mono">{asset.uid}</span>
          </p>
          <div className="detail-actions" role="group" aria-label="Asset actions">
            {editing ? null : (
              <>
                {actions.map((a) => {
                  const busyKey = actionBusyKeys[a.label];
                  const isBusy = busyKey !== undefined && actionBusy === busyKey;
                  const isDisabledByOtherBusy = a.label !== 'Edit metadata' && anyActionBusy && !isBusy;
                  return (
                    <button
                      key={a.label}
                      type="button"
                      className={`btn ${a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : 'btn-secondary'}`}
                      disabled={!a.enabled || isDisabledByOtherBusy}
                      title={a.enabled ? a.label : a.reason}
                      onClick={actionHandlers[a.label]}
                    >
                      {isBusy ? <Loader2 className="spin" aria-hidden /> : <a.Icon aria-hidden />}
                      {a.label}
                      {!a.enabled ? <Lock aria-hidden style={{ width: 12, height: 12, opacity: 0.6 }} /> : null}
                    </button>
                  );
                })}
                {originalUrl ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void onDownloadOriginal()}
                    disabled={downloading || archiveState === 'cold' || archiveState === 'restore-pending'}
                    title={
                      archiveState === 'cold'
                        ? 'Asset is in cold storage (HP ProLiant Storage Server). Restore to hot storage to download original media.'
                        : archiveState === 'restore-pending'
                          ? 'Restore in progress — high-res media is currently in cold storage.'
                          : undefined
                    }
                  >
                    {downloading ? <Loader2 className="spin" aria-hidden /> : <Download aria-hidden />}
                    {downloading ? 'Downloading…' : 'Download original'}
                  </button>
                ) : null}
              </>
            )}
          </div>
          {downloadError ? (
            <p className="detail-note detail-note-error" role="alert">
              <AlertTriangle aria-hidden style={{ width: 14, height: 14 }} /> {downloadError}
            </p>
          ) : null}
          {actionResult ? (
            <DetailActionBanner result={actionResult} onDismiss={() => setActionResult(null)} />
          ) : null}
        </div>
      </header>

      {showRejectDialog ? (
        <DetailRejectDialog
          onCancel={() => setShowRejectDialog(false)}
          onConfirm={onRejectConfirm}
        />
      ) : null}

      {archiveState === 'cold' ? (
        <div className="card card-body detail-cold-banner" role="status">
          <ArchiveIcon className="detail-cold-icon" aria-hidden="true" />
          <div className="detail-cold-text">
            <h3 className="detail-cold-title">Asset is in Cold Storage</h3>
            <p className="detail-cold-desc">
              High-resolution media has been moved to cold storage (48 TB SAS tier). Metadata and proxy records are preserved.
              Click <strong>Restore</strong> in the actions toolbar to bring the asset back to hot storage for streaming and download.
            </p>
          </div>
        </div>
      ) : archiveState === 'restore-pending' || actionBusy === 'restore' ? (
        <div className="card card-body detail-restore-banner" role="status">
          <Loader2 className="detail-cold-icon spin" aria-hidden="true" />
          <div className="detail-cold-text">
            <h3 className="detail-cold-title">Restoring from Cold Storage</h3>
            <p className="detail-cold-desc">
              MamRestoreWork is currently streaming the binary blob from cold storage back to the hot SAS tier. This page will update automatically once restoration completes.
            </p>
          </div>
        </div>
      ) : null}

      {asset.type === 'BroadcastVideo' ? (
        <section className="card card-body detail-section">
          <h2 className="section-title">Playback</h2>
          <VideoPlayer doc={asset} />
        </section>
      ) : null}

      {editing && editForm ? (
        <EditMetadataForm
          form={editForm}
          savePhase={savePhase}
          onField={updateField}
          onSubmit={onSaveEdit}
          onCancel={onCancelEdit}
          editable={editAction?.enabled ?? true}
        />
      ) : (
        <>
          <section className="card card-body detail-section">
            <h2 className="section-title">Editorial</h2>
            <DetailGrid fields={EDITORIAL_FIELDS} props={props} />
          </section>

          <section className="card card-body detail-section">
            <h2 className="section-title">Broadcast</h2>
            <DetailGrid fields={BROADCAST_FIELDS} props={props} />
          </section>

          <section className="card card-body detail-section">
            <h2 className="section-title">Rights</h2>
            <DetailGrid fields={RIGHTS_FIELDS} props={props} />
          </section>

          <section className="card card-body detail-section">
            <h2 className="section-title">Processing</h2>
            <DetailGrid fields={PROCESSING_FIELDS} props={props} />
            <ProcessingHints props={props} />
          </section>

          <section className="card card-body detail-section">
            <h2 className="section-title">System</h2>
            <dl className="detail-grid">
              <div className="detail-row">
                <dt>Path</dt>
                <dd className="mono">{asset.path}</dd>
              </div>
              <div className="detail-row">
                <dt>Last modified</dt>
                <dd>{asset.lastModified ?? '—'}</dd>
              </div>
              <div className="detail-row">
                <dt>State</dt>
                <dd>{asset.state ?? '—'}</dd>
              </div>
            </dl>
          </section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metadata edit form
// ---------------------------------------------------------------------------

interface EditMetadataFormProps {
  form: EditFormState;
  savePhase: SavePhase;
  onField: <K extends keyof EditFormState>(key: K, value: EditFormState[K]) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  editable: boolean;
}

function EditMetadataForm({ form, savePhase, onField, onSubmit, onCancel, editable }: EditMetadataFormProps) {
  const saving = savePhase.kind === 'saving';
  const canSubmit = useMemo(() => editable && !saving && form.title.trim().length > 0, [editable, saving, form.title]);

  return (
    <form className="card card-body detail-section" onSubmit={onSubmit} noValidate>
      <div className="detail-edit-head">
        <h2 className="section-title">Edit metadata</h2>
        {!editable ? (
          <p className="detail-note detail-note-error">
            <Lock aria-hidden style={{ width: 14, height: 14 }} /> You do not have permission to save changes to this asset.
          </p>
        ) : null}
      </div>

      {savePhase.kind === 'error' ? (
        <p className="detail-note detail-note-error" role="alert">
          <AlertTriangle aria-hidden style={{ width: 14, height: 14 }} /> {savePhase.message}
        </p>
      ) : null}

      <fieldset className="edit-form-grid" disabled={saving || !editable}>
        <label className="field field-wide">
          <span className="field-label">Title *</span>
          <input
            className="input"
            type="text"
            required
            value={form.title}
            onChange={(e) => onField('title', e.currentTarget.value)}
          />
        </label>

        <label className="field field-wide">
          <span className="field-label">Description</span>
          <input
            className="input"
            type="text"
            value={form.description}
            onChange={(e) => onField('description', e.currentTarget.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Slug</span>
          <input className="input" type="text" value={form.slug} onChange={(e) => onField('slug', e.currentTarget.value)} />
        </label>

        <label className="field">
          <span className="field-label">Programme</span>
          <input className="input" type="text" value={form.programme} onChange={(e) => onField('programme', e.currentTarget.value)} />
        </label>

        <label className="field">
          <span className="field-label">Episode</span>
          <input className="input" type="text" value={form.episode} onChange={(e) => onField('episode', e.currentTarget.value)} />
        </label>

        <label className="field">
          <span className="field-label">Bureau</span>
          <input className="input" type="text" value={form.bureau} onChange={(e) => onField('bureau', e.currentTarget.value)} />
        </label>

        <label className="field">
          <span className="field-label">Story type</span>
          <select className="select" value={form.storyType} onChange={(e) => onField('storyType', e.currentTarget.value)}>
            <option value="">—</option>
            {STORY_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Air date</span>
          <input className="input" type="date" value={form.airDate} onChange={(e) => onField('airDate', e.currentTarget.value)} />
        </label>

        <label className="field">
          <span className="field-label">Embargo until</span>
          <input className="input" type="date" value={form.embargoUntil} onChange={(e) => onField('embargoUntil', e.currentTarget.value)} />
        </label>

        <label className="field">
          <span className="field-label">Rights holder</span>
          <input className="input" type="text" value={form.rightsHolder} onChange={(e) => onField('rightsHolder', e.currentTarget.value)} />
        </label>

        <label className="field">
          <span className="field-label">Rights territory</span>
          <input className="input" type="text" value={form.rightsTerritory} onChange={(e) => onField('rightsTerritory', e.currentTarget.value)} />
        </label>

        <label className="field">
          <span className="field-label">Rights start</span>
          <input className="input" type="date" value={form.rightsStart} onChange={(e) => onField('rightsStart', e.currentTarget.value)} />
        </label>

        <label className="field">
          <span className="field-label">Rights end</span>
          <input className="input" type="date" value={form.rightsEnd} onChange={(e) => onField('rightsEnd', e.currentTarget.value)} />
        </label>
      </fieldset>

      <div className="detail-edit-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>
          <XIcon aria-hidden /> Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
          {saving ? <Loader2 className="spin" aria-hidden /> : <Save aria-hidden />}
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

function DetailGrid({ fields, props }: { fields: FieldDef[]; props: Record<string, unknown> }) {
  return (
    <dl className="detail-grid">
      {fields.map((f) => (
        <div key={f.key} className="detail-row">
          <dt>{f.label}</dt>
          <dd>{stringValue(props[f.key])}</dd>
        </div>
      ))}
    </dl>
  );
}

function ProcessingHints({ props }: { props: Record<string, unknown> }) {
  // Nuxeo video: transcoded proxies, poster views, storyboard
  const transcoded = props['vid:transcodedVideos'];
  const pictureViews = props['picture:views'];
  const storyboard = props['vid:storyboard'];
  const has = (v: unknown) => Array.isArray(v) && v.length > 0;
  if (!has(transcoded) && !has(pictureViews) && !has(storyboard)) {
    return (
      <p className="detail-note">
        No proxy renditions, poster frames, or storyboard tiles are attached
        yet. For BroadcastVideo, these are produced by Nuxeo's stock video
        pipeline once ingest completes.
      </p>
    );
  }
  return (
    <ul className="processing-list">
      {has(transcoded) ? (
        <li>Transcoded proxies: {(transcoded as unknown[]).length}</li>
      ) : null}
      {has(pictureViews) ? (
        <li>Poster views: {(pictureViews as unknown[]).length}</li>
      ) : null}
      {has(storyboard) ? (
        <li>Storyboard tiles: {(storyboard as unknown[]).length}</li>
      ) : null}
    </ul>
  );
}
// ---------------------------------------------------------------------------
// Workflow/archive action feedback
// ---------------------------------------------------------------------------

function DetailActionBanner({
  result,
  onDismiss,
}: {
  result: { kind: 'success' | 'denied' | 'error'; message: string };
  onDismiss: () => void;
}) {
  const Icon = result.kind === 'success' ? CheckCircle2 : result.kind === 'denied' ? ShieldAlert : AlertTriangle;
  return (
    <div
      className={`detail-note ${result.kind === 'success' ? '' : 'detail-note-error'}`}
      role={result.kind === 'success' ? 'status' : 'alert'}
      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
    >
      <Icon aria-hidden style={{ width: 14, height: 14, flexShrink: 0 }} />
      <span style={{ flex: 1 }}>{result.message}</span>
      <button type="button" className="btn btn-quiet btn-sm" onClick={onDismiss} aria-label="Dismiss">
        <X aria-hidden style={{ width: 14, height: 14 }} />
      </button>
    </div>
  );
}

function DetailRejectDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();

  return (
    <div className="modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className="modal-panel card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-reject-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="detail-reject-title" className="section-title">Reject asset</h2>
          <button type="button" className="btn btn-quiet btn-icon" onClick={onCancel} aria-label="Close">
            <X aria-hidden="true" />
          </button>
        </div>
        <p className="modal-body-text">
          Rejecting this asset requires a reason. It is recorded as a
          comment on the workflow task and visible to the submitter.
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
            <ThumbsDown aria-hidden="true" /> Reject with reason
          </button>
        </div>
      </div>
    </div>
  );
}
