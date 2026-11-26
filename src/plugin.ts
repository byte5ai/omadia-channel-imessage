import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Router } from 'express';

import {
  DEFAULT_PACE_PROFILE,
  InMemorySpeakerHistoryStore,
  getChatAgent,
  isNoReply,
  logNoReplyDrop,
  resolveChannelRoute,
  runPacedTurn,
  type ChatAgent,
  type ChannelHandle,
  type CoreApi,
  type PaceClock,
  type IncomingTurn,
  type SemanticAnswer,
} from '@omadia/channel-sdk';
import type { PluginContext, RoutinesIntegration } from '@omadia/plugin-api';

import { createAdminRouter } from './adminRouter.js';
import {
  principalFor,
  resolveAgentForTurn,
  type RefusedRoute,
} from './agentResolution.js';
import { AnswerStore } from './answerStore.js';
import { createAnswersRouter } from './answersRouter.js';
import {
  buildIMessageKeyDirectory,
  type ChannelDirectoryRegistryShim,
} from './channelKeyDirectory.js';
import { createdEventFor } from './conversationEvents.js';
import { PendingChoices } from './choiceReply.js';
import { agentAnswer, emitAnswer, stampSpeaker, systemAnswer } from './emit.js';
import {
  IMESSAGE_ROUTINE_CHANNEL,
  createIMessageProactiveSend,
  createIMessageRoutineTurn,
  type IMessageRoutineTurn,
} from './imessageRoutines.js';
import { createLruSet, evaluateInbound, normalizePhone, type SendbluePayload } from './inbound.js';
import { isAnswerLinkAdmitted, type DecorationGate } from './renderer.js';
import { SendblueClient } from './sendblueClient.js';
import { createConversationSendProvider, createTargetedSendProvider } from './sendProviders.js';
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

  // Triggers and routines (spec 2042 §5.12, omadia#1086): published by the
  // kernel only with a database. Absent = agents set no triggers or routines here.
  const routines = ctx.services.get<RoutinesIntegration>('routinesIntegration');

  // Everything one turn needs besides the turn itself. The speaker history
  // and the open question are per conversation, in memory (a restart forgets
  // them: an extra name line costs nothing, a forgotten number falls through
  // to the agent as typed).
  const runtime: TurnRuntime = {
    ctx,
    core,
    client,
    state,
    links,
    speakerHistory: new InMemorySpeakerHistoryStore(),
    pending: new PendingChoices(),
    ...(routines ? { routineTurn: createIMessageRoutineTurn(routines, channelId) } : {}),
    ...(deps.admitDecorations ? { admit: deps.admitDecorations } : {}),
    ...(deps.paceClock ? { paceClock: deps.paceClock } : {}),
    ...(deps.reportTimeoutMs !== undefined ? { reportTimeoutMs: deps.reportTimeoutMs } : {}),
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

  // Proactive sends (Facilitator nudges, Conductor reports) as plain text.
  // Feature-detected: a host that predates the seams simply has no way to ask
  // this channel to post. The kernel drops the registrations when the channel
  // deactivates. Polls and question cards need nothing here: the kernel posts
  // them as numbered text and reads the typed reply from the events below.
  const sendDeps = { client, allowlist };
  if (typeof core.registerTargetedSendProvider === 'function') {
    core.registerTargetedSendProvider(channelId, createTargetedSendProvider(sendDeps));
  }
  if (typeof core.registerConversationSendProvider === 'function') {
    core.registerConversationSendProvider(channelId, createConversationSendProvider(sendDeps));
  }

  // Trigger and routine deliveries go to the number they were set by, through
  // the one emitter, with the turns' speaker history and the same allowlist
  // as every other send. Removed again on close.
  const disposeProactiveSend = routines?.publishProactiveSend(
    IMESSAGE_ROUTINE_CHANNEL,
    createIMessageProactiveSend({
      client,
      allowlist,
      speakerHistory: runtime.speakerHistory,
      ...(runtime.admit ? { admit: runtime.admit } : {}),
    }),
  );
  if (routines) core.log('info', 'iMessage proactive send registered (triggers and routines deliver to their number)');

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
    // The kernel reads a typed reply to a card or poll it posted as text from
    // this event and tells us when it took the message as the answer (no turn,
    // or the agent would answer "2" as well). Where it reads EVERY message of
    // the conversation itself (`all` mode) the event is the only path: no turn.
    if (await reportInbound(runtime, body, result.turn)) {
      // A consumed answer closes the numbered question the conversation was
      // asked: the digit was not meant for it.
      runtime.pending.resolve(result.turn.conversationId, result.turn.text);
      return;
    }
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
      if (typeof disposeProactiveSend === 'function') disposeProactiveSend();
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
  /** How long the report of an inbound message may hold the turn back (tests). */
  reportTimeoutMs?: number;
}

