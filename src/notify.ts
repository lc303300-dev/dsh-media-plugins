/**
 * Completion notification: when the agent finishes answering
 * (agent/status transitions running -> idle), show a native Windows balloon
 * with a short excerpt of the answer text. Host half only.
 *
 * Running state is tracked per agent id: a sub-agent's own lifecycle must not
 * complete the parent turn's notification, nor a sibling's start swallow it.
 *
 * Diagnostics are opt-in: set DSH_NOTIFY_DEBUG=1 in the host environment to
 * append one JSON line per status transition, spawn outcome, and failure to
 * `$DSH_NOTIFY_LOG` (default `<cwd>/.dsh-media-private/logs/completion-notify.log`).
 * The environment is read per call so a dev HMR reload cannot capture a stale value.
 * @module dsh-media-plugins/notify
 */

import type { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { packageRootOf } from './shared/pkg-root.ts'

export const name = 'Ws_completion-notify'

const PACKAGE_ROOT = packageRootOf(import.meta.url)
const TOAST_SCRIPT = join(PACKAGE_ROOT, 'scripts', 'notify-toast.ps1')

interface ContentBlockLike {
  type: string
  text?: string
}

interface MessageLike {
  role: string
  content: readonly ContentBlockLike[]
}

interface AgentLike {
  id?: string
  session: {
    deriveMessages(): readonly MessageLike[]
  }
}

interface StatusPayload {
  agent: AgentLike
  status: string
}

/** Append one diagnostic line; logging must never affect the agent. */
async function debugLog(entry: Record<string, unknown>): Promise<void> {
  if (process.env.DSH_NOTIFY_DEBUG !== '1') return
  try {
    const path = process.env.DSH_NOTIFY_LOG ?? join(process.cwd(), '.dsh-media-private', 'logs', 'completion-notify.log')
    await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch {
    // Diagnostics are best-effort; a failed write must never surface.
  }
}

/** Extract the visible text of the last assistant message. */
function extractAnswerText(agent: AgentLike): string {
  try {
    const messages = agent.session.deriveMessages()
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role !== 'assistant') continue
      const text = message.content
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text as string)
        .join('')
      if (text.trim().length > 0) return text.trim()
    }
  } catch {
    // Ignore — the notification should never fail the agent.
  }
  return ''
}

/** Show the Windows balloon notification with an answer excerpt. */
function showToast(text: string): void {
  const excerpt = text.slice(0, 60)
  const encoded = Buffer.from(excerpt, 'utf8').toString('base64')
  execFile(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TOAST_SCRIPT],
    { env: { ...process.env, NOTIFY_TEXT: encoded }, windowsHide: false },
    (error) => {
      if (error) void debugLog({ event: 'spawn-failed', message: error.message })
      else void debugLog({ event: 'spawn-completed' })
    },
  )
}

export function apply(ctx: Context): void {
  const running = new Map<string, AgentLike>()
  void debugLog({ event: 'plugin-loaded', pid: process.pid, toastScript: TOAST_SCRIPT })

  ctx.on('agent/status', ({ agent, status }: StatusPayload) => {
    const key = agent.id ?? 'default'
    if (status === 'running') {
      running.set(key, agent)
      void debugLog({ event: 'status', agent: key, status })
      return
    }
    if (status === 'idle' && running.has(key)) {
      running.delete(key)
      const answer = extractAnswerText(agent)
      void debugLog({ event: 'status', agent: key, status, chars: answer.length, excerpt: answer.slice(0, 60) })
      showToast(answer)
      return
    }
    void debugLog({ event: 'status', agent: key, status, fired: false })
  })
}
