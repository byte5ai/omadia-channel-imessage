import type {
  CardQuestionKind,
  CardSupport,
  ConversationSendProvider,
  QuestionCard,
  SendProviderCapabilities,
  TargetedDeliveryOutcome,
  TargetedMessage,
  TargetedPoll,
  TargetedSendProvider,
} from '@omadia/channel-sdk';
import { renderCardAsText } from '@omadia/channel-sdk';

import { numberFromPrincipal } from './agentResolution.js';
import { emitAnswer, systemAnswer } from './emit.js';
import { normalizePhone } from './inbound.js';
import { expiryOf, type OpenCards } from './openCards.js';
import type { SendblueClient, SendMessageResult } from './sendblueClient.js';

/**
 * Proactive sends into an iMessage conversation (spec 2042 §5.8, criterion 30):
 * the Facilitator's nudges, polls and question cards, Conductor reports. The
 * kernel resolves a principal to ONE user and hands the provider that user's
 * `user:custom:<number>`; a conversation is the sender's number (iMessage here
 * is 1:1 only), so both providers deliver to the same place.
 *
 * What the providers DECLARE is what they do (`SendProviderCapabilities`):
 *  - `poll`, `card`: posted as numbered plain text; the reply is matched by
 *    `matchCardReply` (inbound) and forwarded as a typed `card_answer`.
 *    One question per card: with several in one bubble a typed reply could not
 *    say which one it answers, so the kernel keeps larger cards out.
 *  - NOT `asChannelKey`: every agent shares the one Sendblue line, so a send
 *    "as agent X's own identity" cannot be guaranteed and the kernel refuses it.
 *  - NOT `mentions`, NOT `aiLabel`: iMessage has neither.
 *  - `card.update` is false: a posted bubble cannot be edited.
 *
 * Unreachability is RETURNED, never thrown (one unreachable holder must not
 * abort a fan-out).
 */

/** Question kinds a plain-text reply can carry. `assignment` needs a member roster. */
const CARD_KINDS: readonly CardQuestionKind[] = [
  'single_choice',
  'multiple_choice',
  'ranking',
  'consent',
  'text',
  'number',
  'date',
];

export const CARD_SUPPORT: CardSupport = Object.freeze({ kinds: CARD_KINDS, maxQuestions: 1, update: false });

export const SEND_CAPABILITIES: SendProviderCapabilities = Object.freeze({
  poll: true,
  card: CARD_SUPPORT,
});

const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 6;
const POLL_ID_MAX = 128;
const POLL_QUESTION_ID = 'poll';
const POLL_DEFAULT_HINT = 'Antworte mit der Nummer.';

export interface SendProviderDeps {
  client: Pick<SendblueClient, 'sendMessage' | 'sendTypingIndicator'>;
  /** Digits-only allowed numbers; empty = everyone. The same list as inbound. */
  allowlist: ReadonlySet<string>;
  openCards: OpenCards;
  now?: () => number;
}

type Unreachable = Extract<TargetedDeliveryOutcome, { outcome: 'unreachable' }>;

function unreachable(code: Unreachable['code'], message: string): Unreachable {
  return { outcome: 'unreachable', code, message };
}

/** A poll as the single-question card it is rendered and answered as. */
function pollAsCard(poll: TargetedPoll): QuestionCard | { problem: string } {
  if (poll.pollId.length === 0 || poll.pollId.length > POLL_ID_MAX) return { problem: 'pollId must be 1..128 characters' };
  if (poll.question.trim().length === 0) return { problem: 'a poll needs a question' };
  const count = poll.options.length;
  if (count < POLL_MIN_OPTIONS || count > POLL_MAX_OPTIONS) {
    return { problem: `a poll has ${String(POLL_MIN_OPTIONS)}..${String(POLL_MAX_OPTIONS)} options` };
  }
  if (new Set(poll.options.map((o) => o.id)).size !== count) return { problem: 'option ids must be unique' };
  return {
    cardId: poll.pollId,
    title: poll.question,
    questions: [
      {
        id: POLL_QUESTION_ID,
        kind: 'single_choice',
        label: poll.hint?.trim() || POLL_DEFAULT_HINT,
        options: poll.options.map((o) => ({ id: o.id, label: o.label })),
      },
    ],
  };
}

