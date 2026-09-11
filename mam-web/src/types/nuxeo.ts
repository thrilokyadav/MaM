/**
 * Minimal typings for the subset of the Nuxeo REST API this UI actually
 * consumes. Deliberately narrow; we do not try to model every optional
 * field Nuxeo can emit.
 */

/** Response shape for `GET /api/v1/search/pp/{name}/execute`. */
export interface NuxeoPageProviderResult<TEntry = NuxeoDocument> {
  'entity-type': 'documents';
  entries: TEntry[];
  currentPageIndex: number;
  pageSize: number;
  numberOfPages: number;
  resultsCount: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
  currentPageOffset?: number;
  totalSize?: number;
}

/**
 * Document envelope returned by both page-provider queries and single-doc
 * reads. `properties` is populated only when the caller asks for it (via
 * the `properties` header or query parameter).
 */
export interface NuxeoDocument {
  'entity-type': 'document';
  uid: string;
  path: string;
  type: string;
  state?: string;
  title: string;
  lastModified?: string;
  properties?: Record<string, unknown>;
  facets?: string[];
  isCheckedOut?: boolean;
  isTrashed?: boolean;
  isVersion?: boolean;
  contextParameters?: Record<string, unknown>;
}

/**
 * `contextParameters.thumbnail` shape added by Nuxeo's `thumbnail` document
 * enricher (see `ThumbnailJsonEnricher`, nuxeo-thumbnail module). Present
 * only when the request asks for it via the `enrichers-document: thumbnail`
 * header.
 */
export interface NuxeoThumbnailContext {
  url: string;
}

/** Standard Nuxeo error envelope. */
export interface NuxeoErrorPayload {
  'entity-type': 'exception';
  status: number;
  message: string;
  stacktrace?: string;
}

/**
 * Paginated envelope for `GET /api/v1/task` — confirmed against the running
 * server: `{"entity-type":"tasks","entries":[...],"resultsCount":...}`,
 * NOT a bare array despite the generic page provider.
 */
export interface NuxeoTaskListResult {
  'entity-type': 'tasks';
  entries: NuxeoTask[];
  resultsCount: number;
  pageSize: number;
  currentPageIndex: number;
  numberOfPages: number;
}

/**
 * Workflow task envelope as returned by `GET /api/v1/task` and
 * `GET /api/v1/task/{taskId}` (see nuxeo-routing-rest-api TaskWriter.java).
 * Only the fields this UI actually reads are modeled.
 */
export interface NuxeoTask {
  'entity-type': 'task';
  id: string;
  name: string;
  workflowInstanceId?: string;
  workflowModelName?: string;
  workflowTitle?: string;
  state?: string;
  directive?: string;
  created?: string;
  dueDate?: string;
  nodeName?: string;
  /** Present as `[{ id: string }]` unless the `targetDocumentIds` fetch key is requested. */
  targetDocumentIds: Array<{ id: string }>;
  actors: Array<{ id: string }>;
  delegatedActors: Array<{ id: string }>;
  comments: Array<{ author: string; text: string; date: string }>;
  variables?: Record<string, unknown>;
  taskInfo?: {
    allowTaskReassignment: boolean;
    taskActions: Array<{ name: string; url: string; label: string; validate: boolean }>;
  };
}
