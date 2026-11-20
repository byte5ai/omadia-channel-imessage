import type { ConversationMessageEvent } from '@omadia/channel-sdk';

import type { SendbluePayload } from './inbound.js';

/**
 * An inbound iMessage as a `created` conversation message (spec 2042
 * criterion 30). The kernel keeps the open question of a card or poll it posted
 * as numbered text and turns a matching typed reply into the `card_answer`
 * itself; for that it has to SEE the reply, so the channel reports every
 * accepted inbound message. The kernel stores the event only for a
 * subscription of the receiving identity and drops it otherwise.
 *
 * Every iMessage here is a direct message to the Sendblue line, so it addresses
 * the bot (`addressedToBot: true`): with one open question in the conversation
 * that is what lets a bare "2" answer it. Sendblue reports no reply-to message
 * id, so `replyToMessageId` is never set. The author is the number Sendblue
 * states, never anything from the text.
 */
export function createdEventFor(
  payload: SendbluePayload,
  input: { readonly channelId: string; readonly channelType: string; readonly line: string; readonly conversationId: string; readonly text: string; readonly now: number },
): ConversationMessageEvent {
  const handle = typeof payload.message_handle === 'string' ? payload.message_handle.trim() : '';
  const sent = typeof payload.date_sent === 'string' ? Date.parse(payload.date_sent) : Number.NaN;
  const text = input.text.trim();
  return {
    channelId: input.channelId,
    channelType: input.channelType,
    conversationId: input.conversationId,
    conversationType: 'direct',
    receivedByChannelKey: input.line,
    messageId: handle.length > 0 ? handle : `imessage:${input.conversationId}:${String(input.now)}`,
    revision: 0,
    kind: 'created',
    author: { kind: 'custom', id: input.conversationId },
    ...(text.length > 0 ? { text } : {}),
    occurredAt: new Date(Number.isFinite(sent) ? sent : input.now).toISOString(),
    addressedToBot: true,
  };
}
