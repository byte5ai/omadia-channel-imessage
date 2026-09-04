/**
 * Shared, in-memory channel state. A single instance is created in
 * `activate()` and read by the admin router (to render channel status) and
 * written by the webhook handler / outbound send path.
 *
 * It is intentionally a plain mutable object — there is exactly one logical
 * writer at a time and N readers (admin-UI poll requests), and the fields are
 * independent scalars, so no locking is needed.
 */

export type ConnectionStatus =
  | 'starting' // activate() called, webhook route not yet mounted
  | 'connected' // config validated + webhook route mounted (webhook-only channel: there is no long-lived connection to watch)
  | 'error'; // an outbound send failed (see lastError); cleared by the next success

/** The configured Sendblue line this channel sends from. */
export interface IMessageIdentity {
  /** Sendblue line in E.164 (the `from_number` setup field). */
  fromNumber: string;
}

export interface ChannelState {
  status: ConnectionStatus;
  /** The configured Sendblue line, or null before config is read. */
  me: IMessageIdentity | null;
  /** Last error message surfaced to the operator, or null. Outbound send
   *  failures land here — Sendblue has no auth handshake, so a bad API key
   *  pair only ever manifests at send time. */
  lastError: string | null;
  /** At least one authenticated webhook delivery arrived, i.e. the receive
   *  URL registered in the Sendblue dashboard (incl. the secret) is correct.
   *  Sendblue has no url_verification handshake — live traffic is the proof. */
  webhookVerified?: boolean;
  /** Epoch-ms of the last authenticated webhook delivery — concrete proof the
   *  channel is receiving traffic (messages AND status callbacks count). */
  lastInboundAt?: number;
  /** Epoch-ms of the last state transition — lets the UI show "x s ago". */
  updatedAt: number;
}

export function createChannelState(): ChannelState {
  return {
    status: 'starting',
    me: null,
    lastError: null,
    updatedAt: Date.now(),
  };
}

/** Apply a partial update and bump `updatedAt` in one place. */
export function patchState(state: ChannelState, patch: Partial<ChannelState>): void {
  Object.assign(state, patch);
  state.updatedAt = Date.now();
}
