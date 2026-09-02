import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Router } from 'express';

import * as channelSdk from '@omadia/channel-sdk';
import {
  isNoReply,
  logNoReplyDrop,
  type ChatAgent,
  type ChannelHandle,
  type CoreApi,
  type IncomingTurn,
} from '@omadia/channel-sdk';
import type { PluginContext } from '@omadia/plugin-api';

import { createAdminRouter } from './adminRouter.js';
import { AnswerStore } from './answerStore.js';
import { createAnswersRouter } from './answersRouter.js';
import {
  buildIMessageKeyDirectory,
  type ChannelDirectoryRegistryShim,
} from './channelKeyDirectory.js';
import { createLruSet, evaluateInbound, normalizePhone } from './inbound.js';
import { renderAnswer } from './renderer.js';
import { SendblueClient } from './sendblueClient.js';
import { createChannelState, patchState, type ChannelState } from './state.js';
import { verifyWebhookAuth, type HeaderBag } from './verify.js';

const CHANNEL_TYPE = 'imessage';
const ROUTE_PREFIX = '/api/imessage';
const ADMIN_ROUTE_PREFIX = '/api/imessage-channel/admin';
const DEDUPE_CAP = 512;

/**
 * Channel-plugin entry. The kernel's dynamic channel resolver imports this
 * module and calls the exported `activate(ctx, core)` (ChannelPlugin "shape
 * 1"). We mount the Sendblue receive-webhook via `core.registerRouter` (the
 * router lands verbatim on the root Express app — publicly reachable, exactly
 * what a provider webhook needs) and return a handle the kernel closes on
 * deactivate/uninstall.
 */
