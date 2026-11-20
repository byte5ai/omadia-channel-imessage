import type {
  ConversationSendProvider,
  TargetedDeliveryOutcome,
  TargetedMessage,
  TargetedSendProvider,
} from '@omadia/channel-sdk';

import { numberFromPrincipal } from './agentResolution.js';
import { emitAnswer, systemAnswer } from './emit.js';
import { normalizePhone } from './inbound.js';
import type { SendblueClient } from './sendblueClient.js';

/**
 * Proactive sends into an iMessage conversation (spec 2042 §5.8): the
 * Facilitator's nudges, Conductor reports. The kernel resolves a principal to
 * ONE user and hands the provider that user's `user:custom:<number>`; a
 * conversation is the sender's number (iMessage here is 1:1 only), so both
 * providers deliver to the same place.
 *
 * What the providers DECLARE is what they do, which is plain text: no `poll`,
 * no `card`, no `asChannelKey`, no `mentions`, no `aiLabel`. A poll or question
 * card needs no code here: the kernel posts one that a channel does not show
 * natively as numbered text through `sendToConversation` and turns a typed
 * reply into the `card_answer` itself. This channel only has to report its
 * inbound messages as `created` events (`conversationEvents.ts`). Every agent
 * shares the one Sendblue line, so a send "as agent X's own identity" cannot be
 * guaranteed and the kernel refuses it.
 *
 * Unreachability is RETURNED, never thrown (one unreachable holder must not
 * abort a fan-out).
 */

export interface SendProviderDeps {
  client: Pick<SendblueClient, 'sendMessage' | 'sendTypingIndicator'>;
  /** Digits-only allowed numbers; empty = everyone. The same list as inbound. */
  allowlist: ReadonlySet<string>;
}

type Unreachable = Extract<TargetedDeliveryOutcome, { outcome: 'unreachable' }>;

function unreachable(code: Unreachable['code'], message: string): Unreachable {
  return { outcome: 'unreachable', code, message };
}

/** The message body: its text, then one line per attachment (no outbound media). */
function bodyText(message: TargetedMessage): string {
  const lines = (message.attachments ?? []).map((a) => `${a.altText}: ${a.url}`);
  return [message.text.trim(), ...lines].filter((part) => part.length > 0).join('\n\n');
}

async function deliverTo(deps: SendProviderDeps, number: string, message: TargetedMessage): Promise<TargetedDeliveryOutcome> {
  if (!/^\+?\d{6,15}$/.test(number)) return unreachable('user_not_found', 'not an iMessage number');
  if (deps.allowlist.size > 0 && !deps.allowlist.has(normalizePhone(number))) {
    return unreachable('not_permitted', "the number is not on this channel's allowlist");
  }
  // Not declared, so the kernel does not hand them over; refuse rather than
  // drop silently should one arrive anyway.
  if (message.poll || message.card) {
    return unreachable('channel_error', 'iMessage declares no poll or card support: the kernel sends them as text');
  }
  const text = bodyText(message);
  if (text.length === 0) return unreachable('channel_error', 'nothing to send');
  let handle: string | undefined;
  try {
    await emitAnswer(deps.client, number, systemAnswer(text), { conversationKey: number }, {
      onSent: (result) => {
        handle = typeof result.message_handle === 'string' && result.message_handle.length > 0 ? result.message_handle : handle;
      },
    });
  } catch (err) {
    return unreachable('channel_error', err instanceof Error ? err.message : String(err));
  }
  return { outcome: 'delivered', ...(handle ? { messageId: handle } : {}), conversationId: number };
}

/** DM one participant: `principalId` is `user:custom:<number>`. */
export function createTargetedSendProvider(deps: SendProviderDeps): TargetedSendProvider {
  return {
    channelType: 'imessage',
    async sendToUser(target, message) {
      const number = numberFromPrincipal(target.principalId);
      if (number === undefined) return unreachable('user_not_found', 'not an iMessage principal');
      return deliverTo(deps, number, message);
    },
  };
}

/** Post into a conversation: here the sender's number, the only kind there is. */
export function createConversationSendProvider(deps: SendProviderDeps): ConversationSendProvider {
  return {
    channelType: 'imessage',
    async sendToConversation(conversationId, message) {
      return deliverTo(deps, conversationId.trim(), message);
    },
    async sendTyping(conversationId) {
      await deps.client.sendTypingIndicator(conversationId.trim());
    },
  };
}
