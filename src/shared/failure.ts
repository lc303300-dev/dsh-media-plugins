/**
 * Failure taxonomy for the unified media router.
 *
 * Mirrors the Codex_Wsstudio contract (§5.2 and UNIFIED_MEDIA_TOOL_REFACTOR_BLUEPRINT §9):
 * only explicitly allowed classes may fall back to the next provider; anything
 * indeterminate must surface as `needs_review` and must never be auto-retried.
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

/** Classes that permit switching to the next provider (serial fallback). */
export const FALLBACK_ALLOWED: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'auth_unavailable',
  'quota_unavailable',
  'definite_provider_failure',
  'download_failure',
  'timeout_before_submit',
  'provider_timeout',
])

/** Classes that must stop routing immediately (never fall back). */
export const STOP_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'input_error',
  'indeterminate_submission',
  'policy_rejection',
  'cancelled',
  'task_timeout',
])

/** True when the outcome of a paid call is unknown and must not be repeated. */
export function isIndeterminate(cls: FailureClass): boolean {
  return cls === 'indeterminate_submission' || cls === 'timeout_before_submit' && false
}

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
}
