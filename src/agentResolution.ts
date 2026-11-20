import type { ChatAgent, SystemNotice } from '@omadia/channel-sdk';

/**
 * Which agent a turn belongs to (spec 2042 §5.6, INV-1/6/7). The kernel's
 * `channelResolver@1` decides; this module only asks it for the keys an
 * iMessage conversation has and ranks the answers.
 *
 * Consumed as a structural shim (not an SDK export) so the plugin keeps
 * running on hosts whose `@omadia/channel-sdk` predates the newer fields:
 * `match`, `notice` and the `context` argument are all optional.
 */

/** Who sent the turn, as far as the channel knows. */
export interface ChannelRouteContext {
  /** The sender as a principal, `user:<id>`. */
  readonly principal?: string;
}

/** How the kernel reached its decision, when it says. */
export type RouteMatch = 'identity' | 'explicit' | 'selection' | 'binding' | 'default';

export interface ChannelResolveResult {
  readonly decision: 'bound' | 'fallback' | 'reject';
  readonly chatAgent?: ChatAgent;
  readonly match?: RouteMatch;
  readonly exclusive?: boolean;
  /** With `reject`: the `system` notice the sender gets instead of an answer. */
  readonly notice?: SystemNotice;
}

export interface ChannelBindingResolver {
  resolve(
    channelType: string,
    channelKey: string,
    context?: ChannelRouteContext,
  ): ChannelResolveResult;
}

export const CHANNEL_RESOLVER_SERVICE = 'channelResolver';

/**
 * Why a turn has no Agent. `unassigned`: nothing addressed an agent (no
 * selection, no binding, no default); `notice` is the kernel's text when it
 * gave one. `agent_unavailable`: an agent was addressed but may not serve
 * (disabled, deleted, not available to the sender); the notice names it.
 * `resolver-failed`: the resolver threw, so whether a binding exists is unknown.
 */
export type AgentRefusal =
  | { readonly refused: 'unassigned'; readonly notice?: SystemNotice }
  | { readonly refused: 'agent_unavailable'; readonly notice: SystemNotice }
  | { readonly refused: 'resolver-failed'; readonly error: string };

/** 0 = explicitly addressed, 1 = selection or binding, 2 = default / platform fallback. */
function rank(result: ChannelResolveResult): 0 | 1 | 2 {
  if (result.exclusive === true || result.match === 'identity' || result.match === 'explicit') return 0;
  if (result.decision === 'fallback' || result.match === 'default') return 2;
  return 1;
}

/**
 * Resolve a turn's agent. `channelKeys` are tried most specific first (the
 * sender's number, then the line). The first key that yields a selection or a
 * binding decides. A default-agent or platform-fallback answer is only kept
 * until a later key names an agent explicitly: it is the weakest claim.
 *
 * A reject that names an agent (disabled, deleted, not available) ends the
 * search: the addressed agent answers or nobody does, a later key must never
 * put another agent in its place (INV-7). A reject without an agent
 * (`no_agent`, or no notice) lets the next key try.
 *
 * `defaultAgent` answers only when the resolver is NOT published, a
 * single-Agent host where it is the deployment's one orchestrator. With a
 * resolver, a turn nobody is bound to is refused (byte5ai/omadia#1598), and so
 * is one whose resolution threw.
 */
export function resolveAgentForTurn(
  resolver: ChannelBindingResolver | undefined,
  channelType: string,
  channelKeys: ReadonlyArray<string | null | undefined>,
  defaultAgent: ChatAgent,
  context: ChannelRouteContext = {},
): { readonly agent: ChatAgent } | AgentRefusal {
  if (!resolver) return { agent: defaultAgent };
  let weakest: ChatAgent | undefined;
  let noAgentNotice: SystemNotice | undefined;
  try {
    for (const key of channelKeys) {
      if (!key) continue;
      const result = resolver.resolve(channelType, key, context);
      if (result.decision === 'reject' || !result.chatAgent) {
        if (result.notice && result.notice.code !== 'no_agent') {
          return { refused: 'agent_unavailable', notice: result.notice };
        }
        noAgentNotice ??= result.notice;
        continue;
      }
      if (rank(result) < 2) return { agent: result.chatAgent };
      weakest ??= result.chatAgent;
    }
  } catch (err) {
    return { refused: 'resolver-failed', error: err instanceof Error ? err.message : String(err) };
  }
  if (weakest) return { agent: weakest };
  return { refused: 'unassigned', ...(noAgentNotice ? { notice: noAgentNotice } : {}) };
}

/**
 * The sender's principal in the wire form the kernel keys selections on. The
 * kernel derives it from the turn's `userId` the same way
 * (`formatPrincipal(makePrincipal('user', id))`: trimmed, lower-cased).
 */
export function principalFor(userId: string): string | undefined {
  const id = userId.trim().toLowerCase();
  return id.length > 0 ? `user:${id}` : undefined;
}
