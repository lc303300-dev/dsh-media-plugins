/**
 * Model-facing `generate_image` tool: text-to-image and image-to-image via the
 * Comfly Gemini image API (`gemini-3.1-flash-image-preview`). Downloads the
 * returned image, validates its file signature, writes it atomically under the
 * workspace, and returns the absolute path.
 * @module @deepseek-ai/dsh-tool-image-gen
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { ProxyAgent } from 'undici'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-image-gen'

/** Services required by the image-generation tool. */
export const inject = ['tools', 'fs', 'credentials']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Comfly API base; defaults to the public endpoint. */
  baseURL?: string
  /** Image model id. */
  model?: string
  /** Credential reference (environment-variable name) resolved per request. */
  credentialEnv?: string
  /** Output directory, resolved against the process working directory. */
  outputDir?: string
  /** Explicit proxy URL (e.g. http://127.0.0.1:7897); falls back to HTTPS_PROXY/HTTP_PROXY. */
  proxyUrl?: string
}

export const Config: z<Config> = z.object({
  baseURL: z.string().default('https://ai.comfly.org/v1'),
  model: z.string().default('gemini-3.1-flash-image-preview'),
  credentialEnv: z.string().default('COMFLY_API_KEY'),
  outputDir: z.string().default('outputs'),
  proxyUrl: z.string().default(''),
})

type ResolvedConfig = Required<Config>

/** 1K-only size allowlist: user-facing ratio → pixel size. */
const SIZE_MAP: Readonly<Record<string, string>> = {
  '1:1': '1024x1024',
  '2:3': '848x1264',
  '3:2': '1264x848',
  '3:4': '896x1200',
  '4:3': '1200x896',
  '4:5': '928x1152',
  '5:4': '1152x928',
  '9:16': '768x1376',
  '16:9': '1376x768',
  '21:9': '1584x672',
}

const VALID_SIZES: ReadonlySet<string> = new Set(Object.values(SIZE_MAP))

const MEDIA: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/** Comfly result URLs may require browser-like headers, else 403 or a non-image page. */
const DOWNLOAD_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36',
  'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'Referer': 'https://ai.comfly.org/',
}

/** Resolve a ratio or a literal pixel size to an allowlisted 1K size. */
function resolveSize(input: string | undefined): string {
  const value = (input ?? '1:1').trim()
  const mapped = SIZE_MAP[value]
  if (mapped !== undefined) return mapped
  if (VALID_SIZES.has(value)) return value
  throw new Error(`unsupported size "${value}"; use a ratio (1:1, 16:9, …) or an allowlisted pixel size`)
}

function mediaTypeForPath(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : ''
  return MEDIA[ext] ?? 'image/png'
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/')
  const back = path.lastIndexOf('\\')
  return path.slice(Math.max(slash, back) + 1)
}

/** Detect a raster file signature; returns true only for PNG/JPEG/GIF/WEBP. */
function hasImageSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  }
  return false
}

/** Pick the file extension matching the detected signature. */
function extensionFor(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return '.png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return '.gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return '.webp'
  return '.png'
}

/** Parse `payload.data[0].url` with the documented validation. */
async function extractImageUrl(response: Response): Promise<string> {
  if (!response.ok) {
    throw new Error(`Comfly image request failed with HTTP ${response.status}`)
  }
  const payload = await response.json() as { data?: unknown }
  const data = payload.data
  if (!Array.isArray(data) || data.length === 0) throw new Error('Comfly response contains no image data')
  const first = data[0] as { url?: unknown }
  const url = first.url
  if (typeof url !== 'string' || url.trim().length === 0) throw new Error('Comfly response contains no image URL')
  return url.trim()
}

/** Build an undici dispatcher honoring an explicit proxy or HTTPS_PROXY/HTTP_PROXY. */
function proxyDispatcher(explicit: string | undefined): ProxyAgent | undefined {
  const proxy = explicit !== undefined && explicit.length > 0
    ? explicit
    : process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
  if (proxy === undefined || proxy.length === 0) return undefined
  try {
    return new ProxyAgent({ uri: proxy })
  } catch {
    return undefined
  }
}