export async function activate(ctx: PluginContext, core: CoreApi): Promise<ChannelHandle> {
  const channelId = ctx.agentId;

  // secrets are async (SecretsAccessor.require), config is sync
  const apiKeyId = await ctx.secrets.require('api_key_id');
  const apiSecretKey = await ctx.secrets.require('api_secret_key');
  const webhookSecret = await ctx.secrets.require('webhook_secret');

  const fromNumber = (ctx.config.get<string>('from_number') ?? '').trim();
  if (fromNumber.length === 0) {
    throw new Error(
      '@omadia/channel-imessage: from_number (Sendblue line, E.164) is required — set it in the plugin setup',
    );
  }
  const apiBaseUrl = trimBase(ctx.config.get<string>('api_base_url') ?? 'https://api.sendblue.co');
  const apiV2BaseUrl = trimBase(
    ctx.config.get<string>('api_v2_base_url') ?? 'https://api.sendblue.com',
  );
  const allowlist = parseAllowlist(ctx.config.get<string>('allowlist') ?? '');

  // Answer links (deep-link concept Phase 1). Empty public_base_url disables
  // the feature entirely — choice cards then degrade to text-only as before.
  const publicBaseUrl = trimBase((ctx.config.get<string>('public_base_url') ?? '').trim());
  const ttlHours = parsePositive(ctx.config.get<string>('answer_link_ttl_hours'), 24);
  const answerStore = new AnswerStore({ ttlMs: ttlHours * 60 * 60 * 1000 });
  const links: AnswerLinkContext | null =
    publicBaseUrl.length > 0 ? { store: answerStore, publicBaseUrl } : null;

  // Resolve the orchestrator's ChatAgent. Prefers the SDK's getChatAgent()
  // helper; falls back to the raw 'chatAgent' service lookup so the plugin
  // still runs on a host whose channel-sdk predates the helper.
  const maybeAgent = resolveChatAgent(ctx);
  if (!maybeAgent) {
    throw new Error(
      '@omadia/channel-imessage: orchestrator unavailable (getChatAgent) — the orchestrator plugin must be installed and active',
    );
  }
  // Re-bind under a non-optional type: the narrowing above does not survive
  // into the hoisted `handleInbound` closure below.
  const agent: ChatAgent = maybeAgent;

  const client = new SendblueClient({
    apiBaseUrl,
    apiV2BaseUrl,
    apiKeyId,
    apiSecretKey,
    fromNumber,
  });

  const seen = createLruSet(DEDUPE_CAP);
  let groupDropLogged = false;

  const state = createChannelState();
  patchState(state, { me: { fromNumber } });

  // The path template shown to the operator (admin UI + logs). The secret is
  // NEVER substituted in — the page only ever sees the placeholder.
  const webhookPathTemplate = `${ROUTE_PREFIX}/webhook/<webhook_secret>`;

  // Status admin UI. web-ui renders this as an iframe (manifest
  // `admin_ui_path`); the UI fetches its JSON API with RELATIVE paths so it
  // resolves through the `/bot-api` rewrite.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiAssetsPath = path.resolve(here, '../assets/admin-ui');

  const disposeAdminRoutes = ctx.routes.register(
    ADMIN_ROUTE_PREFIX,
    createAdminRouter({
      uiAssetsPath,
      state,
      smokeMode: ctx.smokeMode,
      webhookPath: webhookPathTemplate,
    }),
  );

  const router = Router();
  router.post('/webhook/:token', (req, res) => {
    const token = (req.params as Record<string, string | undefined>)['token'];
    if (!verifyWebhookAuth(webhookSecret, token, req.headers as HeaderBag)) {
      // header NAMES only — never values (one of them may be the secret)
      core.log('warn', 'iMessage webhook rejected: secret mismatch', {
        headerNames: Object.keys(req.headers),
      });
      res.status(401).json({ ok: false });
      return;
    }

    // An authenticated delivery proves the receive URL in the Sendblue
    // dashboard is wired correctly (Sendblue has no verification handshake).
    patchState(state, { webhookVerified: true, lastInboundAt: Date.now() });

    // Answer 200 IMMEDIATELY — Sendblue times webhooks out after 45s and
    // retries on 5xx/timeout; an orchestrator turn can easily exceed that
    // and a retry would duplicate the turn. Processing continues detached.
    res.status(200).json({ ok: true });

    void handleInbound(req.body).catch((err) => {
      // belt-and-braces: handleInbound catches internally already
      core.log('error', 'iMessage inbound handler crashed', {
        error: (err as Error).message,
      });
    });
  });

  // Answer-link routes share the public webhook mount. Mounted even when the
  // feature is off (publicBaseUrl empty) — the store is simply never written,
  // so every token 404s.
  router.use(
    createAnswersRouter({
      store: answerStore,
      routePrefix: ROUTE_PREFIX,
      returnNumber: fromNumber,
      log: (level, msg, data) => core.log(level, msg, data),
      onReply: async (entry, option) => {
        const replyTurn: IncomingTurn = {
          channelId,
          conversationId: entry.conversationId,
          channelType: CHANNEL_TYPE,
          channelKey: entry.conversationId,
          userRef: { kind: 'imessage-handle', id: entry.conversationId },
          text: option.value,
          metadata: { via: 'answer-link' },
          rawEvent: { source: 'answer-link', token: entry.token },
        };
        await handleTurn(ctx, agent, core, client, state, replyTurn, links);
      },
    }),
  );

  core.registerRouter(channelId, ROUTE_PREFIX, router);

  // Contribute the configured line to the operator channels dashboard
  // (`GET /api/v1/operator/channels`) so it is a pickable binding key instead
  // of a string the operator has to memorise. Optional service — a pre-US7
  // host simply has no registry, and the channel works without the listing.
  const directoryRegistry = ctx.services.get<ChannelDirectoryRegistryShim>(
    'channelDirectoryRegistry',
  );
  if (directoryRegistry) {
    directoryRegistry.register(
      buildIMessageKeyDirectory({ fromNumber, originPluginId: channelId }),
    );
    core.log('info', `channel-key directory contributed: imessage · ${fromNumber}`);
  } else {
    core.log(
      'info',
      'channelDirectoryRegistry not published — skipping /operator/channels contribution',
    );
  }

  // Webhook mounted + config validated — as connected as a webhook-only
  // channel gets (there is no long-lived connection to watch).
  patchState(state, { status: 'connected' });

  core.log('info', 'iMessage channel activated (Sendblue)', {
    webhookPath: webhookPathTemplate,
    adminUi: `${ADMIN_ROUTE_PREFIX}/index.html`,
    fromNumber,
    allowlisted: allowlist.size,
    answerLinks: links ? `enabled (ttl ${ttlHours}h)` : 'disabled (no public_base_url)',
  });

  async function handleInbound(body: unknown): Promise<void> {
    const result = evaluateInbound(body, { channelId, allowlist, seen });
    if ('drop' in result) {
      if (result.drop === 'group-unsupported' && !groupDropLogged) {
        groupDropLogged = true;
        core.log(
          'info',
          'iMessage group message dropped — group chats are unsupported in v1 (replies would need the undocumented /send-group-message endpoint)',
          { reason: result.drop },
        );
      } else {
        core.log('debug', 'iMessage webhook payload dropped', { reason: result.drop });
      }
      return;
    }
    // A plain-text reply resolves any pending answer link of the conversation
    // — the user answered in iMessage, so a later link tap must 409.
    answerStore.resolveOpenForConversation(result.turn.conversationId, 'text');
    await handleTurn(ctx, agent, core, client, state, result.turn, links);
  }

  return {
    async close() {
      // The webhook route auto-503s on deactivation; the admin routes are
      // disposed explicitly, then the dedupe structure is released. The
      // directory contribution is dropped so /operator/channels stops
      // listing this line once the plugin is deactivated.
      disposeAdminRoutes();
      directoryRegistry?.unregister(CHANNEL_TYPE);
      seen.clear();
      answerStore.clear();
    },
  };
}

