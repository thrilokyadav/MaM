/**
 * Document-level actions: workflow, automation operations, metadata
 * updates, and deletes. Everything routes through `nuxeoRequest` so it
 * inherits:
 *   - the dev-only auth policy (never any baked-in credential)
 *   - the CSRF-Token header on POST/PUT/PATCH/DELETE
 *   - the automatic re-fetch + one-shot retry on 403+`CSRF-Token: invalid`
 *   - session-cookie preservation via `credentials: 'same-origin'`
 *
 * Verified endpoints (Nuxeo REST API v1):
 *   POST   /api/v1/id/{uid}/@workflow               start a workflow
 *   DELETE /api/v1/workflow/{workflowInstanceId}    cancel a running workflow
 *   PUT    /api/v1/task/{taskId}/{action}           complete / advance a task
 *   POST   /api/v1/id/{uid}/@op/{operationId}       automation operation
 *   PUT    /api/v1/id/{uid}                         update properties
 *   DELETE /api/v1/id/{uid}                         delete document
 *
 * `completeTask` verified against
 * nuxeo-routing-rest-api/.../TaskObject.java#completeTask (`@PUT
 * @Path("{taskId}/{taskAction}")`) and the request body shape read by
 * TaskCompletionRequestJsonReader (`readEntity`): a top-level `"id"` (the
 * task id, used to resolve the workflow/node schemas) and `"comment"`
 * (persisted as the node's `comment` variable, which the audit log and any
 * `NodeVariables["comment"]` condition can read).
 */

import { NuxeoApiError, nuxeoRequest } from './nuxeoClient';
import type { NuxeoDocument } from '../types/nuxeo';

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

/** Nuxeo workflow envelope as returned by `POST /id/{uid}/@workflow`. */
export interface NuxeoWorkflow {
  'entity-type': 'workflow';
  id: string;
  workflowModelName: string;
  state?: string;
  attachedDocumentIds?: string[];
  variables?: Record<string, unknown>;
}

export async function startWorkflow(
  uid: string,
  workflowModelName: string,
  variables?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<NuxeoWorkflow> {
  if (!uid) throw new NuxeoApiError('startWorkflow: uid is required', 0);
  if (!workflowModelName) {
    throw new NuxeoApiError('startWorkflow: workflowModelName is required', 0);
  }
  return nuxeoRequest<NuxeoWorkflow>(`/id/${encodeURIComponent(uid)}/@workflow`, {
    method: 'POST',
    body: {
      'entity-type': 'workflow',
      workflowModelName,
      ...(variables ? { variables } : {}),
    },
    signal,
  });
}

export interface NuxeoTaskCompletion {
  'entity-type': 'task';
  id: string;
  state?: string;
}

export async function completeTask(
  taskId: string,
  action: string,
  options: { comment?: string; variables?: Record<string, unknown> } = {},
  signal?: AbortSignal,
): Promise<NuxeoTaskCompletion> {
  if (!taskId) throw new NuxeoApiError('completeTask: taskId is required', 0);
  if (!action) throw new NuxeoApiError('completeTask: action is required', 0);
  return nuxeoRequest<NuxeoTaskCompletion>(
    `/task/${encodeURIComponent(taskId)}/${encodeURIComponent(action)}`,
    {
      method: 'PUT',
      body: {
        'entity-type': 'task',
        id: taskId,
        ...(options.comment ? { comment: options.comment } : {}),
        ...(options.variables ? { variables: options.variables } : {}),
      },
      signal,
    },
  );
}

/**
 * DELETE /api/v1/workflow/{workflowInstanceId} — cancel a running workflow
 * instance. Nuxeo restricts this to the workflow's initiator, members of
 * `powerusers`, or administrators (see WorkflowObject#checkCancelGuards);
 * anyone else gets a real 403 which this function does not swallow.
 */
export async function cancelWorkflow(
  workflowInstanceId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!workflowInstanceId) {
    throw new NuxeoApiError('cancelWorkflow: workflowInstanceId is required', 0);
  }
  await nuxeoRequest<void>(`/workflow/${encodeURIComponent(workflowInstanceId)}`, {
    method: 'DELETE',
    signal,
  });
}

// ---------------------------------------------------------------------------
// Automation operations
// ---------------------------------------------------------------------------

export interface OperationInput {
  params?: Record<string, unknown>;
  context?: Record<string, unknown>;
  input?: unknown;
}

/**
 * Call a Nuxeo automation operation against a single document.
 * Example: `runOperation(uid, 'Document.SetProperty', { params: { xpath: 'dc:description', value: '…' } })`.
 */
export async function runOperation<T = unknown>(
  uid: string,
  operationId: string,
  body: OperationInput = {},
  signal?: AbortSignal,
): Promise<T> {
  if (!uid) throw new NuxeoApiError('runOperation: uid is required', 0);
  if (!operationId) {
    throw new NuxeoApiError('runOperation: operationId is required', 0);
  }
  return nuxeoRequest<T>(
    `/id/${encodeURIComponent(uid)}/@op/${encodeURIComponent(operationId)}`,
    {
      method: 'POST',
      body: {
        input: body.input ?? `doc:${uid}`,
        params: body.params ?? {},
        context: body.context ?? {},
      },
      signal,
    },
  );
}

// ---------------------------------------------------------------------------
// Update / delete
// ---------------------------------------------------------------------------

export async function updateAsset(
  uid: string,
  properties: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<NuxeoDocument> {
  return nuxeoRequest<NuxeoDocument>(`/id/${encodeURIComponent(uid)}`, {
    method: 'PUT',
    body: { 'entity-type': 'document', uid, properties },
    headers: { properties: 'broadcast,dublincore' },
    signal,
  });
}

export async function deleteAsset(
  uid: string,
  signal?: AbortSignal,
): Promise<void> {
  await nuxeoRequest<void>(`/id/${encodeURIComponent(uid)}`, {
    method: 'DELETE',
    signal,
  });
}
