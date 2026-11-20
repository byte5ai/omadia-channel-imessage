import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Router } from 'express';

import * as channelSdk from '@omadia/channel-sdk';
import {
  DEFAULT_PACE_PROFILE,
  InMemorySpeakerHistoryStore,
  isNoReply,
  logNoReplyDrop,
  runPacedTurn,
  type ChatAgent,
  type ChannelHandle,
  type CoreApi,
  type PaceClock,
  type IncomingTurn,
  type SemanticAnswer,
} from '@omadia/channel-sdk';
import type { PluginContext } from '@omadia/plugin-api';

import { createAdminRouter } from './adminRouter.js';
import {
  CHANNEL_RESOLVER_SERVICE,
  principalFor,
  resolveAgentForTurn,
  type AgentRefusal,
  type ChannelBindingResolver,
} from './agentResolution.js';
import { AnswerStore } from './answerStore.js';
import { createAnswersRouter } from './answersRouter.js';
import {
  buildIMessageKeyDirectory,
  type ChannelDirectoryRegistryShim,
} from './channelKeyDirectory.js';
import { PendingChoices } from './choiceReply.js';
import { emitAnswer, systemAnswer } from './emit.js';
import { createLruSet, evaluateInbound, normalizePhone } from './inbound.js';
import { isAnswerLinkAdmitted, type DecorationGate } from './renderer.js';
import { SendblueClient } from './sendblueClient.js';
import { createChannelState, patchState, type ChannelState } from './state.js';
import { verifyWebhookAuth, type HeaderBag } from './verify.js';

const CHANNEL_TYPE = 'imessage';
const ROUTE_PREFIX = '/api/imessage';
const ADMIN_ROUTE_PREFIX = '/api/imessage-channel/admin';
const DEDUPE_CAP = 512;

/** Sent when a turn failed on our side — retrying is the right advice. */
const TURN_FAILED_MESSAGE =
  '⚠️ Entschuldigung, dabei ist ein Fehler aufgetreten. Bitte versuche es erneut.';
/** Sent when no Agent is assigned to the conversation — retrying cannot help,
 *  so the text says who can. */
const NO_AGENT_MESSAGE =
  'Dieser Unterhaltung ist kein Agent zugewiesen. Bitte wende dich an den Betreiber dieses Dienstes.';

/**
 * Channel-plugin entry. The kernel's dynamic channel resolver imports this
 * module and calls the exported `activate(ctx, core)` (ChannelPlugin "shape
 * 1"). We mount the Sendblue receive-webhook and the answer-link routes via
 * `ctx.routes.register` with `auth: 'custom'` and return a handle the kernel
 * closes on deactivate/uninstall.
 *
 * Why `ctx.routes.register` and not `core.registerRouter`: every `/api/*`
 * request passes the host's operator-session gate first, and neither Sendblue
 * nor a recipient tapping an answer link has a session. The host serves a
 * plugin route without one only when the manifest declares the prefix under
 * `permissions.public_paths` AND the operator has granted it — and it only
 * counts prefixes registered through `ctx.routes`. A router mounted with
 * `core.registerRouter` stays behind the gate and answers 401 to every
 * delivery. Until the operator grants `/api/imessage`, that is also what
 * these routes answer.
 */
export async function activate(
  ctx: PluginContext,
  core: CoreApi,
  deps: ActivationDeps = {},
): Promise<ChannelHandle> {
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

  // Everything one turn needs besides the turn itself. The speaker history
  // and the open question are per conversation, in memory (a restart forgets
  // them: an extra name line costs nothing, a forgotten number falls through
  // to the agent as typed).
  const runtime: TurnRuntime = {
    ctx,
    defaultAgent: agent,
    core,
    client,
    state,
    links,
    speakerHistory: new InMemorySpeakerHistoryStore(),
    pending: new PendingChoices(),
    ...(deps.admitDecorations ? { admit: deps.admitDecorations } : {}),
    ...(deps.paceClock ? { paceClock: deps.paceClock } : {}),
  };

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
      publicBaseUrl: links?.publicBaseUrl ?? null,
      ogAssetsPath: path.resolve(here, '../assets/og'),
      log: (level, msg, data) => core.log(level, msg, data),
      onReply: async (entry, option) => {
        const replyTurn: IncomingTurn = {
          channelId,
          conversationId: entry.conversationId,
          channelType: CHANNEL_TYPE,
          channelKey: entry.conversationId,
          userRef: { kind: 'custom', id: entry.conversationId },
          text: option.value,
          metadata: { via: 'answer-link' },
          rawEvent: { source: 'answer-link', token: entry.token },
        };
        await handleTurn(runtime, replyTurn);
      },
    }),
  );

  // `auth: 'custom'` — the plugin authenticates every request itself: the
  // webhook with the timing-safe shared secret, the answer-link routes with
  // their single-use capability token. ROUTE_PREFIX must stay inside the
  // manifest's `permissions.public_paths` declaration or this call throws.
  const disposePublicRoutes = ctx.routes.register(ROUTE_PREFIX, router, { auth: 'custom' });

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
    // A bare number answers the numbered question the conversation was asked.
    const text = runtime.pending.resolve(result.turn.conversationId, result.turn.text);
    await handleTurn(runtime, text === result.turn.text ? result.turn : { ...result.turn, text });
  }

  return {
    async close() {
      // Both route registrations are disposed explicitly, then the dedupe
      // structure is released. The directory contribution is dropped so
      // /operator/channels stops listing this line once the plugin is
      // deactivated.
      disposePublicRoutes();
      disposeAdminRoutes();
      directoryRegistry?.unregister(CHANNEL_TYPE);
      seen.clear();
      answerStore.clear();
      runtime.pending.clear();
    },
  };
}

