/**
 * Review queue: task-driven, not document-filter-driven.
 *
 * The queue is built from the authenticated principal's own open workflow
 * tasks — the same tasks Nuxeo's own task inbox would show them — rather
 * than by searching for documents with a given `broadcast:editorialStatus`.
 * A document can only appear here if a real, currently-open task targets
 * it and that task is visible to (assigned to, directly or via group
 * membership) the current user.
 *
 * Verified endpoints (Nuxeo REST API v1):
 *   GET    /api/v1/me                                current principal (id + groups)
 *   GET    /api/v1/task?userId={id}                  tasks assigned to that principal
 *                                                      or any group it belongs to
 *   GET    /api/v1/id/{uid}                           target document, with
 *                                                      broadcast/dublincore
 *                                                      properties + thumbnail enricher
 *   PUT    /api/v1/task/{taskId}/{action}             approve / reject / submit_to_editorial
 *   DELETE /api/v1/workflow/{workflowInstanceId}      cancel a running instance (send-back-to-draft)
 *   PUT    /api/v1/id/{uid}                           set broadcast:editorialStatus (send-back-to-draft only)
 *
 * `GET /api/v1/task?userId=` is `RoutingTaskPageProvider`
 * (nuxeo-routing-core): server-side, it resolves `userId` to a
 * `NuxeoPrincipal` and expands it via `TaskActorsHelper.getTaskActors` —
 * the principal's own name AND every group it belongs to (prefixed and
 * unprefixed forms) — then matches against `nt:actors`/`nt:delegatedActors`.
 * The UI never exposes this parameter to the user or accepts an arbitrary
 * value: `userId` is always the `id` from `GET /me`, which is bound to the
 * caller's own credentials/session and cannot be spoofed client-side.
 *
 * Workflow model (mam-platform/mam-workflow, route MAM_EDITORIAL_APPROVAL):
 *   NodeDraft (auto) -> NodeQC (task: submit_to_editorial | reject)
 *     -> NodeEditorial (task: approve | reject) -> NodeApproved / NodeRejected
 *
 * There is no "send back to draft" transition in that route — only
 * approve/reject exist as task buttons. Sending an asset back to draft is
 * therefore implemented as two real REST calls (not a fabricated workflow
 * step): best-effort cancellation of the running workflow instance, then
 * setting `broadcast:editorialStatus` back to `draft` via the document
 * update endpoint. Both calls go through the CSRF-aware client and surface
 * real errors (including 403) exactly like every other action here.
 */

import { NuxeoApiError, nuxeoRequest } from './nuxeoClient';
import { cancelWorkflow, completeTask, updateAsset } from './actionsApi';
import { getCurrentUser } from './meApi';
import type { MamDocument } from '../types/mam';
import type { NuxeoTask, NuxeoTaskListResult } from '../types/nuxeo';

export interface ReviewQueueEntry {
  task: NuxeoTask;
  /** The task's target document. `null` if it failed to load (e.g. deleted, or a real permission issue on the doc itself — surfaced per-row, not fatal to the whole queue). */
  asset: MamDocument | null;
  assetError?: string;
}

/**
 * Load the current principal's open workflow tasks, each paired with its
 * target document (fetched with broadcast/dublincore properties and the
 * thumbnail enricher). One row per task — an asset with two concurrent
 * tasks (not possible in this route, but not assumed away either) would
 * appear twice, once per task, which is the accurate representation of
 * "what needs my attention right now".
 */
export async function listReviewQueue(signal?: AbortSignal): Promise<ReviewQueueEntry[]> {
  const me = await getCurrentUser();
  const tasks = await listMyTasks(me.id, signal);

  const entries = await Promise.all(
    tasks.map(async (task): Promise<ReviewQueueEntry> => {
      const docId = task.targetDocumentIds?.[0]?.id;
      if (!docId) {
        return { task, asset: null, assetError: 'This task has no target document.' };
      }
      try {
        const asset = await fetchAssetWithThumbnail(docId, signal);
        return { task, asset };
      } catch (e) {
        const message = e instanceof NuxeoApiError ? e.message : (e as Error).message;
        return { task, asset: null, assetError: message };
      }
    }),
  );

  // Most recently created task first — that's the most recently
  // submitted-for-review item, which is what an editor triaging a queue
  // wants to see at the top.
  return entries.sort((a, b) => {
    const ta = a.task.created ? Date.parse(a.task.created) : 0;
    const tb = b.task.created ? Date.parse(b.task.created) : 0;
    return tb - ta;
  });
}

