/**
 * Image adapters + serial image router.
 *
 * Contract (UNIFIED_MEDIA_TOOL_REFACTOR_BLUEPRINT §1.2/§9, media-router.defaults.json):
 * - strictly serial per-adapter attempts, never parallel/hedged;
 * - per-adapter budget default 120 s, whole-task default 300 s;
 * - fallback only for FALLBACK_ALLOWED classes; indeterminate stops with needs_review;
 * - default concurrency 6 per adapter; `seedance-cli` capacity shared by
 *   dreamina image + video;
 * - `image_ratio` is required and never inferred; the 8 standard ratios are
 *   accepted as-is and a concrete pixel size (1920x1080) is converted to the
 *   nearest standard ratio;
 * - `image_resolution` (1K/2K/4K) is optional with provider-specific defaults
 *   (Gemini routes default 2K, Dreamina defaults 1K); the GPT 2.5 route is
 *   4K-only and clamps any other requested class up to 4K;
 * - `image_provider` is a user-explicit restricted route: only that adapter
 *   runs, there is no cross-route fallback, and unknown/disabled routes are
 *   rejected as input_error before any paid call.
 *
 * @module dsh-media-plugins/shared/adapters
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { MediaError, mediaErrors, FALLBACK_ALLOWED, type AttemptRecord } from './failure.ts'
import { IMAGE_RATIOS } from './ratios.ts'
import { openAiImageResult, downloadImageTo, stageImageBytes, HttpStatusError } from './media-client.ts'
import {
  acquireSlot,
  appendSafeLog,
  ensureDir,
  isCircuitOpen,
  newTaskId,
  recordProviderOutcome,
  sha256Text,
} from './private-runtime.ts'

const execFileAsync = promisify(execFile)

/** The 8 supported image ratios (contract: never infer, never extend). */
export const SUPPORTED_RATIOS: readonly string[] = IMAGE_RATIOS

/** The 3 supported image resolution classes (contract). */
export const SUPPORTED_RESOLUTIONS: readonly string[] = ['1K', '2K', '4K'] as const

/** Public image route ids accepted by `image_provider` (DSH canonical ids, default route first). */
export const SUPPORTED_IMAGE_PROVIDERS: readonly string[] = [
  'comfly-gpt-image-2.5',
  'comfly-gemini-flash-preview',
  'dreamina-image',
] as const

/** 1K-only pixel allowlist for the supported ratios (identical to Codex GEMINI_LITE_1K_SIZES). */
export const RATIO_SIZES: Readonly<Record<string, string>> = {
  '21:9': '1584x672',
  '16:9': '1376x768',
  '3:2': '1264x848',
  '4:3': '1200x896',
  '1:1': '1024x1024',
  '3:4': '896x1200',
  '2:3': '848x1264',
  '9:16': '768x1376',
}

/** Comfly Gemini models per resolution class (contract: models_by_resolution). */
export const GEMINI_MODELS_BY_RESOLUTION: Readonly<Record<string, string>> = {
  '1K': 'gemini-3.1-flash-image-preview',
  '2K': 'gemini-3.1-flash-image-preview-2k',
  '4K': 'gemini-3.1-flash-image-preview-4k',
}

/** Comfly GPT Image 2.5 model id (default image route). */
export const GPT_IMAGE_25_MODEL = 'gpt-image-2.5-sunburst'

/**
 * The GPT 2.5 route is 4K-only: every request is submitted with the 4K pixel
 * table, and a user-supplied 1K/2K `image_resolution` is clamped to 4K
 * instead of downgrading the output.
 */
export const GPT_IMAGE_25_RESOLUTION = '4K'

/**
 * GPT Image 2.5 concrete pixel sizes (contract: GPT_IMAGE_2_5_SIZES). The
 * route is 4K-only, so the table holds exactly the Comfly
 * `gpt-image-2.5-sunburst` 4K contract row; a requested 1K/2K class is
 * clamped up to 4K by the adapter before this table is consulted.
 */
export const GPT_IMAGE_2_5_SIZES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '4K': {
    '21:9': '3840x1648',
    '16:9': '3840x2160',
    '3:2': '3520x2352',
    '4:3': '3312x2480',
    '1:1': '2880x2880',
    '3:4': '2480x3312',
    '2:3': '2352x3520',
    '9:16': '2160x3840',
  },
}