function cardProblem(card: QuestionCard): string | undefined {
  if (card.questions.length !== CARD_SUPPORT.maxQuestions) {
    return `iMessage cards carry exactly ${String(CARD_SUPPORT.maxQuestions)} question`;
  }
  const kind = card.questions[0]?.kind;
  if (kind === undefined || !CARD_SUPPORT.kinds.includes(kind)) return `question kind ${String(kind)} is not supported`;
  return undefined;
}

/** The message body: its text, then one line per attachment (no outbound media). */
function bodyText(message: TargetedMessage): string {
  const lines = (message.attachments ?? []).map((a) => `${a.altText}: ${a.url}`);
  return [message.text.trim(), ...lines].filter((part) => part.length > 0).join('\n\n');
}

class IMessageSender {
  readonly #deps: SendProviderDeps;

  constructor(deps: SendProviderDeps) {
    this.#deps = deps;
  }

  async deliverTo(number: string, message: TargetedMessage): Promise<TargetedDeliveryOutcome> {
    const { allowlist, client, openCards } = this.#deps;
    if (!/^\+?\d{6,15}$/.test(number)) return unreachable('user_not_found', 'not an iMessage number');
    if (allowlist.size > 0 && !allowlist.has(normalizePhone(number))) {
      return unreachable('not_permitted', 'the number is not on this channel\'s allowlist');
    }
    if (message.poll && message.card) {
      return unreachable('channel_error', 'a message carries a poll or a question card, not both');
    }
    const asked = message.poll ? pollAsCard(message.poll) : message.card;
    if (asked && 'problem' in asked) return unreachable('channel_error', `invalid poll: ${asked.problem}`);
    const problem = asked ? cardProblem(asked) : undefined;
    if (asked && problem) return unreachable('channel_error', problem);

    const bubbles = [bodyText(message), asked ? renderCardAsText(asked) : ''].filter((b) => b.length > 0);
    if (bubbles.length === 0) return unreachable('channel_error', 'nothing to send');
    const handles: string[] = [];
    try {
      for (const text of bubbles) {
        await emitAnswer(
          client,
          number,
          systemAnswer(text),
          { conversationKey: number },
          { onSent: (result: SendMessageResult) => handles.push(String(result.message_handle ?? '')) },
        );
      }
    } catch (err) {
      return unreachable('channel_error', err instanceof Error ? err.message : String(err));
    }

    const now = (this.#deps.now ?? Date.now)();
    const question = asked?.questions[0];
    const lastHandle = handles[handles.length - 1] ?? '';
    const cardMessageId = lastHandle.length > 0 ? lastHandle : `imessage:${asked?.cardId ?? ''}:${String(now)}`;
    if (asked && question) {
      openCards.open(number, {
        kind: message.poll ? 'poll' : 'card',
        cardId: asked.cardId,
        cardMessageId,
        question,
        prompt: renderCardAsText(asked),
        ...(asked.proposalId !== undefined ? { proposalId: asked.proposalId } : {}),
        ...(asked.proposalVersion !== undefined ? { proposalVersion: asked.proposalVersion } : {}),
        expiresAt: expiryOf(asked, now),
      });
    }
    return {
      outcome: 'delivered',
      ...(lastHandle.length > 0 ? { messageId: lastHandle } : {}),
      ...(asked ? { cardMessageId } : {}),
      conversationId: number,
    };
  }

  async typing(number: string): Promise<void> {
    await this.#deps.client.sendTypingIndicator(number);
  }
}

/** DM one participant: `principalId` is `user:custom:<number>`. */
export function createTargetedSendProvider(deps: SendProviderDeps): TargetedSendProvider {
  const sender = new IMessageSender(deps);
  return {
    channelType: 'imessage',
    supports: SEND_CAPABILITIES,
    async sendToUser(target, message) {
      const number = numberFromPrincipal(target.principalId);
      if (number === undefined) return unreachable('user_not_found', 'not an iMessage principal');
      return sender.deliverTo(number, message);
    },
  };
}

/** Post into a conversation: here the sender's number, the only kind there is. */
export function createConversationSendProvider(deps: SendProviderDeps): ConversationSendProvider {
  const sender = new IMessageSender(deps);
  return {
    channelType: 'imessage',
    supports: SEND_CAPABILITIES,
    async sendToConversation(conversationId, message) {
      return sender.deliverTo(conversationId.trim(), message);
    },
    async sendTyping(conversationId) {
      await sender.typing(conversationId.trim());
    },
  };
}