/** Register the `generate_image` tool. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const dispatcher = proxyDispatcher(resolved.proxyUrl || undefined)

  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: '用 Comfly Gemini 图片模型（gemini-3.1-flash-image-preview）生成或编辑图片，下载并保存到 workspace/outputs，返回图片的绝对路径。文生图传 prompt；图生图再传 image 参考图路径列表（顺序有语义）。',
    parameters: {
      prompt: { type: 'string', required: true, description: '生成/编辑提示词，UTF-8，不能为空。' },
      size: { type: 'string', description: '输出比例或像素尺寸，如 1:1、16:9、1024x1024；省略默认 1:1。仅支持 1K 白名单尺寸。' },
      image: { type: 'array', items: { type: 'string' }, description: '可选：图生图参考图路径列表（PNG/JPEG/WEBP），按语义顺序排列。' },
      output: { type: 'string', description: '可选输出路径（绝对路径，或相对会话工作目录的路径）。指定后该产出文件可被点击打开；省略则用自动文件名。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          size: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: `generated image: ${value.path} (${value.size})` }]
      },
    },
    async execute(args, exec) {
      const prompt = args.prompt.trim()
      if (prompt.length === 0) throw new Error('prompt must be a non-empty string')
      const size = resolveSize(args.size)

      const hit = await ctx.credentials.resolve(credentialRef(resolved.credentialEnv))
      const apiKey = hit?.value
      if (apiKey === undefined || apiKey.length === 0) {
        throw new Error(`missing credential ${resolved.credentialEnv}; store it through the credentials service or export it`)
      }

      const baseURL = resolved.baseURL.replace(/\/+$/, '')
      const auth = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
      const images = args.image ?? []

      let imageUrl: string
      if (images.length > 0) {
        const form = new FormData()
        form.append('model', resolved.model)
        form.append('prompt', prompt)
        form.append('n', '1')
        form.append('size', size)
        form.append('response_format', 'url')
        for (const imagePath of images) {
          const target = await ctx.fs.resolve(imagePath)
          const data = await ctx.fs.readBytes(target, exec.signal, 10 * 1024 * 1024)
          const mediaType = mediaTypeForPath(imagePath)
          form.append('image', new Blob([data as BlobPart], { type: mediaType }), basename(imagePath))
        }
        const response = await fetch(`${baseURL}/images/edits`, {
          method: 'POST',
          headers: auth,
          body: form,
          signal: exec.signal,
          ...(dispatcher === undefined ? {} : { dispatcher }),
        })
        imageUrl = await extractImageUrl(response)
      } else {
        const response = await fetch(`${baseURL}/images/generations`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ model: resolved.model, prompt, n: 1, size, response_format: 'url' }),
          signal: exec.signal,
          ...(dispatcher === undefined ? {} : { dispatcher }),
        })
        imageUrl = await extractImageUrl(response)
      }

      const download = await fetch(imageUrl, {
        headers: DOWNLOAD_HEADERS,
        signal: exec.signal,
        ...(dispatcher === undefined ? {} : { dispatcher }),
      })
      if (!download.ok) throw new Error(`image download failed with HTTP ${download.status}`)
      const bytes = new Uint8Array(await download.arrayBuffer())
      if (!hasImageSignature(bytes)) throw new Error('downloaded content is not a valid image')

      const workspaceRoot = exec.agent?.session.header.cwd ?? process.cwd()
      const requested = args.output?.trim()
      let finalPath: string
      if (requested !== undefined && requested.length > 0) {
        finalPath = isAbsolute(requested) ? requested : join(workspaceRoot, requested)
      } else {
        const dir = join(workspaceRoot, resolved.outputDir)
        await mkdir(dir, { recursive: true })
        finalPath = join(dir, `generated-${Date.now()}-${Math.floor(Math.random() * 1e6)}${extensionFor(bytes)}`)
      }
      await mkdir(dirname(finalPath), { recursive: true })
      const tmpPath = `${finalPath}.tmp`
      await writeFile(tmpPath, bytes)
      await rename(tmpPath, finalPath)

      return { path: finalPath, size }
    },
    presentCall(args): GenericCallView | undefined {
      const requested = args.output?.trim()
      if (requested === undefined || requested.length === 0) return undefined
      return {
        card: 'generic',
        kind: 'edit',
        title: `生成图片 ${requested}`,
        locations: [{ path: requested }],
      }
    },
  }))
}
