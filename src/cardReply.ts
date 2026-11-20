import {
  parseCardReply,
  type CardAnswerValue,
  type ConversationMessageEvent,
} from '@omadia/channel-sdk';

import { MAX_REPLY_ATTEMPTS, type OpenCard, type OpenCards } from './openCards.js';

/**
 * A typed reply to an open question card or poll (spec 2042 criterion 30). The
 * reply is parsed deterministically (`parseCardReply`, no model) into the same
 * typed answer a card submission would carry, so the receiver cannot tell the
 * difference.
 */

export type CardReplyOutcome =
  /** Nothing open, a command, or the question gave up: an ordinary turn. */
  | { readonly kind: 'none' }
  /** The reply answers the open question: hand `event` to the kernel. */
  | { readonly kind: 'answered'; readonly event: ConversationMessageEvent }
  /** The reply does not fit: ask again, in words (a `system` message). */
  | { readonly kind: 'retry'; readonly text: string };

export interface CardReplyContext {
  /** The emitting plugin's catalog id. */
  readonly channelId: string;
  readonly channelType: string;
  /** The Sendblue line the reply came in on: the identity that received it. */
  readonly line: string;
  readonly now: number;
}

const RETRY_INTRO = 'Das konnte ich nicht zuordnen. Bitte antworte so:';

function answerEvent(
  open: OpenCard,
  answers: readonly CardAnswerValue[],
  number: string,
  ctx: CardReplyContext,
): ConversationMessageEvent {
  const base = {
    channelId: ctx.channelId,
    channelType: ctx.channelType,
    conversationId: number,
    conversationType: 'direct' as const,
    receivedByChannelKey: ctx.line,
    messageId: open.cardMessageId,
    revision: 0,
    kind: 'card_answer' as const,
    // The number the platform states, never anything from the message text.
    author: { kind: 'custom' as const, id: number },
    occurredAt: new Date(ctx.now).toISOString(),
  };
  const first = answers[0];
  if (open.kind === 'poll' && first?.kind === 'single_choice') {
    // A poll answers as `{ optionId }`, like every channel's poll.
    return {
      ...base,
      cardAnswer: { cardId: open.cardId, value: { optionId: first.optionId }, answererVerified: true },
    };
  }
  return {
    ...base,
    cardAnswer: {
      cardId: open.cardId,
      value: { answers },
      answererVerified: true,
      ...(open.proposalId !== undefined ? { proposalId: open.proposalId } : {}),
      ...(open.proposalVersion !== undefined ? { proposalVersion: open.proposalVersion } : {}),
      answers,
    },
  };
}

/**
 * Match a message from `number` against the conversation's open question.
 * A message that starts with `/` is a command (`/agent`, `/agents`) and always
 * an ordinary turn, so the question never blocks selecting an agent. A reply
 * that does not fit is asked again once; the second miss releases the
 * question and the message goes on as ordinary text.
 */
export function matchCardReply(
  open: OpenCards,
  number: string,
  text: string,
  ctx: CardReplyContext,
): CardReplyOutcome {
  if (text.trim().startsWith('/')) return { kind: 'none' };
  const card = open.get(number, ctx.now);
  if (!card) return { kind: 'none' };
  const parsed = parseCardReply(card.question, text);
  if (parsed.ok) {
    open.close(number);
    return { kind: 'answered', event: answerEvent(card, [parsed.value], number, ctx) };
  }
  if (open.miss(number) >= MAX_REPLY_ATTEMPTS) {
    open.close(number);
    return { kind: 'none' };
  }
  return { kind: 'retry', text: `${RETRY_INTRO}\n\n${card.prompt}` };
}