function turnFailedNotice(): SemanticAnswer {
  return systemAnswer(TURN_FAILED_MESSAGE, {
    code: 'agent_error',
    text: TURN_FAILED_MESSAGE,
    locale: 'de',
  });
}

/** Answer-link feature context — null when public_base_url is not configured. */
interface AnswerLinkContext {
  store: AnswerStore;
  publicBaseUrl: string;
}

/** Seams a test (or a host) may replace; `activate(ctx, core)` needs none. */
export interface ActivationDeps {
  /** Decoration gate; defaults to the SDK registry. */
  admitDecorations?: DecorationGate;
  /** Timer seam for the pace behaviour (tests). */
  paceClock?: PaceClock;
}

/** Everything a turn needs besides the turn itself. */
interface TurnRuntime {
  ctx: PluginContext;
  /** Answers only on a host that publishes no channel resolver. */
  defaultAgent: ChatAgent;
  core: CoreApi;
  client: SendblueClient;
  state: ChannelState;
  links: AnswerLinkContext | null;
  speakerHistory: InMemorySpeakerHistoryStore;
  pending: PendingChoices;
  admit?: DecorationGate;
  paceClock?: PaceClock;
}

/** Drive one orchestrator turn and ship the rendered answer back via Sendblue. */
async function handleTurn(rt: TurnRuntime, turn: IncomingTurn): Promise<void> {
  const { ctx, core, client, state } = rt;
  // US7 — most-specific key first: a binding on the sender's E.164, then a
  // binding on the line itself (the key the channel directory lists). The
  // sender's principal lets the kernel apply this user's own selection
  // (`/agent <Name>`) ahead of a binding. Without a published resolver the
  // default agent answers.
  const principal = principalFor(turn.userRef.id);
  const resolved = resolveAgentForTurn(
    ctx.services.get<ChannelBindingResolver>(CHANNEL_RESOLVER_SERVICE),
    CHANNEL_TYPE,
    [turn.conversationId, state.me?.fromNumber],
    rt.defaultAgent,
    principal ? { principal } : {},
  );
  if ('refused' in resolved) {
    await refuseTurn(rt, turn, resolved);
    return;
  }
  const agent = resolved.agent;

  const conversation = {
    conversationKey: turn.conversationId,
    speakerHistory: rt.speakerHistory,
  };
  try {
    // Pace (spec 2042 §5.8): the typing indicator from the start, one
    // acknowledgement when the work clearly outlasts a normal answer, no
    // progress chatter. The Sendblue webhook is answered at once and the
    // reply goes out through the API, so there is no reply window and a long
    // turn needs no follow-up switch. Started only once an agent is known — a
    // refused turn shows no "typing". Hook failures never fail the turn.
    const { result: answer } = await runPacedTurn(
      () =>
        agent.chat({
          userMessage: turn.text,
          sessionScope: `imessage:${turn.conversationId}`,
          userId: turn.userRef.id,
          ...(turn.attachments && turn.attachments.length > 0
            ? { attachments: turn.attachments }
            : {}),
        }),
      DEFAULT_PACE_PROFILE,
      {
        sendTyping: async () => {
          const ok = await client.sendTypingIndicator(turn.conversationId);
          if (!ok) core.log('debug', 'iMessage typing indicator failed (ignored)');
        },
        // The acknowledgement is a notice of the channel: the resolved agent's
        // identity is not known here, so it speaks as `system`.
        sendAck: async (text) => {
          await emitAnswer(client, turn.conversationId, systemAnswer(text), conversation);
        },
        onHookError: (hook, error) =>
          core.log('debug', `iMessage pace hook failed (ignored): ${hook}`, {
            error: error instanceof Error ? error.message : String(error),
          }),
      },
      { ...(rt.paceClock ? { clock: rt.paceClock } : {}) },
    );
    if (isNoReply(answer)) {
      logNoReplyDrop(turn.channelId, { conversationId: turn.conversationId });
      return;
    }
    // Deep-link Phase 1: a choice card gets a capability URL so the user can
    // pick in the app / browser instead of typing, but only where the
    // decoration registry declares that affordance for this channel. Creating
    // the entry supersedes any older open link of this conversation.
    let choiceLinkUrl: string | undefined;
    if (rt.links && answer.interactive?.kind === 'choice' && isAnswerLinkAdmitted(rt.admit)) {
      const entry = rt.links.store.create(turn.conversationId, answer.interactive);
      choiceLinkUrl = `${rt.links.publicBaseUrl}${ROUTE_PREFIX}/a/${entry.token}`;
    }
    await emitAnswer(
      client,
      turn.conversationId,
      answer,
      {
        ...conversation,
        ...(choiceLinkUrl ? { choiceLinkUrl } : {}),
        ...(rt.admit ? { admit: rt.admit } : {}),
      },
      { onUnstamped: () => core.log('warn', 'iMessage answer arrived without a speaker') },
    );
    // The numbered question is now open: a bare number answers it.
    rt.pending.record(turn.conversationId, answer.interactive);
    // A successful send clears a previously surfaced send error and takes the
    // channel back out of the error state.
    if (state.lastError) patchState(state, { lastError: null, status: 'connected' });
  } catch (err) {
    core.log('error', 'failed to handle iMessage turn', {
      error: (err as Error).message,
      conversationId: turn.conversationId,
    });
    // Surface the failure to the operator — Sendblue has no auth handshake,
    // so a bad API key pair only ever manifests here at send time. The status
    // moves with it: the admin UI renders a red dot for 'error', and leaving
    // the status 'connected' showed a green "Aktiv" pill directly above the
    // red error banner. The next successful send clears both.
    patchState(state, { lastError: (err as Error).message, status: 'error' });
    try {
      await emitAnswer(client, turn.conversationId, turnFailedNotice(), conversation);
    } catch {
      /* original error already logged — don't mask it with a send failure */
    }
  }
}

