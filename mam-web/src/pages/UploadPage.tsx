import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  FileVideo,
  FolderOpen,
  Loader2,
  RotateCw,
  UploadCloud,
  X,
} from 'lucide-react';
import { NuxeoApiError } from '../api/nuxeoClient';
import {
  cancelBatch,
  createAssetFromBatch,
  initBatch,
  isProbablyVideo,
  uploadFileToBatch,
  type BroadcastAssetType,
  type UploadHandle,
} from '../api/uploadApi';
import type {
  BroadcastProperties,
  DublinCoreProperties,
} from '../types/mam';
import './pages.css';
import './UploadPage.css';

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

/**
 * `broadcast:editorialStatus` is deliberately NOT a field on this form.
 * It has no server-side guard the way `broadcast:archiveState` does
 * (confirmed directly against the backend), so letting an uploader pick
 * it from a dropdown at creation time would let a Producer create an
 * asset that's already "approved" or "qc", skipping the entire
 * `MAM_EDITORIAL_APPROVAL` workflow before a single reviewer has seen it.
 * Every newly created asset is left with no editorial status at all —
 * the workflow's own `NodeDraft` chain stamps it to `draft` the moment
 * "Submit for review" is used, which is the only supported way to move
 * it forward. See the equivalent comment in `AssetDetailPage.tsx`.
 */
interface FormState {
  title: string;
  slug: string;
  programme: string;
  episode: string;
  bureau: string;
  storyType: string;
  airDate: string;
  assetType: BroadcastAssetType;
  /** True while the user hasn't manually overridden the type suggestion. */
  assetTypeAuto: boolean;
}

const EMPTY_FORM: FormState = {
  title: '',
  slug: '',
  programme: '',
  episode: '',
  bureau: '',
  storyType: '',
  airDate: '',
  assetType: 'BroadcastAsset',
  assetTypeAuto: true,
};

const STORY_TYPES: string[] = [
  'package',
  'vosot',
  'raw',
  'interview',
  'live',
  'graphics',
  'script',
];