/** Everything a turn needs besides the turn itself. */
interface TurnRuntime {
  ctx: PluginContext;
  core: CoreApi;
  client: SendblueClient;
  state: ChannelState;
  links: AnswerLinkContext | null;
  speakerHistory: InMemorySpeakerHistoryStore;
  pending: PendingChoices;
  /** Opens the kernel's routines scope for an answered turn; absent without `routinesIntegration`. */
  routineTurn?: IMessageRoutineTurn;
  admit?: DecorationGate;
  paceClock?: PaceClock;
  reportTimeoutMs?: number;
}

/** What the turn hands to the agent: the text, the session, the sender. */
function chatInput(turn: IncomingTurn): Parameters<ChatAgent['chat']>[0] {
  return {
    userMessage: turn.text,
    sessionScope: `imessage:${turn.conversationId}`,
    userId: turn.userRef.id,
    ...(turn.attachments && turn.attachments.length > 0 ? { attachments: turn.attachments } : {}),
  };
}

/** How long the report of an inbound message may hold the turn back. */
const REPORT_TIMEOUT_MS = 1_500;

/**
 * Report an accepted inbound message to the kernel as a `created` conversation
 * message. `true` when the channel starts NO turn for it:
 *  - the kernel took it as the typed answer to an open question (a card or poll
 *    it posted as text): `reportConversationMessage` says so, and the agent
 *    must not also answer "2". The report waits for the kernel's decision, but
 *    never longer than {@link REPORT_TIMEOUT_MS}: a slow or failing kernel means
 *    `answeredCard` unknown, i.e. false, and the turn runs as before;
 *  - the kernel reads every message of this conversation itself
 *    (`conversationDelivery` is `all`): the event is then the only path.
 * Without `reportConversationMessage` the message is emitted fire-and-forget
 * (`emitConversationMessage`); without either nothing is reported. A failing
 * report is logged and never fails or delays the turn beyond the timeout.
 */
async function reportInbound(rt: TurnRuntime, body: unknown, turn: IncomingTurn): Promise<boolean> {
  const { core } = rt;
  const report = core.reportConversationMessage;
  const emit = core.emitConversationMessage;
  if (typeof report !== 'function' && typeof emit !== 'function') return false;
  const line = rt.state.me?.fromNumber ?? '';
  const event = createdEventFor(body as SendbluePayload, {
    channelId: turn.channelId,
    channelType: CHANNEL_TYPE,
    line,
    conversationId: turn.conversationId,
    text: turn.text,
    now: Date.now(),
  });
  try {
    if (typeof report === 'function') {
      if (await answeredCardWithin(report.call(core, event), rt.reportTimeoutMs ?? REPORT_TIMEOUT_MS)) return true;
    } else {
      emit?.call(core, event);
    }
  } catch (err) {
    core.log('warn', 'iMessage conversation message report failed (ignored)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Independent of the report: where the kernel reads everything, no turn.
  try {
    return core.conversationDelivery?.(CHANNEL_TYPE, turn.conversationId, line) === 'all';
  } catch (err) {
    core.log('warn', 'iMessage conversation delivery lookup failed (ignored)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** The kernel's `answeredCard`, or `false` once `timeoutMs` has passed. */
async function answeredCardWithin(pending: Promise<{ answeredCard: boolean }>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ answeredCard: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ answeredCard: false }), timeoutMs);
  });
  try {
    return (await Promise.race([pending, timeout])).answeredCard === true;
  } finally {
    clearTimeout(timer);
  }
}