/** @deprecated Legacy name of {@link GPT_IMAGE_2_5_SIZES} (same table object). */
export const GPT_IMAGE_2_SIZES = GPT_IMAGE_2_5_SIZES

/** Pixel-size spelling accepted in `image_ratio` (e.g. 1920x1080 / 1920×1080 / 1920*1080). */
const PIXEL_SIZE_PATTERN = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i

/**
 * Nearest standard ratio for a concrete pixel size (user-reported output
 * dimensions), compared in log space so a ratio and its inverse stay distinct.
 */
export function ratioFromPixels(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw mediaErrors.input(`invalid pixel size "${width}x${height}"`)
  }
  const target = Math.log(width / height)
  let best: string = SUPPORTED_RATIOS[0]
  let bestDelta = Number.POSITIVE_INFINITY
  for (const candidate of SUPPORTED_RATIOS) {
    const [w, h] = candidate.split(':').map(Number)
    const delta = Math.abs(Math.log(w / h) - target)
    if (delta < bestDelta) {
      bestDelta = delta
      best = candidate
    }
  }
  return best
}

/**
 * Normalize an `image_ratio` value. The 8 standard ratios pass through
 * unchanged; a concrete pixel size (`1920x1080`) is converted to the nearest
 * standard ratio — the GPT 2.5 route then renders that ratio at 4K.
 */
export function normalizeRatio(value: string): string {
  const raw = (value ?? '').trim()
  if (SUPPORTED_RATIOS.includes(raw)) return raw
  const match = PIXEL_SIZE_PATTERN.exec(raw)
  if (match) return ratioFromPixels(Number(match[1]), Number(match[2]))
  throw mediaErrors.input(
    `unsupported image_ratio "${raw}"; use one of ${SUPPORTED_RATIOS.join(', ')} or a pixel size such as 1920x1080`,
  )
}

/** Resolve an explicit ratio (or a pixel size) to a pixel size; throws input_error otherwise. */
export function ratioToSize(ratio: string): string {
  const value = normalizeRatio(ratio)
  const mapped = RATIO_SIZES[value]
  if (mapped !== undefined) return mapped
  throw mediaErrors.input(
    `unsupported image_ratio "${value}"; supported values: ${SUPPORTED_RATIOS.join(', ')}`,
  )
}

/** Validate a user-supplied resolution class; throws input_error for anything else. */
export function assertSupportedResolution(resolution: string | undefined): void {
  if (resolution !== undefined && !SUPPORTED_RESOLUTIONS.includes(resolution)) {
    throw mediaErrors.input(
      `Unsupported image_resolution "${resolution}"; supported values: ${SUPPORTED_RESOLUTIONS.join(', ')}`,
    )
  }
}

/** Gemini pixel size: scale the 1K ratio allowlist by the resolution class. */
export function geminiSizeFor(ratio: string, resolution: string): string {
  const scale = { '1K': 1, '2K': 2, '4K': 4 }[resolution]
  if (scale === undefined) {
    throw mediaErrors.input(`Unsupported image_resolution "${resolution}"; supported values: ${SUPPORTED_RESOLUTIONS.join(', ')}`)
  }
  const base = RATIO_SIZES[normalizeRatio(ratio)]
  if (base === undefined) {
    throw mediaErrors.input(`Unsupported image_ratio "${ratio}"; supported values: ${SUPPORTED_RATIOS.join(', ')}`)
  }
  const [width, height] = base.split('x').map(Number)
  return `${width * scale}x${height * scale}`
}

/** GPT Image 2.5 pixel size: table lookup per ratio x resolution. */
export function gptImage25SizeFor(ratio: string, resolution: string): string {
  const sizes = GPT_IMAGE_2_5_SIZES[resolution]
  if (sizes === undefined) {
    throw mediaErrors.input(`Unsupported image_resolution "${resolution}"; supported values: ${SUPPORTED_RESOLUTIONS.join(', ')}`)
  }
  const px = sizes[normalizeRatio(ratio)]
  if (px === undefined) {
    throw mediaErrors.input(`Unsupported image_ratio "${ratio}" for ${resolution} output; supported values: ${SUPPORTED_RATIOS.join(', ')}`)
  }
  return px
}