/** Answer-link feature context — null when public_base_url is not configured. */
interface AnswerLinkContext {
  store: AnswerStore;
  publicBaseUrl: string;
}

/** Drive one orchestrator turn and ship the rendered answer back via Sendblue. */
async function handleTurn(
  ctx: PluginContext,
  defaultAgent: ChatAgent,
  core: CoreApi,
  client: SendblueClient,
  state: ChannelState,
  turn: IncomingTurn,
  links: AnswerLinkContext | null,
): Promise<void> {
  // Fire-and-forget typing indicator (best-effort, never throws).
  void client.sendTypingIndicator(turn.conversationId).then((ok) => {
    if (!ok) core.log('debug', 'iMessage typing indicator failed (ignored)');
  });

  // US7 — most-specific key first: a binding on the sender's E.164 wins,
  // then a binding on the line itself (the key the channel directory lists),
  // then the platform fallback Agent, then the default.
  const agent = resolveAgentForTurn(
    ctx,
    CHANNEL_TYPE,
    [turn.conversationId, state.me?.fromNumber],
    defaultAgent,
  );
  try {
    const answer = await agent.chat({
      userMessage: turn.text,
      sessionScope: `imessage:${turn.conversationId}`,
      userId: turn.userRef.id,
      ...(turn.attachments && turn.attachments.length > 0
        ? { attachments: turn.attachments }
        : {}),
    });
    if (isNoReply(answer)) {
      logNoReplyDrop(turn.channelId, { conversationId: turn.conversationId });
      return;
    }
    // Deep-link Phase 1: a choice card gets a capability URL so the user can
    // pick in the app / browser instead of typing. Creating the entry
    // supersedes any older open link of this conversation.
    let choiceLinkUrl: string | undefined;
    if (links && answer.interactive?.kind === 'choice') {
      const entry = links.store.create(turn.conversationId, answer.interactive);
      choiceLinkUrl = `${links.publicBaseUrl}${ROUTE_PREFIX}/a/${entry.token}`;
    }
    const text = renderAnswer(answer, choiceLinkUrl ? { choiceLinkUrl } : undefined);
    if (text.trim().length === 0) return;
    await client.sendMessage({ number: turn.conversationId, content: text });
    // A successful send clears a previously surfaced send error.
    if (state.lastError) patchState(state, { lastError: null });
  } catch (err) {
    core.log('error', 'failed to handle iMessage turn', {
      error: (err as Error).message,
      conversationId: turn.conversationId,
    });
    // Surface the failure to the operator — Sendblue has no auth handshake,
    // so a bad API key pair only ever manifests here at send time.
    patchState(state, { lastError: (err as Error).message });
    try {
      await client.sendMessage({
        number: turn.conversationId,
        content: '⚠️ Entschuldigung, dabei ist ein Fehler aufgetreten. Bitte versuche es erneut.',
      });
    } catch {
      /* original error already logged — don't mask it with a send failure */
    }
  }
}