/**
 * GET /api/v1/task?userId={id} — every currently-open workflow task
 * assigned to `id` or to any group `id` belongs to (resolved server-side).
 *
 * Confirmed against the running server that despite being backed by a
 * `genericPageProvider`, the response is the standard paginated envelope
 * (`{ "entity-type": "tasks", "entries": [...] }`), not a bare array.
 */
export async function listMyTasks(userId: string, signal?: AbortSignal): Promise<NuxeoTask[]> {
  const result = await nuxeoRequest<NuxeoTaskListResult>('/task', {
    method: 'GET',
    query: { userId, pageSize: 100 },
    signal,
  });
  return result.entries ?? [];
}

/**
 * Find the current principal's open task on a specific document (used by
 * `AssetDetailPage`'s Approve/Reject/Submit buttons, which act on a single
 * asset rather than a whole queue). Returns `null` if there is no open
 * task for this document assigned to the caller — which is the normal
 * case for a draft asset (nothing has been submitted yet) or an asset
 * someone else is reviewing.
 *
 * There is deliberately no server endpoint for "the task on this
 * document" — `GET /api/v1/task` only supports filtering by `userId` or
 * `workflowInstanceId`, not `targetDocumentId` — so this fetches the
 * caller's full task list and filters client-side. That list is small
 * (a newsroom's live QC/Editorial queue), so this is not a performance
 * concern.
 */
export async function findMyTaskForDocument(
  userId: string,
  docUid: string,
  signal?: AbortSignal,
): Promise<NuxeoTask | null> {
  const tasks = await listMyTasks(userId, signal);
  return tasks.find((t) => t.targetDocumentIds?.some((d) => d.id === docUid)) ?? null;
}

async function fetchAssetWithThumbnail(uid: string, signal?: AbortSignal): Promise<MamDocument> {
  return nuxeoRequest<MamDocument>(`/id/${encodeURIComponent(uid)}`, {
    method: 'GET',
    headers: {
      properties: 'broadcast,dublincore,video',
      'enrichers-document': 'thumbnail',
    },
    signal,
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Approve — completes the task's `approve` button. */
export async function approveTask(
  entry: ReviewQueueEntry,
  comment?: string,
  signal?: AbortSignal,
): Promise<void> {
  await runTaskAction(entry, 'approve', comment, signal);
}

/** Reject — a reason is mandatory, enforced here (not just in the UI). */
export async function rejectTask(
  entry: ReviewQueueEntry,
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new NuxeoApiError('A rejection reason is required.', 0);
  }
  await runTaskAction(entry, 'reject', trimmed, signal);
}

/** Submit to Editorial Approval — the NodeQC task's forward transition. */
export async function submitToEditorial(
  entry: ReviewQueueEntry,
  comment?: string,
  signal?: AbortSignal,
): Promise<void> {
  await runTaskAction(entry, 'submit_to_editorial', comment, signal);
}

/**
 * Send back to draft. No workflow transition targets NodeDraft, so this
 * cancels the running instance (best-effort — a 404 here is swallowed
 * only when the instance is already gone; any other failure is real and
 * is reported) and then writes the property directly.
 */
export async function sendBackToDraft(
  entry: ReviewQueueEntry,
  signal?: AbortSignal,
): Promise<void> {
  if (entry.task.workflowInstanceId) {
    try {
      await cancelWorkflow(entry.task.workflowInstanceId, signal);
    } catch (e) {
      if (!(e instanceof NuxeoApiError) || e.status !== 404) throw e;
    }
  }
  const docId = entry.task.targetDocumentIds?.[0]?.id;
  if (!docId) {
    throw new NuxeoApiError('This task has no target document to update.', 0);
  }
  await updateAsset(docId, { 'broadcast:editorialStatus': 'draft' }, signal);
}

async function runTaskAction(
  entry: ReviewQueueEntry,
  button: string,
  comment: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const available = entry.task.taskInfo?.taskActions?.map((a) => a.name) ?? [];
  if (available.length > 0 && !available.includes(button)) {
    throw new NuxeoApiError(
      `This task does not offer a "${button}" action (available: ${available.join(', ') || 'none'}).`,
      409,
    );
  }
  await completeTask(entry.task.id, button, { comment }, signal);
}
