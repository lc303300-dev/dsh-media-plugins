/**
 * Completion notification: when the agent finishes answering
 * (agent/status transitions running -> idle), show a native Windows balloon
 * with a short excerpt of the answer text. Host half only.
 * @module dsh-media-plugins/notify
 */

import type { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
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
  session: {
    deriveMessages(): readonly MessageLike[]
  }
}

interface StatusPayload {
  agent: AgentLike
  status: string
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
    { env: { ...process.env, NOTIFY_TEXT: encoded } },
    () => {
      // A missing notification must never affect the agent.
    },
  )
}

export function apply(ctx: Context): void {
  let running = false
  ctx.on('agent/status', ({ agent, status }: StatusPayload) => {
    if (status === 'running') {
      running = true
    } else if (status === 'idle' && running) {
      running = false
      showToast(extractAnswerText(agent))
    }
  })
}
