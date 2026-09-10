/**
 * Failure taxonomy for the unified media router.
 *
 * Mirrors the Codex_Wsstudio contract (§5.2 and UNIFIED_MEDIA_TOOL_REFACTOR_BLUEPRINT §9):
 * only explicitly allowed classes may fall back to the next provider; anything
 * indeterminate must surface as `needs_review` and must never be auto-retried.
 *
 * Fallback policy (deliberate, cost- and time-driven):
 * - ERROR classes may switch provider: the request was rejected or failed
 *   before generating anything, so the attempt cost nothing and returned in
 *   milliseconds. See FALLBACK_ALLOWED.
 * - TIMEOUT classes may NOT: by the time a timeout fires the request has
 *   already been sent, so the call may already be billed, and trying another
 *   route would pay twice for the same candidate. A timeout also consumes the
 *   whole per-attempt budget (90 s), which is exactly the per-candidate basis
 *   the dispatch deadline is built on — retrying would break that math.
 *   See STOP_CLASSES.
 *
 * @module dsh-media-plugins/shared/failure
 */

/** Stable failure classes used across routers, adapters and task stores. */
export type FailureClass =
  | 'input_error'
  | 'auth_unavailable'
  | 'quota_unavailable'
  | 'definite_provider_failure'
  | 'download_failure'
  | 'timeout_before_submit'
  | 'provider_timeout'
  | 'indeterminate_submission'
  | 'policy_rejection'
  | 'cancelled'
  | 'task_timeout'
  | 'concurrency_busy'

/** Every class, so callers (and tests) can verify the two sets are exhaustive. */
export const ALL_FAILURE_CLASSES: readonly FailureClass[] = [
  'input_error',
  'auth_unavailable',
  'quota_unavailable',
  'definite_provider_failure',
  'download_failure',
  'timeout_before_submit',
  'provider_timeout',
  'indeterminate_submission',
  'policy_rejection',
  'cancelled',
  'task_timeout',
  'concurrency_busy',
]

/**
 * ERROR classes only: the provider rejected the request or failed before
 * generating anything, so the attempt cost nothing and returned quickly.
 * Switching routes here is free and can genuinely rescue the candidate.
 */
export const FALLBACK_ALLOWED: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'auth_unavailable',
  'quota_unavailable',
  'definite_provider_failure',
])

/**
 * Classes that stop routing immediately — never fall back to another provider.
 * Covers invalid input, indeterminate submissions, policy rejections,
 * cancellations, the task budget, the timeout classes (paid-but-unresolved),
 * already-generated work that only failed to download, and our own capacity
 * limit (retrying another route leases from the same shared pool).
 */
export const STOP_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'input_error',
  'indeterminate_submission',
  'policy_rejection',
  'cancelled',
  'task_timeout',
  'timeout_before_submit',
  'provider_timeout',
  'download_failure',
  'concurrency_busy',
])

/** Error carrying a stable failure class plus optional safe detail. */
export class MediaError extends Error {
  readonly cls: FailureClass
  readonly detail?: string

  constructor(cls: FailureClass, message: string, detail?: string) {
    super(message)
    this.name = 'MediaError'
    this.cls = cls
    this.detail = detail
  }
}

/** Helper constructors so call sites read like the taxonomy table. */
export const mediaErrors = {
  input: (message: string, detail?: string) => new MediaError('input_error', message, detail),
  auth: (message: string, detail?: string) => new MediaError('auth_unavailable', message, detail),
  quota: (message: string, detail?: string) => new MediaError('quota_unavailable', message, detail),
  provider: (message: string, detail?: string) => new MediaError('definite_provider_failure', message, detail),
  download: (message: string, detail?: string) => new MediaError('download_failure', message, detail),
  timeoutBeforeSubmit: (message: string, detail?: string) => new MediaError('timeout_before_submit', message, detail),
  providerTimeout: (message: string, detail?: string) => new MediaError('provider_timeout', message, detail),
  indeterminate: (message: string, detail?: string) => new MediaError('indeterminate_submission', message, detail),
  policy: (message: string, detail?: string) => new MediaError('policy_rejection', message, detail),
  cancelled: (message: string, detail?: string) => new MediaError('cancelled', message, detail),
  taskTimeout: (message: string, detail?: string) => new MediaError('task_timeout', message, detail),
  busy: (message: string, detail?: string) => new MediaError('concurrency_busy', message, detail),
}
