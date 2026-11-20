import {
  CHANNEL_RESOLVER_SERVICE,
  channelUserPrincipal,
  type AgentSpeaker,
  type ChannelBindingResolver,
  type ChannelResolveResult,
  type ChannelRouteContext,
  type ChatAgent,
  type SystemNotice,
} from '@omadia/channel-sdk';

/**
 * Which agent a turn belongs to (spec 2042 §5.6, INV-1/6/7). The kernel's
 * `channelResolver@1` decides; this module only asks it for the keys an
 * iMessage conversation has and turns the answers into one route.
 *
 * The decision is `bound` or `reject`; there is no fallback agent. A `reject`
 * still carries the resolver's ChatAgent: it carries out `/agent <name>`,
 * `/agent` and `/agents` itself and answers everything else with the `system`
 * notice. The channel passes the text through and never parses those commands.
 */

export { CHANNEL_RESOLVER_SERVICE };
export type { ChannelBindingResolver, ChannelResolveResult, ChannelRouteContext };

/**
 * The agent answers. `speaker` is who the resolver named before the answer
 * (absent on a host without a resolver, where the deployment's one
 * orchestrator answers and the answer has to carry its own speaker).
 */
export interface AgentRoute {
  readonly kind: 'agent';
  readonly agent: ChatAgent;
  readonly speaker?: AgentSpeaker;
}

/**
 * No agent answers this turn. `agent` is the resolver's ChatAgent (it handles
 * the `/agent` commands and speaks as `system`), `notice` says why.
 */
export interface RefusedRoute {
  readonly kind: 'refused';
  readonly reason: 'unassigned' | 'agent_unavailable';
  readonly agent?: ChatAgent;
  readonly notice?: SystemNotice;
}

/** The resolver threw, so whether an agent exists is unknown. */
export interface FailedRoute {
  readonly kind: 'resolver-failed';
  readonly error: string;
}

export type TurnRoute = AgentRoute | RefusedRoute | FailedRoute;

/**
 * Resolve a turn's agent. `channelKeys` are tried most specific first (the
 * sender's number, then the line). The first key that resolves `bound` decides.
 *
 * A reject that names an agent (disabled, deleted, not available to the
 * sender; any notice but `no_agent`) ends the search: the addressed agent
 * answers or nobody does, a later key must never put another agent in its
 * place (INV-7). A reject for "nothing addressed" (`no_agent`, or no notice)
 * lets the next key try. When no key binds, the FIRST reject is the answer:
 * the sender's key is where `/agent <name>` stores a selection.
 *
 * `defaultAgent` answers only when the resolver is NOT published, a
 * single-Agent host where it is the deployment's one orchestrator.
 */
export function resolveAgentForTurn(
  resolver: ChannelBindingResolver | undefined,
  channelType: string,
  channelKeys: ReadonlyArray<string | null | undefined>,
  defaultAgent: ChatAgent,
  context: ChannelRouteContext = {},
): TurnRoute {
  if (!resolver) return { kind: 'agent', agent: defaultAgent };
  let firstReject: ChannelResolveResult | undefined;
  try {
    for (const key of channelKeys) {
      if (!key) continue;
      const result = resolver.resolve(channelType, key, context);
      if (result.decision === 'bound' && result.chatAgent) {
        return {
          kind: 'agent',
          agent: result.chatAgent,
          ...(result.speaker ? { speaker: result.speaker } : {}),
        };
      }
      if (result.notice && result.notice.code !== 'no_agent') {
        return refusal('agent_unavailable', result);
      }
      firstReject ??= result;
    }
  } catch (err) {
    return { kind: 'resolver-failed', error: err instanceof Error ? err.message : String(err) };
  }
  return refusal('unassigned', firstReject);
}

function refusal(reason: RefusedRoute['reason'], result: ChannelResolveResult | undefined): RefusedRoute {
  // Only a real `reject` hands over its ChatAgent. Anything else that is not
  // `bound` (a legacy `fallback` from a platform that predates the contract)
  // is a refusal without an agent: its ChatAgent must not see the text.
  const rejectAgent = result?.decision === 'reject' ? result.chatAgent : undefined;
  return {
    kind: 'refused',
    reason,
    ...(rejectAgent ? { agent: rejectAgent } : {}),
    ...(result?.notice ? { notice: result.notice } : {}),
  };
}

/**
 * The channel user kind of a Sendblue sender. `ChannelUserKind` is a closed
 * union in the SDK with no iMessage member and `IncomingTurn.userRef` must use
 * a member of it, so the turn carries `custom` and so does the principal: the
 * kernel derives the same principal from the turn's `userRef` elsewhere
 * (audience, role holders, targeted sends), and the two must agree.
 */
export const IMESSAGE_USER_KIND = 'custom';

/**
 * The sender's principal, `user:custom:<number>` (lowercase). The ONE form for
 * a person in any channel (spec §5.3). No e-mail: Sendblue states a phone
 * number, never a verified e-mail address.
 */
export function principalFor(number: string): string | undefined {
  const id = number.trim();
  return id.length > 0 ? channelUserPrincipal({ kind: IMESSAGE_USER_KIND, id }) : undefined;
}

/** The number behind a `user:custom:<number>` principal, or `undefined`. */
export function numberFromPrincipal(principalId: string): string | undefined {
  const prefix = `user:${IMESSAGE_USER_KIND}:`;
  const raw = principalId.trim();
  if (!raw.toLowerCase().startsWith(prefix)) return undefined;
  const number = raw.slice(prefix.length).trim();
  return /^\+?\d{6,15}$/.test(number) ? number : undefined;
}