/** @deprecated Legacy alias of {@link gptImage25SizeFor}. */
export const gptImage2SizeFor = gptImage25SizeFor

export interface RouterConfig {
  comflyBaseURL: string
  comflyApiKeyEnv: string
  dreaminaPath: string
  proxyUrl: string
  maxConcurrency: number
  providerTimeoutMs: number
  taskTimeoutMs: number
  outputDir: string
  enabled: string[]
  /** Injected credentials (env -> value), resolved by the tool via ctx.credentials. */
  credentials?: Record<string, string>
}

export interface AdapterInput {
  prompt: string
  /** Normalized provider inputs (EXIF + resized, staged in the private runtime). */
  images: string[]
  /** Concrete pixel size the adapter must submit (resolved per route+resolution). */
  size: string
  /** Ratio token (used by adapters that take a ratio instead of pixels). */
  ratio: string
  /** Validated user-selected resolution class; undefined lets the adapter apply its route default. */
  resolution?: string
  privateRoot: string
  proxyUrl?: string
  signal?: AbortSignal
  /** Whole-task remaining budget; the adapter must return within min(budget, adapterBudget). */
  budgetMs: number
}

export interface ImageAdapter {
  id: string
  model: string
  capacityKey: string
  checkReady(): Promise<{ ready: boolean; reason?: string }>
  /** Returns the staged output path plus the model/resolution/size actually used. */
  execute(input: AdapterInput): Promise<{ outputPath: string; model?: string; resolution?: string; size?: string }>
}

/** Classify an HTTP status into the failure taxonomy. */
export function classifyHttp(status: number): MediaError {
  switch (status) {
    case 400:
    case 422:
      return mediaErrors.policy(`HTTP ${status}: request rejected by provider policy`)
    case 401:
    case 403:
      return mediaErrors.auth(`HTTP ${status}: provider rejected credentials`)
    case 402:
    case 429:
      return mediaErrors.quota(`HTTP ${status}: provider quota or rate limit`)
    default:
      if (status >= 500) return mediaErrors.provider(`HTTP ${status}: provider server error`)
      return mediaErrors.provider(`HTTP ${status}: unexpected provider failure`)
  }
}

/** Resolve a credential: injected map (DSH credentials service) first, env fallback. */
function credentials(cfg: RouterConfig, env: string): string | undefined {
  const injected = cfg.credentials?.[env]
  if (typeof injected === 'string' && injected.length > 0) return injected
  return process.env[env] || undefined
}

/* ------------------------------------------------------------------ */
/* Adapters                                                            */
/* ------------------------------------------------------------------ */

/**
 * Comfly OpenAI-compatible adapter (one fixed model, one request).
 *
 * The `profile` switches contracts. `gemini` selects the model per
 * resolution class (1K/2K/4K) and sends the provider-specific `resolution`
 * field plus `response_format: 'url'`. `gpt` is the Comfly GPT Image 2.5
 * ("sunburst") contract: one fixed model, a concrete pixel `size`, and
 * neither `resolution` nor `response_format`; the image comes back as
 * `data[0].b64_json`.
 */
