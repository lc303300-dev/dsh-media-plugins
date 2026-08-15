//#region src/shared/failure.ts
/** Classes that permit switching to the next provider (serial fallback). */
const FALLBACK_ALLOWED = /* @__PURE__ */ new Set([
	"auth_unavailable",
	"quota_unavailable",
	"definite_provider_failure",
	"download_failure",
	"timeout_before_submit",
	"provider_timeout"
]);
/** Error carrying a stable failure class plus optional safe detail. */
var MediaError = class extends Error {
	cls;
	detail;
	constructor(cls, message, detail) {
		super(message);
		this.name = "MediaError";
		this.cls = cls;
		this.detail = detail;
	}
};
/** Helper constructors so call sites read like the taxonomy table. */
const mediaErrors = {
	input: (message, detail) => new MediaError("input_error", message, detail),
	auth: (message, detail) => new MediaError("auth_unavailable", message, detail),
	quota: (message, detail) => new MediaError("quota_unavailable", message, detail),
	provider: (message, detail) => new MediaError("definite_provider_failure", message, detail),
	download: (message, detail) => new MediaError("download_failure", message, detail),
	timeoutBeforeSubmit: (message, detail) => new MediaError("timeout_before_submit", message, detail),
	providerTimeout: (message, detail) => new MediaError("provider_timeout", message, detail),
	indeterminate: (message, detail) => new MediaError("indeterminate_submission", message, detail),
	policy: (message, detail) => new MediaError("policy_rejection", message, detail),
	cancelled: (message, detail) => new MediaError("cancelled", message, detail),
	taskTimeout: (message, detail) => new MediaError("task_timeout", message, detail)
};
//#endregion
export { MediaError as n, mediaErrors as r, FALLBACK_ALLOWED as t };