/**
 * Resolve the orchestrator's {@link ChatAgent}. Prefers the SDK helper
 * `getChatAgent(ctx)` (the blessed, typed path); falls back to the raw
 * service-registry lookup so the plugin also runs on a host whose
 * `@omadia/channel-sdk` predates the helper (the `chatAgent` service itself
 * has always been there). Accessed via the namespace so a missing export is
 * just `undefined` at runtime rather than a module-load error.
 */
function resolveChatAgent(ctx: PluginContext): ChatAgent | undefined {
  const helper = (channelSdk as { getChatAgent?: (c: PluginContext) => ChatAgent | undefined })
    .getChatAgent;
  if (helper) return helper(ctx);
  return ctx.services.get<{ agent: ChatAgent }>('chatAgent')?.agent;
}

/**
 * Structural view of the kernel's `channelResolver@1` — the per-binding router
 * published by the multi-orchestrator runtime. Consumed directly (not via a
 * new SDK export) so this plugin keeps running on hosts whose
 * `@omadia/channel-sdk` predates the US7 helper; the service itself is what the
 * helper wraps.
 */
interface ChannelBindingResolver {
  resolve(
    channelType: string,
    channelKey: string,
  ): { readonly decision: 'bound' | 'fallback' | 'reject'; readonly chatAgent?: ChatAgent };
}

const CHANNEL_RESOLVER_SERVICE = 'channelResolver';

/**
 * US7 per-turn Agent resolution. Routes a turn to the Agent the operator bound
 * to its `(channelType, channelKey)` via `channelResolver@1`, falling back to
 * `defaultAgent` when no binding (and no platform fallback Agent) matches OR
 * the resolver is not published (single-Agent / pre-US7 host). `channelKeys`
 * are tried most-specific first: a `bound` decision wins immediately, a
 * `fallback` is remembered and used only if no key is explicitly bound.
 * Resolver errors are swallowed (default agent used) so a hiccup never drops a
 * turn. Without this, every turn reaches the shared, fully-tooled singleton
 * regardless of which Agent the channel is bound to.
 */
function resolveAgentForTurn(
  ctx: PluginContext,
  channelType: string,
  channelKeys: ReadonlyArray<string | null | undefined>,
  defaultAgent: ChatAgent,
): ChatAgent {
  const resolver = ctx.services.get<ChannelBindingResolver>(CHANNEL_RESOLVER_SERVICE);
  if (!resolver) return defaultAgent;
  let fallback: ChatAgent | undefined;
  try {
    for (const key of channelKeys) {
      if (!key) continue;
      const decision = resolver.resolve(channelType, key);
      if (decision.decision === 'bound' && decision.chatAgent) return decision.chatAgent;
      if (decision.decision === 'fallback' && decision.chatAgent) fallback ??= decision.chatAgent;
    }
  } catch {
    return defaultAgent;
  }
  return fallback ?? defaultAgent;
}

/** Parse the comma-separated allowlist into digits-only phone numbers. */
function parseAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((entry) => normalizePhone(entry))
      .filter((entry) => entry.length > 0),
  );
}

/** Strip a trailing slash so `${base}/api/...` never doubles the slash. */
function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Parse a positive number from an optional config string, else `fallback`. */
function parsePositive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
