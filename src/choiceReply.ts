import type { OutgoingInteractive } from '@omadia/channel-sdk';

/**
 * The question a conversation is waiting on, kept so a typed number can be
 * turned back into the option it names (spec 2042 §5.14 channel parity: a card
 * is answered through plain text). The card is rendered as a numbered list
 * (`1) Di 10:00`); the model never saw that numbering, so a bare "2" has to be
 * resolved here, before the turn.
 *
 * In memory like the answer-link store: a restart forgets the open question,
 * and the number then reaches the agent as the text the user typed.
 */

const DEFAULT_CAP = 500;

interface PendingOption {
  readonly label: string;
  /** What a tap on the option would have sent. */
  readonly value: string;
}

function optionsOf(interactive: OutgoingInteractive): readonly PendingOption[] | undefined {
  switch (interactive.kind) {
    case 'choice':
    case 'topic': {
      const items = interactive.kind === 'choice' ? interactive.options : interactive.topics;
      return items.map((i) => ({ label: i.label, value: i.value }));
    }
    case 'slots':
      return interactive.slots.map((s) => ({ label: s.label, value: s.label }));
    default:
      return undefined;
  }
}

export class PendingChoices {
  readonly #byConversation = new Map<string, readonly PendingOption[]>();
  readonly #cap: number;

  constructor(cap: number = DEFAULT_CAP) {
    this.#cap = cap;
  }

  /** Remember the question just asked; replaces an older open one. */
  record(conversationKey: string, interactive: OutgoingInteractive | undefined): void {
    this.#byConversation.delete(conversationKey);
    const options = interactive ? optionsOf(interactive) : undefined;
    if (!options || options.length === 0) return;
    this.#byConversation.set(conversationKey, options);
    if (this.#byConversation.size > this.#cap) {
      const oldest = this.#byConversation.keys().next().value;
      if (oldest !== undefined) this.#byConversation.delete(oldest);
    }
  }

  /**
   * The reply as the turn text. A bare number that names an option becomes that
   * option's value; anything else passes unchanged. The question is consumed
   * either way: the conversation has moved on.
   */
  resolve(conversationKey: string, reply: string): string {
    const options = this.#byConversation.get(conversationKey);
    this.#byConversation.delete(conversationKey);
    const trimmed = reply.trim();
    if (!options || !/^\d{1,3}$/.test(trimmed)) return reply;
    return options[Number(trimmed) - 1]?.value ?? reply;
  }

  clear(): void {
    this.#byConversation.clear();
  }
}