// ---------------------------------------------------------------------------
// Upload state machine (kept small on purpose)
// ---------------------------------------------------------------------------

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; fraction: number; loaded: number; total: number }
  | { kind: 'creating' }
  | { kind: 'error'; message: string; status?: number }
  | { kind: 'success'; uid: string; path: string; type: string };

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function UploadPage() {
  const navigate = useNavigate();

  const [file, setFile] = useState<File | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [dragHover, setDragHover] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const handleRef = useRef<UploadHandle | null>(null);
  const batchIdRef = useRef<string | null>(null);

  // Auto-select BroadcastVideo for video files unless the user has
  // explicitly picked something else.
  useEffect(() => {
    if (!file) return;
    setForm((prev) => {
      if (!prev.assetTypeAuto) return prev;
      const wantVideo = isProbablyVideo(file);
      const next: BroadcastAssetType = wantVideo ? 'BroadcastVideo' : 'BroadcastAsset';
      if (prev.assetType === next) return prev;
      return { ...prev, assetType: next };
    });
  }, [file]);

  // Best-effort batch cleanup if the user navigates away mid-upload.
  useEffect(() => {
    return () => {
      handleRef.current?.cancel();
      if (batchIdRef.current) void cancelBatch(batchIdRef.current);
    };
  }, []);

  const busy = phase.kind === 'uploading' || phase.kind === 'creating';

  const onPickFiles = useCallback((files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const chosen = Array.from(files)[0];
    if (!chosen) return;
    setFile(chosen);
    // Seed the title with the file name (without extension) if empty.
    setForm((prev) =>
      prev.title
        ? prev
        : { ...prev, title: chosen.name.replace(/\.[^.]+$/, '') },
    );
    // If we were showing a completed result, clear it so the next attempt starts fresh.
    setPhase({ kind: 'idle' });
  }, []);

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (busy) return;
    setDragHover(true);
  }
  function onDragLeave() { setDragHover(false); }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragHover(false);
    if (busy) return;
    onPickFiles(e.dataTransfer.files);
  }

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function onAssetTypeChange(e: ChangeEvent<HTMLSelectElement>) {
    const v = e.currentTarget.value as BroadcastAssetType;
    setForm((prev) => ({ ...prev, assetType: v, assetTypeAuto: false }));
  }

  async function runUpload() {
    if (!file) return;

    setPhase({ kind: 'uploading', fraction: 0, loaded: 0, total: file.size });

    let batchId: string;
    try {
      batchId = await initBatch();
      batchIdRef.current = batchId;
    } catch (err) {
      setPhase(errorPhase(err, 'Batch init failed'));
      return;
    }

    const handle = uploadFileToBatch(batchId, 0, file, (p) => {
      setPhase({
        kind: 'uploading',
        fraction: p.fraction,
        loaded: p.loaded,
        total: p.total || file.size,
      });
    });
    handleRef.current = handle;

    try {
      await handle.done;
    } catch (err) {
      // If we aborted deliberately, keep the batch id around so the caller
      // sees an accurate error, but still clean up server state.
      if (batchIdRef.current) {
        void cancelBatch(batchIdRef.current);
        batchIdRef.current = null;
      }
      setPhase(errorPhase(err, 'Upload failed'));
      handleRef.current = null;
      return;
    }
    handleRef.current = null;

    setPhase({ kind: 'creating' });

    const dublinCore: DublinCoreProperties = {
      'dc:title': form.title || file.name,
    };
    const broadcast: BroadcastProperties = compactBroadcast(form);

    try {
      const doc = await createAssetFromBatch({
        type: form.assetType,
        batchId,
        dublinCore,
        broadcast,
      });
      batchIdRef.current = null;
      setPhase({ kind: 'success', uid: doc.uid, path: doc.path, type: doc.type });
    } catch (err) {
      // Doc creation failed. The batch is still on the server; drop it.
      if (batchIdRef.current) {
        void cancelBatch(batchIdRef.current);
        batchIdRef.current = null;
      }
      setPhase(errorPhase(err, 'Document creation failed'));
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file || busy) return;
    void runUpload();
  }

  function onCancel() {
    handleRef.current?.cancel();
    if (batchIdRef.current) void cancelBatch(batchIdRef.current);
    batchIdRef.current = null;
    handleRef.current = null;
    setPhase({ kind: 'error', message: 'Upload cancelled by user.' });
  }

  function onRetry() {
    if (!file) return;
    setPhase({ kind: 'idle' });
    void runUpload();
  }

  function onReset() {
    handleRef.current?.cancel();
    if (batchIdRef.current) void cancelBatch(batchIdRef.current);
    batchIdRef.current = null;
    handleRef.current = null;
    setFile(null);
    setForm(EMPTY_FORM);
    setPhase({ kind: 'idle' });
  }

  const canSubmit = useMemo(() => {
    if (!file || busy) return false;
    // Require at least a title so the record isn't nameless in the archive.
    return form.title.trim().length > 0;
  }, [file, busy, form.title]);

  return (
    <div className="page stack-6">
      <header className="page-header">
        <div>
          <h1 className="page-title">Upload media</h1>
          <p className="page-subtitle">
            Ingest a video, audio, image, or script into the broadcast library.
            Video files are stored as <code>BroadcastVideo</code> so Nuxeo's
            video pipeline generates transcoded proxies, a poster, and a
            storyboard. Everything else becomes a <code>BroadcastAsset</code>.
          </p>
        </div>
      </header>

      {phase.kind === 'success' ? (
        <SuccessCard
          phase={phase}
          onOpenAsset={() => navigate(`/asset/${phase.uid}`)}
          onUploadAnother={onReset}
        />
      ) : (
        <form className="stack-6" onSubmit={onSubmit} noValidate>
          <DropZone
            file={file}
            dragHover={dragHover}
            disabled={busy}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onPick={onPickFiles}
            onClear={() => setFile(null)}
          />

          {phase.kind === 'uploading' || phase.kind === 'creating' ? (
            <ProgressCard phase={phase} file={file} onCancel={onCancel} />
          ) : null}

          {phase.kind === 'error' ? (
            <ErrorCard phase={phase} onRetry={onRetry} />
          ) : null}

          <MetadataFieldset
            form={form}
            onField={updateField}
            onAssetTypeChange={onAssetTypeChange}
            disabled={busy}
          />

          <div className="upload-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onReset}
              disabled={busy}
            >
              Reset
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-lg"
              disabled={!canSubmit}
            >
              <UploadCloud aria-hidden="true" />
              {phase.kind === 'error' ? 'Retry upload' : 'Upload asset'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface DropZoneProps {
  file: File | null;
  dragHover: boolean;
  disabled: boolean;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onPick: (files: FileList | File[] | null) => void;
  onClear: () => void;
}

function DropZone(props: DropZoneProps) {
  const { file, dragHover, disabled, onDragOver, onDragLeave, onDrop, onPick, onClear } = props;
  return (
    <div
      className={`upload-zone card${dragHover ? ' upload-zone-hover' : ''}${
        disabled ? ' upload-zone-disabled' : ''
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      role="region"
      aria-label="File drop zone"
      aria-disabled={disabled}
    >
      <div className="upload-icon" aria-hidden="true">
        <UploadCloud />
      </div>
      <h2 className="upload-title">
        {file ? 'Ready to upload' : 'Drag & drop a file here'}
      </h2>
      <p className="upload-sub">
        {file
          ? 'Fill in the metadata below and press Upload asset.'
          : 'Or use the file picker. One file per upload.'}
      </p>
      <label className={`btn btn-primary btn-lg upload-browse${disabled ? ' disabled' : ''}`}>
        <FolderOpen aria-hidden="true" /> Browse files
        <input
          type="file"
          hidden
          disabled={disabled}
          onChange={(e) => {
            onPick(e.currentTarget.files);
            // Reset the input so re-picking the same file still fires change.
            e.currentTarget.value = '';
          }}
        />
      </label>

      {file && (
        <ul className="staged-list" aria-label="Selected file">
          <li>
            <FileVideo aria-hidden="true" />
            <span className="staged-name" title={file.name}>{file.name}</span>
            <span className="staged-size">{formatBytes(file.size)}</span>
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={onClear}
              disabled={disabled}
              aria-label="Remove file"
              title="Remove file"
            >
              <X aria-hidden="true" />
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

interface MetadataFieldsetProps {
  form: FormState;
  onField: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  onAssetTypeChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  disabled: boolean;
}

function MetadataFieldset({ form, onField, onAssetTypeChange, disabled }: MetadataFieldsetProps) {
  return (
    <fieldset className="card card-body upload-form" disabled={disabled}>
      <legend className="section-title">Asset metadata</legend>

      <div className="upload-form-grid">
        <label className="field field-wide">
          <span className="field-label">Title *</span>
          <input
            className="input"
            type="text"
            required
            value={form.title}
            onChange={(e) => onField('title', e.currentTarget.value)}
            placeholder="Evening Bulletin — Wildebeest migration package"
          />
        </label>

        <label className="field">
          <span className="field-label">Asset type</span>
          <select
            className="select"
            value={form.assetType}
            onChange={onAssetTypeChange}
          >
            <option value="BroadcastAsset">BroadcastAsset</option>
            <option value="BroadcastVideo">BroadcastVideo</option>
          </select>
          <span className="field-hint">
            {form.assetTypeAuto
              ? 'Auto-selected from the file type. Override if needed.'
              : 'Manually selected.'}
          </span>
        </label>

        <label className="field">
          <span className="field-label">Slug</span>
          <input
            className="input"
            type="text"
            value={form.slug}
            onChange={(e) => onField('slug', e.currentTarget.value)}
            placeholder="wildebeest-migration"
          />
        </label>

        <label className="field">
          <span className="field-label">Programme</span>
          <input
            className="input"
            type="text"
            value={form.programme}
            onChange={(e) => onField('programme', e.currentTarget.value)}
            placeholder="Evening News"
          />
        </label>

        <label className="field">
          <span className="field-label">Episode</span>
          <input
            className="input"
            type="text"
            value={form.episode}
            onChange={(e) => onField('episode', e.currentTarget.value)}
            placeholder="S03E14"
          />
        </label>

        <label className="field">
          <span className="field-label">Bureau</span>
          <input
            className="input"
            type="text"
            value={form.bureau}
            onChange={(e) => onField('bureau', e.currentTarget.value)}
            placeholder="Nairobi"
          />
        </label>

        <label className="field">
          <span className="field-label">Story type</span>
          <select
            className="select"
            value={form.storyType}
            onChange={(e) => onField('storyType', e.currentTarget.value)}
          >
            <option value="">—</option>
            {STORY_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Air date</span>
          <input
            className="input"
            type="date"
            value={form.airDate}
            onChange={(e) => onField('airDate', e.currentTarget.value)}
          />
        </label>
      </div>
    </fieldset>
  );
}

interface ProgressCardProps {
  phase: Extract<Phase, { kind: 'uploading' | 'creating' }>;
  file: File | null;
  onCancel: () => void;
}

function ProgressCard({ phase, file, onCancel }: ProgressCardProps) {
  const isUpload = phase.kind === 'uploading';
  const pct = isUpload ? Math.round(phase.fraction * 100) : 100;
  return (
    <div className="card card-body upload-progress" role="status" aria-live="polite">
      <div className="upload-progress-head">
        <Loader2 className="spin" aria-hidden="true" />
        <div className="upload-progress-text">
          <strong>
            {isUpload ? 'Uploading to Nuxeo…' : 'Creating document…'}
          </strong>
          <span className="mono">
            {isUpload
              ? `${formatBytes(phase.loaded)} of ${formatBytes(phase.total)}`
              : file
                ? `Attaching ${file.name}`
                : 'Attaching blob'}
          </span>
        </div>
        {isUpload && (
          <button type="button" className="btn btn-danger btn-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <div
        className="upload-bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`upload-bar-fill${isUpload ? '' : ' upload-bar-fill-indeterminate'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="upload-progress-sub mono">{pct}%</div>
    </div>
  );
}

interface ErrorCardProps {
  phase: Extract<Phase, { kind: 'error' }>;
  onRetry: () => void;
}

function ErrorCard({ phase, onRetry }: ErrorCardProps) {
  return (
    <div className="card card-body upload-error" role="alert">
      <div className="upload-error-mark" aria-hidden="true">
        <AlertTriangle />
      </div>
      <div className="upload-error-body">
        <h3 className="upload-error-title">Upload failed</h3>
        <p className="upload-error-message">
          {phase.status ? <span className="mono">HTTP {phase.status} — </span> : null}
          {phase.message}
        </p>
      </div>
      <button type="button" className="btn btn-secondary" onClick={onRetry}>
        <RotateCw aria-hidden="true" /> Retry
      </button>
    </div>
  );
}

interface SuccessCardProps {
  phase: Extract<Phase, { kind: 'success' }>;
  onOpenAsset: () => void;
  onUploadAnother: () => void;
}

function SuccessCard({ phase, onOpenAsset, onUploadAnother }: SuccessCardProps) {
  // Auto-navigate after a short beat so the user actually reads the success
  // banner (path/id). Cancellable if they click Upload another first.
  useEffect(() => {
    const t = window.setTimeout(onOpenAsset, 1500);
    return () => window.clearTimeout(t);
  }, [onOpenAsset]);

  return (
    <div className="card card-body upload-success" role="status" aria-live="polite">
      <div className="upload-success-mark" aria-hidden="true">
        <CheckCircle2 />
      </div>
      <div className="upload-success-body">
        <h2 className="upload-success-title">Asset created</h2>
        <p className="upload-success-sub">
          A new <strong>{phase.type}</strong> document is now in the repository.
          You'll be redirected to its detail page in a moment.
        </p>
        <dl className="upload-success-facts">
          <div>
            <dt>Path</dt>
            <dd className="mono">{phase.path}</dd>
          </div>
          <div>
            <dt>UID</dt>
            <dd className="mono">{phase.uid}</dd>
          </div>
        </dl>
        <div className="upload-success-actions">
          <button type="button" className="btn btn-primary" onClick={onOpenAsset}>
            Open asset
          </button>
          <button type="button" className="btn btn-secondary" onClick={onUploadAnother}>
            Upload another
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function compactBroadcast(form: FormState): BroadcastProperties {
  const out: BroadcastProperties = {};
  if (form.slug) out['broadcast:slug'] = form.slug;
  if (form.programme) out['broadcast:programme'] = form.programme;
  if (form.episode) out['broadcast:episode'] = form.episode;
  if (form.bureau) out['broadcast:bureau'] = form.bureau;
  if (form.storyType) out['broadcast:storyType'] = form.storyType;
  if (form.airDate) out['broadcast:airDate'] = form.airDate;
  // broadcast:editorialStatus is intentionally never set here — see the
  // comment above FormState.
  return out;
}

function errorPhase(err: unknown, fallback: string): Phase {
  if (err instanceof NuxeoApiError) {
    return {
      kind: 'error',
      message: err.message || fallback,
      status: err.status || undefined,
    };
  }
  if (err instanceof Error) {
    return { kind: 'error', message: `${fallback}: ${err.message}` };
  }
  return { kind: 'error', message: fallback };
}
