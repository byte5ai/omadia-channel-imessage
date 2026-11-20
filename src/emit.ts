import type { AgentSpeaker, SemanticAnswer, Speaker, SystemNotice } from '@omadia/channel-sdk';

import { renderAnswerParts, type RenderOptions } from './renderer.js';
import type { SendblueClient, SendMessageResult } from './sendblueClient.js';

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

/**
 * An answer that reached the emitter without a speaker. It is NOT sent: a path
 * that cannot name its speaker cannot emit (spec 2042 §5.5), and guessing one
 * would put words under a name nobody chose. The caller answers with a
 * `system` notice instead (fail-closed).
 */
export class MissingSpeakerError extends Error {
  constructor() {
    super('iMessage answer has no speaker and none was resolved before the turn');
    this.name = 'MissingSpeakerError';
  }
}

export interface EmitHooks {
  /** Called with the provider's reply for every bubble that was sent. */
  onSent?: (result: SendMessageResult) => void;
}

/**
 * A notice of the channel or the management layer: speaker `system`, never
 * under an agent's name. `notice` is the kernel's own notice (or the channel's, with one of the
 * registered codes) when there is one.
 */
export function systemAnswer(text: string, notice?: SystemNotice): SemanticAnswer {
  return { text, speaker: SYSTEM, ...(notice ? { systemNotice: notice } : {}) };
}

/** An agent's own words, e.g. the pace acknowledgement, under its speaker. */
export function agentAnswer(text: string, speaker: AgentSpeaker): SemanticAnswer {
  return { text, speaker };
}

/**
 * The answer with the speaker the resolver named before the turn filled in
 * when the answer carries none. An answer's own speaker always wins (a
 * `system` notice must stay one). `undefined` when neither names a speaker.
 */
export function stampSpeaker(answer: SemanticAnswer, resolved: AgentSpeaker | undefined): SemanticAnswer | undefined {
  if (answer.speaker !== undefined) return answer;
  return resolved ? { ...answer, speaker: resolved } : undefined;
}

/**
 * Send one answer to `number` as the bubbles the renderer produces, in order
 * (sequential on purpose: a bare-URL bubble has to land after the text).
 * Returns the ids of the registry decorations that were attached. Throws
 * {@link MissingSpeakerError} before sending anything for an unstamped answer.
 */
export async function emitAnswer(
  client: Pick<SendblueClient, 'sendMessage'>,
  number: string,
  answer: SemanticAnswer,
  render: RenderOptions,
  hooks: EmitHooks = {},
): Promise<readonly string[]> {
  if (answer.speaker === undefined) throw new MissingSpeakerError();
  const { bubbles, decorations } = renderAnswerParts(answer, render);
  for (const content of bubbles) {
    // Awaited first: an optional call does not evaluate its arguments when the hook is absent.
    const result = await client.sendMessage({ number, content });
    hooks.onSent?.(result);
  }
  return decorations;
}