/**
 * Answer a turn no Agent may handle (byte5ai/omadia#1598, spec 2042 INV-7).
 * The host refuses a conversation its binding resolver rejects rather than
 * letting another orchestrator answer it; this channel says so in the chat, as
 * a `system` notice, instead of running the turn into the default agent. When
 * the kernel supplies the notice (it names the agent and the reason), that
 * text is sent; otherwise the channel's own wording.
 *
 * The channel status is left alone on purpose: a missing binding is an
 * operator configuration gap, not a fault of this channel. Only a failing
 * send — the one thing that IS this channel's job here — is surfaced.
 */
async function refuseTurn(rt: TurnRuntime, turn: IncomingTurn, refusal: AgentRefusal): Promise<void> {
  const { core, client, state } = rt;
  if (refusal.refused === 'resolver-failed') {
    core.log('error', 'iMessage turn refused: the channel resolver failed', {
      conversationId: turn.conversationId,
      error: refusal.error,
    });
  } else {
    core.log('warn', 'iMessage turn refused: no Agent serves this conversation', {
      conversationId: turn.conversationId,
      reason: refusal.refused,
      ...(refusal.notice ? { notice: refusal.notice.code } : {}),
    });
  }
  // A resolver failure is transient, so "try again" is honest there; a
  // conversation without an Agent stays without one until someone binds it.
  const notice =
    refusal.refused === 'resolver-failed'
      ? turnFailedNotice()
      : refusal.notice
        ? systemAnswer(refusal.notice.text, refusal.notice)
        : systemAnswer(NO_AGENT_MESSAGE, { code: 'no_agent', text: NO_AGENT_MESSAGE, locale: 'de' });
  try {
    await emitAnswer(client, turn.conversationId, notice, {
      conversationKey: turn.conversationId,
      speakerHistory: rt.speakerHistory,
    });
  } catch (err) {
    core.log('error', 'failed to send the iMessage refusal notice', {
      error: (err as Error).message,
      conversationId: turn.conversationId,
    });
    patchState(state, { lastError: (err as Error).message, status: 'error' });
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