function comflyAdapter(
  id: string,
  model: string,
  cfg: RouterConfig,
  profile: 'gemini' | 'gpt' = 'gpt',
): ImageAdapter {
  const defaultResolution = profile === 'gemini' ? '2K' : GPT_IMAGE_25_RESOLUTION
  return {
    id,
    model,
    capacityKey: id,
    async checkReady() {
      return { ready: Boolean(credentials(cfg, cfg.comflyApiKeyEnv)), reason: cfg.comflyApiKeyEnv }
    },
    async execute(input) {
      const apiKey = credentials(cfg, cfg.comflyApiKeyEnv)
      if (!apiKey) throw mediaErrors.auth(`missing credential ${cfg.comflyApiKeyEnv}`)
      // GPT 2.5 is 4K-only: never downgrade to 1K/2K even when one is requested.
      const resolution = profile === 'gemini' ? (input.resolution ?? defaultResolution) : GPT_IMAGE_25_RESOLUTION
      const effectiveModel = profile === 'gemini' ? (GEMINI_MODELS_BY_RESOLUTION[resolution] ?? model) : model
      const size = profile === 'gemini' ? geminiSizeFor(input.ratio, resolution) : gptImage25SizeFor(input.ratio, resolution)
      const payload = await openAiImageResult({
        baseURL: cfg.comflyBaseURL,
        apiKey,
        model: effectiveModel,
        prompt: input.prompt,
        size,
        sendResolution: profile === 'gemini',
        sendResponseFormat: profile === 'gemini',
        resolution,
        images: input.images,
        proxyUrl: cfg.proxyUrl,
        signal: input.signal,
        timeoutMs: input.budgetMs,
      })
      const dest = join(input.privateRoot, 'jobs', '_router', 'outputs')
      const path = payload.bytes !== undefined
        ? await stageImageBytes(payload.bytes, dest)
        : await downloadImageTo(String(payload.url), dest, {
            proxyUrl: cfg.proxyUrl,
            signal: input.signal,
            timeoutMs: Math.min(input.budgetMs, 120000),
          })
      return { outputPath: path, model: effectiveModel, resolution, size }
    },
  }
}

/** Dreamina image adapter (best effort; last fallback, shared seedance-cli capacity). */
function dreaminaImageAdapter(cfg: RouterConfig): ImageAdapter {
  const id = 'dreamina-image'
  const model = '4.0'
  return {
    id,
    model,
    capacityKey: 'seedance-cli',
    async checkReady() {
      try {
        await execFileAsync(cfg.dreaminaPath, ['--help'], { timeout: 10000, windowsHide: true })
        return { ready: true }
      } catch {
        return { ready: false, reason: `dreamina binary not usable: ${cfg.dreaminaPath}` }
      }
    },
    async execute(input) {
      const outDir = await ensureDir(join(input.privateRoot, 'jobs', '_router', 'outputs'))
      const resolution = (input.resolution ?? '1K').toLowerCase()
      const base = input.images.length > 0
        ? ['image2image', `--prompt=${input.prompt}`, `--model_version=${model}`, ...input.images.map((p) => `--image=${p}`)]
        : ['text2image', `--prompt=${input.prompt}`, `--model_version=${model}`]
      const args = [...base, `--ratio=${input.ratio}`, `--resolution_type=${resolution}`]
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), input.budgetMs)
      try {
        await execFileAsync(cfg.dreaminaPath, args, { timeout: input.budgetMs, windowsHide: true })
      } catch (error: any) {
        if (controller.signal.aborted) throw mediaErrors.providerTimeout(`dreamina image timed out after ${Math.round(input.budgetMs / 1000)}s`)
        throw mediaErrors.provider(`dreamina image failed: ${String(error?.stderr ?? error?.message ?? error).slice(0, 300)}`)
      } finally {
        clearTimeout(timer)
      }
      // find the newest image the CLI produced
      const files = (await readdir(outDir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).map((f) => join(outDir, f))
      if (files.length === 0) throw mediaErrors.provider('dreamina image produced no output file')
      return { outputPath: files.sort((a, b) => b.length - a.length)[0] }
    },
  }
}

/** Legacy adapter ids -> current ids (configs written against old names keep working). */
export const ADAPTER_ALIASES: Readonly<Record<string, string>> = {
  'comfly-gemini-lite': 'comfly-gemini-flash-preview',
  'comfly-gpt-image-2': 'comfly-gpt-image-2.5',
}

/** Build the default adapter chain in contract priority order (GPT 2.5 first). */
export function defaultAdapters(cfg: RouterConfig): ImageAdapter[] {
  const chain: ImageAdapter[] = [
    comflyAdapter('comfly-gpt-image-2.5', GPT_IMAGE_25_MODEL, cfg, 'gpt'),
    comflyAdapter('comfly-gemini-flash-preview', GEMINI_MODELS_BY_RESOLUTION['1K'], cfg, 'gemini'),
    dreaminaImageAdapter(cfg),
  ]
  if (!cfg.enabled || cfg.enabled.length === 0) return chain
  const enabledIds = new Set(cfg.enabled.map((id) => ADAPTER_ALIASES[id] ?? id))
  return chain.filter((a) => enabledIds.has(a.id))
}

