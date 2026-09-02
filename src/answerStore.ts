import { randomBytes } from 'node:crypto';

import type { OutgoingChoiceCard } from '@omadia/channel-sdk';

/**
 * In-memory store for answer-link tokens (Phase 1 of the deep-link concept).
 *
 * A `SemanticAnswer` with an interactive choice card cannot be rendered in an
 * iMessage bubble, so the renderer appends a capability URL instead: the
 * token below IS the authorization (128 bit random, delivered only to the
 * recipient's iMessage number). The store keeps the structured card
 * retrievable until the question is answered — via link tap OR via a plain
 * text reply in the conversation — or the TTL runs out.
 *
 * Lifecycle: open → answered | expired. Entries stay visible after their
 * terminal transition (so a second tap renders "already answered" / "expired"
 * instead of a bare 404) and are physically evicted by a lazy sweep once a
 * retention horizon past expiry has passed. Bounded like the webhook dedupe
 * set so a long-running channel can't grow unboundedly.
 */

export type AnswerState = 'open' | 'answered' | 'expired';

/** How an entry left the `open` state. `superseded` = a newer choice card was
 *  issued for the same conversation before this one was answered. */
export type AnsweredVia = 'link' | 'text' | 'superseded';

export interface AnswerEntry {
  readonly token: string;
  readonly conversationId: string;
  readonly choice: OutgoingChoiceCard;
  readonly createdAt: number;
  readonly expiresAt: number;
  state: AnswerState;
  answeredVia?: AnsweredVia;
  /** The chosen option's `value` — only set for `answeredVia: 'link'`. */
  answeredValue?: string;
}

export type ReplyOutcome =
  | { outcome: 'ok'; entry: AnswerEntry; option: { label: string; value: string } }
  | { outcome: 'missing' }
  | { outcome: 'conflict'; entry: AnswerEntry }
  | { outcome: 'expired'; entry: AnswerEntry }
  | { outcome: 'invalid-value'; entry: AnswerEntry };

export interface AnswerStoreOptions {
  /** Time until an open entry expires. */
  ttlMs: number;
  /** Max live entries; the oldest are evicted beyond this (insertion order). */
  cap?: number;
  /** How long a terminal entry stays readable (410 / "answered" page) before
   *  the sweep drops it to a plain 404. */
  retentionMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_CAP = 500;
const DEFAULT_RETENTION_MS = 72 * 60 * 60 * 1000;

export class AnswerStore {
  private readonly entries = new Map<string, AnswerEntry>();
  private readonly ttlMs: number;
  private readonly cap: number;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(opts: AnswerStoreOptions) {
    this.ttlMs = opts.ttlMs;
    this.cap = opts.cap ?? DEFAULT_CAP;
    this.retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Store a choice card and mint its token. Any still-open entry for the same
   * conversation is superseded first — the conversation has moved on, and two
   * competing open questions would race each other's replies.
   */
  create(conversationId: string, choice: OutgoingChoiceCard): AnswerEntry {
    this.sweep();
    this.resolveOpenForConversation(conversationId, 'superseded');
    const ts = this.now();
    const entry: AnswerEntry = {
      token: randomBytes(16).toString('base64url'),
      conversationId,
      choice,
      createdAt: ts,
      expiresAt: ts + this.ttlMs,
      state: 'open',
    };
    this.entries.set(entry.token, entry);
    if (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return entry;
  }

  /** Look up an entry, transitioning it to `expired` lazily if its TTL passed. */
  get(token: string): AnswerEntry | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    this.expireIfDue(entry);
    return entry;
  }

  /**
   * Accept a reply for `token`. Validates state and that `value` is one of
   * the card's options; on success the entry is terminally `answered`.
   * GET stays side-effect free — only this transitions state on behalf of
   * the user (Apple's link-preview crawler must never "answer").
   */
  reply(token: string, value: string): ReplyOutcome {
    const entry = this.entries.get(token);
    if (!entry) return { outcome: 'missing' };
    this.expireIfDue(entry);
    if (entry.state === 'expired') return { outcome: 'expired', entry };
    if (entry.state === 'answered') return { outcome: 'conflict', entry };
    const option = entry.choice.options.find((o) => o.value === value);
    if (!option) return { outcome: 'invalid-value', entry };
    entry.state = 'answered';
    entry.answeredVia = 'link';
    entry.answeredValue = option.value;
    return { outcome: 'ok', entry, option };
  }

  /**
   * Terminally resolve every open entry of a conversation. Called when a
   * plain-text inbound message arrives (the user answered in iMessage — the
   * pending card is moot) and before issuing a new card (`superseded`).
   */
  resolveOpenForConversation(conversationId: string, via: AnsweredVia): number {
    let resolved = 0;
    for (const entry of this.entries.values()) {
      if (entry.conversationId !== conversationId) continue;
      this.expireIfDue(entry);
      if (entry.state !== 'open') continue;
      entry.state = 'answered';
      entry.answeredVia = via;
      resolved += 1;
    }
    return resolved;
  }

  clear(): void {
    this.entries.clear();
  }

  private expireIfDue(entry: AnswerEntry): void {
    if (entry.state === 'open' && this.now() >= entry.expiresAt) {
      entry.state = 'expired';
    }
  }

  /** Drop entries whose retention horizon (expiry + retention) has passed. */
  private sweep(): void {
    const horizon = this.now() - this.retentionMs;
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt < horizon) this.entries.delete(token);
    }
  }
}
