/**
 * Video creative gate: every video prompt written for production must be
 * produced by `creative_writer` in this workspace within the credential TTL
 * (24 h). The Agent still has the final fallback: when the user supplied the
 * prompt verbatim (normalize-only), or when creative_writer is unavailable /
 * failed after one attempt, the caller may opt out explicitly — but must say
 * why, and the bypass is recorded in the tool result.
 *
 * Image prompts are intentionally out of scope: they still follow the Agent /
 * business-skill authoring path.
 *
 * @module dsh-media-plugins/shared/video-creative-gate
 */

import { join } from 'node:path'
import {
  CREATIVE_LEDGER_FILE,
  decideCreativeGate,
  parseCreativeLedger,
  type CreativeRecord,
} from './creative-ledger.ts'
import { readJsonSafe, resolvePrivateRoot } from './private-runtime.ts'

export interface VideoCreativeGateInput {
  /** Session workspace root (the ledger lives under `<root>/.dsh-media-private`). */
  workspaceRoot: string
  /** Plugin private dir override, same value the tools use. */
  privateDir?: string
  /** Explicit opt-out (user-supplied prompt / normalize-only). */
  allowManual?: boolean
  /** Required when `allowManual` is true; must state why. */
  manualReason?: string
}

export interface VideoCreativeGateDecision {
  allowed: boolean
  bypassed: boolean
  record?: CreativeRecord
  message?: string
}

/** Human-facing guidance appended to gate failures. */
export const VIDEO_CREATIVE_GATE_HINT =
  'Call creative_writer (kind=prompt/script) first. If the user supplied the prompt verbatim (normalize-only), '
  + 'or creative_writer is unavailable / failed after one attempt, the Agent may write the prompt as the FINAL '
  + 'fallback: pass allow_manual_prompts=true with manual_prompts_reason explaining which case applies. '
  + 'The bypass is recorded in the result — do not use it silently.'

/**
 * Evaluate the gate against this workspace's creative ledger.
 * A bypass without a non-empty reason is refused outright.
 */
export async function evaluateVideoCreativeGate(
  input: VideoCreativeGateInput,
): Promise<VideoCreativeGateDecision> {
  const allowManual = input.allowManual === true
  const reason = String(input.manualReason ?? '').trim()
  if (allowManual && reason.length === 0) {
    return {
      allowed: false,
      bypassed: false,
      message: 'allow_manual_prompts=true requires manual_prompts_reason (state whether this is user-supplied/normalize-only, or the Agent fallback after creative_writer failed/unavailable)',
    }
  }
  const privateRoot = resolvePrivateRoot(input.workspaceRoot, input.privateDir ?? '')
  const ledger = parseCreativeLedger(await readJsonSafe(join(privateRoot, CREATIVE_LEDGER_FILE)))
  return decideCreativeGate(ledger, { allowManual })
}