/**
 * Resolve a user-explicit `image_provider` to exactly one adapter.
 * Unknown routes and routes disabled by config fail as input_error before
 * any provider is called. The explicit route never falls back elsewhere.
 */
function resolveExplicitAdapter(requested: string, fullChain: ImageAdapter[], enabledChain: ImageAdapter[]): ImageAdapter {
  const id = ADAPTER_ALIASES[requested] ?? requested
  const adapter = fullChain.find((a) => a.id === id)
  if (adapter === undefined) {
    throw mediaErrors.input(
      `Unsupported image_provider "${requested}"; supported routes: ${SUPPORTED_IMAGE_PROVIDERS.join(', ')}`,
    )
  }
  if (!enabledChain.some((a) => a.id === id)) {
    throw mediaErrors.input(`Requested image_provider is disabled: ${id}`)
  }
  return adapter
}

export interface RouterOutcome {
  outputPath: string
  provider: string
  model: string
  /** Resolution class actually used (the GPT 2.5 route always reports 4K). */
  resolution?: string
  /** Concrete pixel size actually submitted when the route uses pixels. */
  size?: string
  attempts: AttemptRecord[]
}

export interface RouterOptions {
  prompt: string
  /** Raw local reference paths; the router normalizes them first. */
  images: string[]
  ratio: string
  /** Optional user-selected resolution class (1K/2K/4K); adapters apply their route default otherwise. */
  resolution?: string
  /** Optional user-explicit route id; only that adapter runs without fallback. */
  imageProvider?: string
  config: RouterConfig
  workspaceRoot: string
  privateRoot: string
  signal?: AbortSignal
  taskId?: string
  /** Injectable adapter chain (defaults to the contract chain); used by tests. */
  adapters?: ImageAdapter[]
}

/** Normalize references (EXIF + ≤1920 px) into the private inputs dir. */
async function normalizeInputs(images: string[], privateRoot: string, taskId: string): Promise<string[]> {
  const out: string[] = []
  const dir = await ensureDir(join(privateRoot, 'jobs', taskId, 'inputs'))
  for (const src of images) {
    if (!src || src.trim().length === 0) throw mediaErrors.input('empty image path in reference list')
    try {
      const pipeline = sharp(src, { failOn: 'none' }).rotate()
      const meta = await pipeline.metadata()
      const w = meta.width ?? 0
      const h = meta.height ?? 0
      const longest = Math.max(w, h)
      let target = pipeline
      if (longest > 1920) {
        target = pipeline.resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
      }
      const ext = (src.split('.').pop() ?? 'png').toLowerCase().replace('jpg', 'jpeg')
      const dest = join(dir, `input-${out.length + 1}.${ext === 'jpeg' ? 'jpg' : ext}`)
      await target.toFile(dest)
      out.push(dest)
    } catch (error: any) {
      throw mediaErrors.input(`cannot read reference image ${src}: ${error?.message ?? error}`)
    }
  }
  return out
}

/**
 * Run the serial image router: validate ratio/resolution/provider, normalize
 * inputs, then attempt adapters in priority order with per-adapter budget
 * = min(120s, remaining) and a 300 s whole-task deadline, honoring
 * per-capacity slot leases. An explicit `imageProvider` restricts the run to
 * that single adapter with no cross-route fallback.
 */
