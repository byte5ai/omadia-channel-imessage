import type { SemanticAnswer, Speaker, SystemNotice } from '@omadia/channel-sdk';

import { renderAnswerParts, type RenderOptions } from './renderer.js';
import type { SendblueClient } from './sendblueClient.js';

/**
 * The one emitter of this channel (spec 2042 criterion 5). Every user-visible
 * message, an agent's answer or a notice of the channel itself, is a
 * {@link SemanticAnswer} that carries its speaker and leaves through
 * {@link emitAnswer}. Nothing else in this plugin calls `sendMessage`;
 * `tests/emitters.test.ts` enumerates the call sites and fails on a new one.
 */

// The one `system` speaker value (plugin-api's `SYSTEM_SPEAKER`; the plugin
// keeps plugin-api type-only, so the literal is spelled out here).
const SYSTEM: Speaker = Object.freeze({ kind: 'system' });

export interface EmitHooks {
  /** Called for an answer that arrives without a speaker (a kernel that predates the contract). */
  onUnstamped?: () => void;
}

/**
 * A notice of the channel or the management layer: speaker `system`, never
 * under an agent's name. `notice` is the kernel's own notice (or the channel's, with one of the
 * registered codes) when there is one.
 */
export function systemAnswer(text: string, notice?: SystemNotice): SemanticAnswer {
  return { text, speaker: SYSTEM, ...(notice ? { systemNotice: notice } : {}) };
}

/**
 * Send one answer to `number` as the bubbles the renderer produces, in order
 * (sequential on purpose: a bare-URL bubble has to land after the text).
 * Returns the ids of the registry decorations that were attached.
 */
export async function emitAnswer(
  client: SendblueClient,
  number: string,
  answer: SemanticAnswer,
  render: RenderOptions,
  hooks: EmitHooks = {},
): Promise<readonly string[]> {
  if (answer.speaker === undefined) hooks.onUnstamped?.();
  const { bubbles, decorations } = renderAnswerParts(answer, render);
  for (const content of bubbles) {
    await client.sendMessage({ number, content });
  }
  return decorations;
}