/** Drive one orchestrator turn and ship the rendered answer back via Sendblue. */
async function handleTurn(rt: TurnRuntime, turn: IncomingTurn): Promise<void> {
  const { ctx, core, client, state } = rt;
  // US7 — most-specific key first: a binding on the sender's number, then a
  // binding on the line itself (the key the channel directory lists). The
  // sender's principal lets the kernel apply this user's own selection
  // (`/agent <Name>`) ahead of a binding. Without a published resolver the
  // default agent answers.
  const principal = principalFor(turn.userRef.id);
  // No locale: Sendblue does not tell the person's language, so the kernel's
  // notices come in its default (German) rather than in a guessed one.
  const route = resolveAgentForTurn(
    (key, context) => resolveChannelRoute(ctx, CHANNEL_TYPE, key, context),
    [turn.conversationId, state.me?.fromNumber],
    () => resolveSingletonAgent(ctx),
    principal ? { principal } : {},
  );
  if (route.kind === 'resolver-failed') {
    core.log('error', 'iMessage turn refused: the channel resolver failed', {
      conversationId: turn.conversationId,
      error: route.error,
    });
    await sendNotice(rt, turn, turnFailedNotice());
    return;
  }
  if (route.kind === 'refused') {
    await refuseTurn(rt, turn, route);
    return;
  }
  const { agent, speaker } = route;

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
    // The routines scope wraps the agent's turn: who asks, and where a trigger
    // or routine the agent sets now delivers later. A refused turn opens none.
    const userId = turn.userRef.id;
    const chat = () => agent.chat(chatInput(turn));
    const routineTurn = rt.routineTurn;
    const runTurn = routineTurn && userId ? () => routineTurn({ userId, conversationId: turn.conversationId })(chat) : chat;
    const { result: answer } = await runPacedTurn(
      runTurn,
      DEFAULT_PACE_PROFILE,
      {
        sendTyping: async () => {
          const ok = await client.sendTypingIndicator(turn.conversationId);
          if (!ok) core.log('debug', 'iMessage typing indicator failed (ignored)');
        },
        // The acknowledgement is the agent's own words, so it goes out under
        // the agent the resolver named before the turn. Without a speaker
        // (a host with no resolver) it is not sent: the typing indicator
        // stays, and a `system` voice saying "I am on it" would be wrong.
        sendAck: async (text) => {
          if (!speaker) {
            core.log('debug', 'iMessage pace acknowledgement skipped: no speaker resolved before the turn');
            return;
          }
          await emitAnswer(client, turn.conversationId, agentAnswer(text, speaker), conversation);
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
    // Fail-closed: an answer names its speaker itself or through the
    // resolver's pre-turn decision. With neither, the words are withheld and
    // the sender gets a `system` notice, never text under no (or a guessed)
    // name. This is a platform fault, not a fault of this channel: the
    // channel status is left alone.
    const stamped = stampSpeaker(answer, speaker);
    if (!stamped) {
      core.log('error', 'iMessage answer withheld: it carries no speaker and the resolver named none', {
        conversationId: turn.conversationId,
      });
      await sendNotice(rt, turn, turnFailedNotice());
      return;
    }
    // Deep-link Phase 1: a choice card gets a capability URL so the user can
    // pick in the app / browser instead of typing, but only where the
    // decoration registry declares that affordance for this channel. Creating
    // the entry supersedes any older open link of this conversation.
    let choiceLinkUrl: string | undefined;
    if (rt.links && stamped.interactive?.kind === 'choice' && isAnswerLinkAdmitted(rt.admit)) {
      const entry = rt.links.store.create(turn.conversationId, stamped.interactive);
      choiceLinkUrl = `${rt.links.publicBaseUrl}${ROUTE_PREFIX}/a/${entry.token}`;
    }
    await emitAnswer(client, turn.conversationId, stamped, {
      ...conversation,
      ...(choiceLinkUrl ? { choiceLinkUrl } : {}),
      ...(rt.admit ? { admit: rt.admit } : {}),
    });
    // The numbered question is now open: a bare number answers it.
    rt.pending.record(turn.conversationId, stamped.interactive);
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

/** Send a `system` notice; a failing send is logged and surfaced, never thrown. */
async function sendNotice(rt: TurnRuntime, turn: IncomingTurn, notice: SemanticAnswer): Promise<void> {
  const { core, client, state } = rt;
  try {
    await emitAnswer(client, turn.conversationId, notice, {
      conversationKey: turn.conversationId,
      speakerHistory: rt.speakerHistory,
    });
  } catch (err) {
    core.log('error', 'failed to send an iMessage notice', {
      error: (err as Error).message,
      conversationId: turn.conversationId,
    });
    patchState(state, { lastError: (err as Error).message, status: 'error' });
  }
}

/**
 * Answer a turn no Agent may handle (byte5ai/omadia#1598, spec 2042 INV-7).
 * The host refuses a conversation its binding resolver rejects rather than
 * letting another orchestrator answer it; this channel says so in the chat, as
 * a `system` message, instead of running the turn into the default agent.
 *
 * The text goes to the resolver's ChatAgent first: it carries out `/agent
 * <name>`, `/agent` and `/agents` (a user with no agent yet must be able to
 * pick one) and otherwise answers with the notice, both as `system`. Only a
 * `system` answer is sent: should the ChatAgent ever return an agent's
 * speaker on a reject, those words are withheld (INV-7, never an agent's
 * answer to a refused turn). Without a ChatAgent, or when it fails, the
 * kernel's notice is sent as it is, else the channel's own wording.
 *
 * The channel status is left alone on purpose: a missing binding is an
 * operator configuration gap, not a fault of this channel. Only a failing
 * send — the one thing that IS this channel's job here — is surfaced.
 */
async function refuseTurn(rt: TurnRuntime, turn: IncomingTurn, route: RefusedRoute): Promise<void> {
  const { core } = rt;
  core.log('warn', 'iMessage turn refused: no Agent serves this conversation', {
    conversationId: turn.conversationId,
    reason: route.reason,
    ...(route.notice ? { notice: route.notice.code } : {}),
  });
  let reply: SemanticAnswer = route.notice
    ? systemAnswer(route.notice.text, route.notice)
    : systemAnswer(NO_AGENT_MESSAGE, { code: 'no_agent', text: NO_AGENT_MESSAGE, locale: 'de' });
  if (route.agent) {
    try {
      const answer = await route.agent.chat(chatInput(turn));
      if (isNoReply(answer)) {
        logNoReplyDrop(turn.channelId, { conversationId: turn.conversationId });
        return;
      }
      if (answer.speaker?.kind === 'system') {
        reply = answer;
      } else {
        core.log('error', 'iMessage reject answer withheld: the resolver ChatAgent did not answer as system', {
          conversationId: turn.conversationId,
        });
      }
    } catch (err) {
      core.log('error', 'the resolver ChatAgent failed on a refused iMessage turn', {
        error: (err as Error).message,
        conversationId: turn.conversationId,
      });
    }
  }
  await sendNotice(rt, turn, reply);
}

/**
 * The deployment's singleton orchestrator, for a host that publishes NO channel
 * resolver (no multi-agent registry). Looked up per turn and only then: with a
 * resolver every turn, a refusal included, uses the ChatAgent of the resolve
 * result, because since S1 the singleton refuses every non-canvas turn.
 */
function resolveSingletonAgent(ctx: PluginContext): ChatAgent | undefined {
  return getChatAgent(ctx);
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
