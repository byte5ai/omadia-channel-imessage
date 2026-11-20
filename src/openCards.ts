import type { CardQuestion, QuestionCard } from '@omadia/channel-sdk';

/**
 * The question card (or poll) a conversation was last asked, kept so a typed
 * reply can be turned back into the typed answer it names (spec 2042 §5.14
 * channel parity, criterion 30). iMessage cannot render a card: it is posted as
 * numbered text (`renderCardAsText`) and answered in text (`parseCardReply`).
 *
 * Only single-question cards are offered (see `CARD_SUPPORT`): with several
 * questions in one bubble a typed reply could not say which one it answers.
 *
 * In memory like the answer-link store: a restart forgets the open question,
 * and the reply then reaches the agent as the text the user typed.
 */

const DEFAULT_CAP = 500;
/** How long an open question without a `closesAt` waits for its answer. */
export const OPEN_CARD_TTL_MS = 24 * 60 * 60 * 1000;
/** A reply that does not fit is asked again once; the second one is ordinary text. */
export const MAX_REPLY_ATTEMPTS = 2;

export interface OpenCard {
  /** A poll answers as `{ optionId }`, a card as typed `answers`. */
  readonly kind: 'poll' | 'card';
  readonly cardId: string;
  /** The platform id of the posted question: `messageId` of the answer event. */
  readonly cardMessageId: string;
  readonly question: CardQuestion;
  /** The posted question text, repeated when a reply does not fit. */
  readonly prompt: string;
  readonly proposalId?: string;
  readonly proposalVersion?: number;
  readonly expiresAt: number;
}

interface Entry {
  readonly card: OpenCard;
  attempts: number;
}

export class OpenCards {
  readonly #byConversation = new Map<string, Entry>();
  readonly #cap: number;

  constructor(cap: number = DEFAULT_CAP) {
    this.#cap = cap;
  }

  /** Remember the question just posted; replaces an older open one. */
  open(conversationKey: string, card: OpenCard): void {
    this.#byConversation.delete(conversationKey);
    this.#byConversation.set(conversationKey, { card, attempts: 0 });
    if (this.#byConversation.size > this.#cap) {
      const oldest = this.#byConversation.keys().next().value;
      if (oldest !== undefined) this.#byConversation.delete(oldest);
    }
  }

  /** The open question of the conversation, or `undefined` (none, or closed by time). */
  get(conversationKey: string, now: number): OpenCard | undefined {
    const entry = this.#byConversation.get(conversationKey);
    if (!entry) return undefined;
    if (entry.card.expiresAt <= now) {
      this.#byConversation.delete(conversationKey);
      return undefined;
    }
    return entry.card;
  }

  /** Count a reply that did not fit; the number of misses so far. */
  miss(conversationKey: string): number {
    const entry = this.#byConversation.get(conversationKey);
    if (!entry) return 0;
    entry.attempts += 1;
    return entry.attempts;
  }

  close(conversationKey: string): void {
    this.#byConversation.delete(conversationKey);
  }

  clear(): void {
    this.#byConversation.clear();
  }
}

/** Expiry of a card: its `closesAt` when it names a valid time, else the default wait. */
export function expiryOf(card: Pick<QuestionCard, 'closesAt'>, now: number): number {
  const closes = card.closesAt ? Date.parse(card.closesAt) : Number.NaN;
  return Number.isFinite(closes) ? closes : now + OPEN_CARD_TTL_MS;
}
