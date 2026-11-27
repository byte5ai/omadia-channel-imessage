/**
 * Triggers and routines on iMessage (spec 2042 §5.12, omadia#1086).
 *
 * Two halves of one delivery path:
 *
 *  - Every answered turn opens the kernel's routines scope
 *    (`beginRoutineTurn`): who the person is and where a later delivery goes.
 *    Only then does the kernel offer the agent its trigger tools and
 *    `manage_routine`. The delivery ref is the generic channel shape naming
 *    the conversation (the sender's number; iMessage here is 1:1 only). Every
 *    agent shares the one Sendblue line, so the ref never names a bot.
 *  - The proactive send (`publishProactiveSend('imessage', …)`) delivers a
 *    trigger's or routine's message to that number through the one emitter:
 *    an agent's message carries its speaker (name line where needed), a kernel
 *    text speaks as `system`. A number the allowlist no longer names is
 *    refused, never sent to.
 */

import { isNoReply, type SpeakerHistoryStore } from '@omadia/channel-sdk';
import type { RoutinesIntegration, RoutineTurnRunner } from '@omadia/plugin-api';

import { agentAnswer, emitAnswer, systemAnswer } from './emit.js';
import type { DecorationGate } from './renderer.js';
import type { SendblueClient } from './sendblueClient.js';
import { numberRefusal } from './sendProviders.js';

/** The channel the routines file an iMessage turn under, and the sender's key. */
export const IMESSAGE_ROUTINE_CHANNEL = 'imessage';

type ProactiveSend = Parameters<RoutinesIntegration['publishProactiveSend']>[1];

/** The delivery ref an iMessage turn files: the generic channel shape. */
export interface IMessageDeliveryRef {
  readonly kind: 'channel';
  readonly channelId: string;
  readonly conversationId: string;
}

/** Opens one turn's routines scope; the runner wraps the turn body. */
export type IMessageRoutineTurn = (info: {
  readonly userId: string;
  readonly conversationId: string;
}) => RoutineTurnRunner;

export function createIMessageRoutineTurn(
  routines: Pick<RoutinesIntegration, 'beginRoutineTurn'>,
  channelId: string,
): IMessageRoutineTurn {
  return ({ userId, conversationId }) => {
    const conversationRef: IMessageDeliveryRef = { kind: 'channel', channelId, conversationId };
    // Triggers and routines only: one line shared by every agent is not where
    // the person's Conductor reminders go (as Telegram and WhatsApp).
    return routines.beginRoutineTurn({
      userId,
      channel: IMESSAGE_ROUTINE_CHANNEL,
      conversationRef,
      conductorBinding: false,
    });
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The number a delivery ref names, or undefined when it names none. */
export function parseDeliveryRef(ref: unknown): { number: string; asChannelKey: string | undefined } | undefined {
  if (!isRecord(ref)) return undefined;
  const raw = ref['conversationId'];
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const key = ref['asChannelKey'];
  const asChannelKey = typeof key === 'string' && key.trim() !== '' ? key.trim() : undefined;
  return { number: raw.trim(), asChannelKey };
}

export interface IMessageProactiveSendDeps {
  readonly client: Pick<SendblueClient, 'sendMessage'>;
  /** Digits-only allowed numbers; empty = everyone. The same list as inbound. */
  readonly allowlist: ReadonlySet<string>;
  /** The turns' speaker history, so a delivery gets a name line exactly where an answer would. */
  readonly speakerHistory: SpeakerHistoryStore;
  readonly admit?: DecorationGate;
}

export function createIMessageProactiveSend(deps: IMessageProactiveSendDeps): ProactiveSend {
  return async (conversationRef, message) => {
    const ref = parseDeliveryRef(conversationRef);
    if (!ref) throw new Error('not an iMessage delivery: the ref names no iMessage conversation');
    if (ref.asChannelKey !== undefined) {
      throw new Error(`this iMessage installation is one line and runs no bot '${ref.asChannelKey}'; nothing was sent`);
    }
    const refusal = numberRefusal(ref.number, deps.allowlist);
    if (refusal) throw new Error(`${refusal.message}; nothing was sent`);
    // "Nothing to report this run": dropped, the run history keeps the turn.
    if (isNoReply(message)) return;
    // Kernel texts (an approval request, a reminder) name no agent.
    const answer = message.speaker?.kind === 'agent' ? agentAnswer(message.text, message.speaker) : systemAnswer(message.text);
    await emitAnswer(deps.client, ref.number, answer, {
      conversationKey: ref.number,
      speakerHistory: deps.speakerHistory,
      ...(deps.admit ? { admit: deps.admit } : {}),
    });
  };
}