export async function runImageRouter(options: RouterOptions): Promise<RouterOutcome> {
  const { prompt, images, ratio, config, privateRoot, signal, taskId = newTaskId() } = options
  ratioToSize(ratio) // throws input_error for missing/unsupported
  assertSupportedResolution(options.resolution)
  const fullChain = options.adapters ?? defaultAdapters({ ...config, enabled: [] })
  const enabledChain = options.adapters ?? defaultAdapters(config)
  const explicit = options.imageProvider ? resolveExplicitAdapter(options.imageProvider, fullChain, enabledChain) : undefined
  const adapters = explicit ? [explicit] : enabledChain
  const taskDeadline = Date.now() + config.taskTimeoutMs
  const attempts: AttemptRecord[] = []
  const startedAt = Date.now()

  const normalized = await normalizeInputs(images, privateRoot, taskId)

  for (const adapter of adapters) {
    const remaining = taskDeadline - Date.now()
    if (remaining <= 0) {
      throw mediaErrors.taskTimeout(`image task exceeded ${Math.round(config.taskTimeoutMs / 1000)}s deadline`)
    }
    const adapterBudget = Math.min(config.providerTimeoutMs, remaining)
    const attemptStart = Date.now()

    // circuit breaker: a tripped adapter skips the whole attempt during cooldown
    const circuit = await isCircuitOpen(privateRoot, adapter.id)
    if (circuit.open) {
      if (explicit) {
        throw mediaErrors.providerTimeout(`requested image_provider ${adapter.id} is in circuit cooldown`)
      }
      attempts.push({ adapter: adapter.id, model: adapter.model, status: 'skipped', failureClass: 'circuit_open', reason: 'circuit open: cooling down after repeated failures' })
      await appendSafeLog(privateRoot, 'media-router', { taskId, event: 'adapter_circuit_open', adapter: adapter.id })
      continue
    }

    // readiness gate: missing credentials / unusable binary skip without trying
    const ready = await adapter.checkReady()
    if (!ready.ready) {
      if (explicit) {
        throw mediaErrors.auth(`requested image_provider ${adapter.id} is not ready: ${ready.reason ?? 'unknown'}`)
      }
      attempts.push({ adapter: adapter.id, model: adapter.model, status: 'skipped', failureClass: 'auth_unavailable', reason: ready.reason ?? 'not ready' })
      await appendSafeLog(privateRoot, 'media-router', { taskId, event: 'adapter_skipped', adapter: adapter.id, reason: ready.reason })
      continue
    }

    // cross-process capacity lease
    let release: (() => Promise<void>) | undefined
    try {
      release = await acquireSlot(join(privateRoot, 'locks'), adapter.capacityKey, config.maxConcurrency, {
        taskId,
        timeoutMs: adapterBudget,
      })
    } catch (error: any) {
      const reason = error?.message ?? 'slot busy'
      if (explicit) {
        throw mediaErrors.providerTimeout(`requested image_provider ${adapter.id} slot busy: ${reason}`)
      }
      attempts.push({ adapter: adapter.id, model: adapter.model, status: 'timeout', failureClass: 'provider_timeout', durationMs: Date.now() - attemptStart, reason })
      continue
    }

    try {
      const result = await adapter.execute({
        prompt,
        images: normalized,
        size: ratioToSize(ratio),
        ratio,
        resolution: options.resolution,
        privateRoot,
        proxyUrl: config.proxyUrl,
        signal,
        budgetMs: adapterBudget,
      })
      const model = result.model ?? adapter.model
      await recordProviderOutcome(privateRoot, adapter.id, true)
      attempts.push({ adapter: adapter.id, model, status: 'success', durationMs: Date.now() - attemptStart })
      await appendSafeLog(privateRoot, 'media-router', { taskId, event: 'adapter_success', adapter: adapter.id, model, durationMs: Date.now() - attemptStart })
      return { outputPath: result.outputPath, provider: adapter.id, model, attempts, resolution: result.resolution, size: result.size }
    } catch (error: any) {
      let cls = 'definite_provider_failure'
      if (error instanceof MediaError) cls = error.cls
      else if (error instanceof HttpStatusError) {
        const classified = classifyHttp(error.status)
        cls = classified.cls
      }
      await recordProviderOutcome(privateRoot, adapter.id, false)
      const durationMs = Date.now() - attemptStart
      attempts.push({ adapter: adapter.id, model: adapter.model, status: cls === 'provider_timeout' ? 'timeout' : 'failed', failureClass: cls, durationMs, reason: String(error?.message ?? error).slice(0, 300) })
      await appendSafeLog(privateRoot, 'media-router', { taskId, event: 'adapter_failed', adapter: adapter.id, failureClass: cls, durationMs })
      if (explicit) throw error // explicit routes never fall back
      if (!FALLBACK_ALLOWED.has(cls as any)) throw error
      // allowed: continue to the next adapter
    } finally {
      await release?.()
    }
  }

  throw mediaErrors.provider(
    `all image providers failed after ${attempts.length} attempts (${Math.round((Date.now() - startedAt) / 1000)}s)`,
  )
}

/** Re-export helpers used by tools. */
export { sha256Text }
