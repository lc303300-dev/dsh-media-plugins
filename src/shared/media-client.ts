/**
 * Shared OpenAI-compatible media client (Comfly / APIMart) plus image
 * download + signature validation + atomic staging. This is the single
 * HTTP entry the image adapters and the batch scheduler both use, so the
 * paid call path stays centralized (no per-tool HTTP drift).
 *
 * @module dsh-media-plugins/shared/media-client
 */

import { fetch, ProxyAgent, type Dispatcher } from 'undici'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { mediaErrors } from './failure.ts'

/** HTTP error carrying its status so adapters can classify it. */
export class HttpStatusError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpStatusError'
    this.status = status
  }
}

/** Browser-like headers; Comfly URLs may 403 or return a non-image page otherwise. */
export const DOWNLOAD_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  Referer: 'https://ai.comfly.org/',
}

/** Build an undici dispatcher honoring an explicit proxy or HTTPS_PROXY/HTTP_PROXY. */
export function proxyDispatcher(explicit?: string): Dispatcher | undefined {
  const proxy =
    explicit !== undefined && explicit.length > 0
      ? explicit
      : process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
  if (proxy === undefined || proxy.length === 0) return undefined
  try {
    return new ProxyAgent({ uri: proxy })
  } catch {
    return undefined
  }
}

/** Raster file signature check: PNG / JPEG / GIF / WEBP. */
export function hasImageSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true // PNG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true // JPEG
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true // GIF
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // RIFF...WEBP
  }
  return false
}

/** Extension for a detected signature; default .png. */
export function extensionFor(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return '.gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return '.webp'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return '.png'
  return '.png'
}

/** Parse `payload.data[0].url` with validation. */
export function extractImageUrl(payload: any): string {
  const data = payload?.data
  if (!Array.isArray(data) || data.length === 0) throw new Error('response contains no image data')
  const url = data[0]?.url
  if (typeof url !== 'string' || url.trim().length === 0) throw new Error('response contains no image URL')
  return url.trim()
}

export interface OpenAiImageOptions {
  baseURL: string
  apiKey: string
  model: string
  prompt: string
  size: string
  images?: string[]
  proxyUrl?: string
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * POST /images/generations (text) or /images/edits (with references,
 * multipart) and return the remote image URL.
 */
export async function openAiImageUrl(options: OpenAiImageOptions): Promise<string> {
  const { baseURL, apiKey, model, prompt, size, images = [], proxyUrl, signal, timeoutMs = 120000 } = options
  const dispatcher = proxyDispatcher(proxyUrl)
  const auth = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const effectiveSignal = controller.signal
    const common = { signal: effectiveSignal, ...(dispatcher === undefined ? {} : { dispatcher }) }
    let response: Response
    if (images.length > 0) {
      // Manual multipart (mirrors the Codex platform's comfly_common.multipart_body):
      // undici FormData fields are dropped by the new-api gateway through the VPN
      // proxy ("model is required"), while an explicitly bounded body works.
      const boundary = `----DshMedia${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
      const chunks: Buffer[] = []
      for (const [fieldName, fieldValue] of [
        ['model', model],
        ['prompt', prompt],
        ['n', '1'],
        ['size', size],
        ['response_format', 'url'],
      ] as Array<[string, string]>) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"\r\n\r\n${fieldValue}\r\n`, 'utf8'))
      }
      const fs = await import('node:fs/promises')
      const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
      for (const imagePath of images) {
        const name = imagePath.split(/[\\/]/).pop() ?? 'ref.png'
        const ext = (name.slice(name.lastIndexOf('.')) || '.png').toLowerCase()
        const data = await fs.readFile(imagePath)
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\nContent-Type: ${mimeMap[ext] ?? 'image/png'}\r\n\r\n`, 'ascii'))
        chunks.push(data)
        chunks.push(Buffer.from('\r\n', 'ascii'))
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`, 'ascii'))
      response = await fetch(`${baseURL.replace(/\/+$/, '')}/images/edits`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat(chunks),
        ...common,
      })
    } else {
      response = await fetch(`${baseURL.replace(/\/+$/, '')}/images/generations`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ model, prompt, n: 1, size, response_format: 'url' }),
        ...common,
      })
    }
    if (!response.ok) throw new HttpStatusError(response.status, `image request failed with HTTP ${response.status}`)
    return extractImageUrl(await response.json())
  } catch (error: any) {
    if (signal?.aborted) throw error
    if (timedOut) {
      throw mediaErrors.timeoutBeforeSubmit(
        `provider ${model} did not return an image within ${Math.round(timeoutMs / 1000)}s`,
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Download a remote image, validate its signature, stage atomically. */
export async function downloadImageTo(
  url: string,
  destDir: string,
  options: { proxyUrl?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const { proxyUrl, signal, timeoutMs = 120000 } = options
  const dispatcher = proxyDispatcher(proxyUrl)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const download = await fetch(url, {
      headers: DOWNLOAD_HEADERS,
      signal: controller.signal,
      ...(dispatcher === undefined ? {} : { dispatcher }),
    })
    if (!download.ok) throw new Error(`image download failed with HTTP ${download.status}`)
    const bytes = new Uint8Array(await download.arrayBuffer())
    if (!hasImageSignature(bytes)) throw new Error('downloaded content is not a valid image')
    await mkdir(destDir, { recursive: true })
    const finalPath = join(destDir, `img-${Date.now()}${extensionFor(bytes)}`)
    const tmpPath = `${finalPath}.tmp`
    await writeFile(tmpPath, bytes)
    await rename(tmpPath, finalPath)
    return finalPath
  } catch (error: any) {
    if (signal?.aborted) throw error
    if (timedOut) throw mediaErrors.download(`image download timed out after ${Math.round(timeoutMs / 1000)}s`)
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** True when a path is absolute (Windows or POSIX). */
export function isAbsolutePath(p: string): boolean {
  return isAbsolute(p)
}

export { dirname }
