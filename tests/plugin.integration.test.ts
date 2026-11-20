import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import { describe, it } from 'node:test';

import express, { type Router } from 'express';

import type {
  ChannelKeyDirectory,
  ConversationMessageEvent,
  ConversationSendProvider,
  PaceClock,
  QuestionCard,
  SemanticAnswer,
  TargetedSendProvider,
} from '@omadia/channel-sdk';
import type { PluginContext } from '@omadia/plugin-api';

import { activate, type ActivationDeps } from '../src/plugin.js';

/**
 * Mocked-webhook integration tests (triage plan for #410): a real express
 * app hosts the router the plugin registers, Sendblue is a recorded fetch
 * stub, the orchestrator is a scripted ChatAgent. Covers the acceptance
 * criteria end-to-end — webhook auth, turn scoping, allowlist, dedupe,
 * attachment forwarding, key directory, and the answer-link round trip.
 */

const SECRET = 'test-webhook-secret-0123456789abcdef';
const LINE = '+15550001111';
const SENDER = '+491701234567';

/** The agent the kernel names for the default (resolver-less) path in these tests. */
const HARNESS_SPEAKER = { kind: 'agent', agentId: 'ag-default', slug: 'default', displayName: 'Standard' } as const;

interface ChatCall {
  userMessage: string;
  sessionScope: string;
  userId: string;
  attachments?: unknown;
}

interface SendblueSend {
  url: string;
  body: Record<string, unknown>;
}

interface RouteRegistration {
  prefix: string;
  router: Router;
  options: { auth?: string; body?: string } | undefined;
  disposed: boolean;
}

interface Harness {
  base: string;
  /** Base URL of the session-gated admin API (`…/api/status`). */
  adminBase: string;
  /** Every `ctx.routes.register` call the plugin made, in order. */
  registrations: RouteRegistration[];
  /** Prefixes the plugin handed to `core.registerRouter` (must stay empty). */
  coreRouterPrefixes: string[];
  chatCalls: ChatCall[];
  sends: SendblueSend[];
  directories: ChannelKeyDirectory[];
  unregistered: string[];
  logs: string[];
  close(): Promise<void>;
}

/** Next scripted answer(s) the fake orchestrator returns (FIFO, repeats last). */
let scriptedAnswers: SemanticAnswer[] = [{ text: 'Antwort vom Agenten.' }];

/** When set, Sendblue answers every send-message with this HTTP status. */
let sendblueFailStatus: number | undefined;

/** The registry does not declare the answer link for iMessage yet; this gate does. */
const ADMIT_ALL: ActivationDeps['admitDecorations'] = (_channel, decorations) => ({
  admitted: decorations,
  refused: [],
});

async function startHarness(
  config: Record<string, string> = {},
  extraServices: Record<string, unknown> = {},
  deps: ActivationDeps = {},
  coreExtra: Record<string, unknown> = {},
): Promise<Harness> {
  const chatCalls: ChatCall[] = [];
  const sends: SendblueSend[] = [];
  const directories: ChannelKeyDirectory[] = [];
  const unregistered: string[] = [];
  const logs: string[] = [];
  const registrations: RouteRegistration[] = [];
  const coreRouterPrefixes: string[] = [];

  const realFetch = globalThis.fetch;
  // The SendblueClient captures global fetch at construction — stub BEFORE
  // activate(). Local test requests below keep using realFetch.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('sendblue')) {
      if (url.endsWith('/api/send-message') && sendblueFailStatus !== undefined) {
        return new Response('rejected', { status: sendblueFailStatus });
      }
      if (url.endsWith('/api/send-message')) {
        sends.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      }
      return new Response(JSON.stringify({ status: 'OK', message_handle: 'out-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const secrets: Record<string, string> = {
    api_key_id: 'key-id',
    api_secret_key: 'key-secret',
    webhook_secret: SECRET,
  };
  const configMap: Record<string, string> = { from_number: LINE, ...config };

  const services: Record<string, unknown> = {
    chatAgent: {
      agent: {
        chat: async (input: ChatCall): Promise<SemanticAnswer> => {
          chatCalls.push(input);
          const next = scriptedAnswers.length > 1 ? scriptedAnswers.shift() : scriptedAnswers[0];
          // The harness plays the kernel, which stamps every answer with its
          // speaker; a scripted answer that names its own (or `system`) keeps it.
          const answer = next ?? { text: 'Antwort vom Agenten.' };
          return 'speaker' in answer ? answer : { ...answer, speaker: HARNESS_SPEAKER };
        },
      },
    },
    channelDirectoryRegistry: {
      register: (d: ChannelKeyDirectory) => directories.push(d),
      unregister: (t: string) => unregistered.push(t),
    },
    ...extraServices,
  };

  const ctx = {
    agentId: 'imessage-channel',
    smokeMode: false,
    secrets: {
      require: async (name: string) => {
        const v = secrets[name];
        if (v === undefined) throw new Error(`missing secret ${name}`);
        return v;
      },
    },
    config: { get: <T>(key: string): T | undefined => configMap[key] as T | undefined },
    services: { get: <T>(name: string): T | undefined => services[name] as T | undefined },
    routes: {
      register: (prefix: string, router: Router, options?: RouteRegistration['options']) => {
        const registration: RouteRegistration = { prefix, router, options, disposed: false };
        registrations.push(registration);
        return () => {
          registration.disposed = true;
        };
      },
    },
  } as unknown as PluginContext;

  const core = {
    log: (_level: string, msg: string) => {
      logs.push(msg);
    },
    registerRouter: (_channelId: string, prefix: string) => {
      coreRouterPrefixes.push(prefix);
    },
    ...coreExtra,
  };

  const handle = await activate(ctx, core as never, deps);

  // The public router is the one registration that opts out of the host's
  // session gate. Pin the mount point rather than hand-typing it below: the
  // operator's Sendblue webhook URL and the manifest's
  // `permissions.public_paths` declaration both name `/api/imessage`, so a
  // changed prefix fails activation on the host — and a test that mounts at a
  // literal path would stay green through it.
  const publicRegistration = registrations.find((r) => r.options?.auth === 'custom');
  assert.ok(publicRegistration, "plugin must register its public router with auth: 'custom'");
  assert.equal(publicRegistration.prefix, '/api/imessage', 'public router prefix is load-bearing');

  const app = express();
  app.use(express.json()); // the omadia host parses JSON before the plugin router
  app.use(publicRegistration.prefix, publicRegistration.router);
  // The admin router is mounted bare: the host's session gate is not under
  // test here, the status the operator sees is.
  const adminRegistration = registrations.find((r) => r !== publicRegistration);
  assert.ok(adminRegistration, 'plugin must register its admin router');
  app.use(adminRegistration.prefix, adminRegistration.router);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');

  return {
    base: `http://127.0.0.1:${addr.port}/api/imessage`,
    adminBase: `http://127.0.0.1:${addr.port}${adminRegistration.prefix}`,
    registrations,
    coreRouterPrefixes,
    chatCalls,
    sends,
    directories,
    unregistered,
    logs,
    close: async () => {
      await handle.close();
      server.close();
      globalThis.fetch = realFetch;
      scriptedAnswers = [{ text: 'Antwort vom Agenten.' }];
      sendblueFailStatus = undefined;
    },
  };
}

/** Poll until `cond` holds (webhook processing is detached from the 200). */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const inbound = (over: Record<string, unknown> = {}) => ({
  from_number: SENDER,
  content: 'Hallo omadia',
  status: 'RECEIVED',
  is_outbound: false,
  message_handle: `mh-${Math.random().toString(36).slice(2)}`,
  sendblue_number: LINE,
  ...over,
});

const postWebhook = (base: string, token: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/webhook/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('plugin.activate — route registration', () => {
  it('mounts the public router through ctx.routes with auth custom, never core.registerRouter', async () => {
    const h = await startHarness();
    try {
      // The host serves a route without an operator session only when it was
      // registered through ctx.routes under a declared public path. A router
      // handed to core.registerRouter stays behind the session gate and
      // answers 401 to every Sendblue delivery.
      assert.deepEqual(h.coreRouterPrefixes, []);
      const custom = h.registrations.filter((r) => r.options?.auth === 'custom');
      assert.deepEqual(
        custom.map((r) => r.prefix),
        ['/api/imessage'],
      );
    } finally {
      await h.close();
    }
  });

  it('keeps the admin UI behind the session gate on its own prefix', async () => {
    const h = await startHarness();
    try {
      const admin = h.registrations.find((r) => r.prefix === '/api/imessage-channel/admin');
      assert.ok(admin, 'admin router must be registered');
      // No options = the host default, auth: 'session'.
      assert.equal(admin.options?.auth, undefined);
      assert.ok(
        !admin.prefix.startsWith('/api/imessage/'),
        'admin prefix must not sit under the public path',
      );
    } finally {
      await h.close();
    }
  });

  it('disposes every route registration on close', async () => {
    const h = await startHarness();
    await h.close();
    assert.equal(h.registrations.length, 2);
    assert.ok(
      h.registrations.every((r) => r.disposed),
      'a registration left undisposed keeps serving after deactivation',
    );
  });
});

describe('plugin.activate — webhook auth', () => {
  it('rejects a wrong secret with 401 and starts no turn', async () => {
    const h = await startHarness();
    try {
      const res = await postWebhook(h.base, 'wrong-secret', inbound());
      assert.equal(res.status, 401);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(h.chatCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('accepts the secret from a request header when the path token is wrong', async () => {
    const h = await startHarness();
    try {
      const res = await postWebhook(h.base, 'nope', inbound(), { 'x-sendblue-secret': SECRET });
      assert.equal(res.status, 200);
      await waitFor(() => h.chatCalls.length === 1, 'turn via header auth');
    } finally {
      await h.close();
    }
  });
});

describe('plugin.activate — inbound turns', () => {
  it('drives a turn scoped imessage:<E.164> and replies via Sendblue', async () => {
    const h = await startHarness();
    try {
      const res = await postWebhook(h.base, SECRET, inbound());
      assert.equal(res.status, 200, 'acked immediately');
      await waitFor(() => h.sends.length === 1, 'sendblue reply');

      assert.equal(h.chatCalls[0]?.userMessage, 'Hallo omadia');
      assert.equal(h.chatCalls[0]?.sessionScope, `imessage:${SENDER}`);
      assert.equal(h.chatCalls[0]?.userId, SENDER);
      assert.equal(h.sends[0]?.body.number, SENDER);
      assert.equal(h.sends[0]?.body.from_number, LINE);
      assert.equal(h.sends[0]?.body.content, 'Antwort vom Agenten.');
    } finally {
      await h.close();
    }
  });

  it('forwards an inbound image to the orchestrator (vision path)', async () => {
    const h = await startHarness();
    try {
      await postWebhook(h.base, SECRET, inbound({ media_url: 'https://cdn.x/pic.jpg' }));
      await waitFor(() => h.chatCalls.length === 1, 'attachment turn');
      assert.deepEqual(h.chatCalls[0]?.attachments, [
        { kind: 'image', url: 'https://cdn.x/pic.jpg', mediaType: 'image/jpeg' },
      ]);
    } finally {
      await h.close();
    }
  });

  it('drops non-allowlisted senders without starting a turn', async () => {
    const h = await startHarness({ allowlist: '+49 170 1234567' });
    try {
      await postWebhook(h.base, SECRET, inbound({ from_number: '+15559999999' }));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(h.chatCalls.length, 0);

      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.chatCalls.length === 1, 'allowlisted turn');
    } finally {
      await h.close();
    }
  });

  it('deduplicates webhook retries on message_handle', async () => {
    const h = await startHarness();
    try {
      const body = inbound({ message_handle: 'mh-retry' });
      await postWebhook(h.base, SECRET, body);
      await postWebhook(h.base, SECRET, body);
      await waitFor(() => h.chatCalls.length === 1, 'first turn');
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(h.chatCalls.length, 1, 'retry produced no second turn');
    } finally {
      await h.close();
    }
  });
});

describe('plugin.activate — channel-key directory', () => {
  it('registers the configured line on activate and unregisters on close', async () => {
    const h = await startHarness();
    try {
      assert.equal(h.directories.length, 1);
      const dir = h.directories[0];
      assert.equal(dir?.channelType, 'imessage');
      assert.equal(dir?.originPluginId, 'imessage-channel');
      const keys = await dir!.listKeys();
      assert.equal(keys.length, 1);
      assert.equal(keys[0]?.key, LINE);
      assert.ok(keys[0]?.label.includes(LINE));
    } finally {
      await h.close();
    }
    assert.deepEqual(h.unregistered, ['imessage']);
  });
});

describe('plugin.activate — answer-link round trip', () => {
  const CHOICE_ANSWER: SemanticAnswer = {
    text: 'Ich habe zwei Slots gefunden.',
    interactive: {
      kind: 'choice',
      question: 'Welcher Slot?',
      options: [
        { label: 'Di 10:00', value: 'slot-di' },
        { label: 'Mi 14:30', value: 'slot-mi' },
      ],
    },
  } as SemanticAnswer;

  it('appends a capability URL, accepts the pick, and drives the follow-up turn', async () => {
    const h = await startHarness({ public_base_url: 'https://omadia.example.com' }, {}, { admitDecorations: ADMIT_ALL });
    try {
      scriptedAnswers = [CHOICE_ANSWER, { text: 'Di ist gebucht.' }];

      await postWebhook(h.base, SECRET, inbound({ content: 'Buche einen Slot' }));
      await waitFor(() => h.sends.length === 2, 'choice text bubble + link bubble');

      // Two bubbles, in order: the self-sufficient text (no URL inside), then
      // the bare URL so iMessage can unfurl it into a preview card.
      const text = String(h.sends[0]?.body.content);
      assert.ok(text.includes('1) Di 10:00'), `text bubble must list the options, got:\n${text}`);
      assert.ok(!text.includes('http'), 'text bubble must not embed the URL');
      const link = String(h.sends[1]?.body.content);
      const match = /^https:\/\/omadia\.example\.com\/api\/imessage\/a\/([A-Za-z0-9_-]+)$/.exec(link);
      assert.ok(match, `second bubble must be exactly the answer link, got:\n${link}`);
      const token = match![1]!;

      // The fallback page is up and side-effect free.
      const page = await fetch(`${h.base}/a/${token}`);
      assert.equal(page.status, 200);

      // Pick via the capability URL → 202, then the detached follow-up turn
      // answers back into the SAME iMessage conversation session.
      const reply = await fetch(`${h.base}/answers/${token}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'slot-di' }),
      });
      assert.equal(reply.status, 202);
      await waitFor(() => h.sends.length === 3, 'follow-up bubble');

      assert.equal(h.chatCalls[1]?.userMessage, 'slot-di');
      assert.equal(h.chatCalls[1]?.sessionScope, `imessage:${SENDER}`);
      assert.equal(h.sends[2]?.body.content, 'Di ist gebucht.');

      // The link is single-use.
      const second = await fetch(`${h.base}/answers/${token}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'slot-mi' }),
      });
      assert.equal(second.status, 409);
    } finally {
      await h.close();
    }
  });

  it('invalidates a pending link when the user replies by text instead', async () => {
    const h = await startHarness({ public_base_url: 'https://omadia.example.com' }, {}, { admitDecorations: ADMIT_ALL });
    try {
      scriptedAnswers = [CHOICE_ANSWER, { text: 'Ok!' }];

      await postWebhook(h.base, SECRET, inbound({ content: 'Buche einen Slot' }));
      await waitFor(() => h.sends.length === 2, 'choice text bubble + link bubble');
      const token = /\/a\/([A-Za-z0-9_-]+)/.exec(String(h.sends[1]?.body.content))![1]!;

      // The user answers in iMessage — the pending link must 409 afterwards.
      await postWebhook(h.base, SECRET, inbound({ content: 'Di 10:00' }));
      await waitFor(() => h.sends.length === 3, 'text-reply turn');

      const late = await fetch(`${h.base}/answers/${token}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'slot-di' }),
      });
      assert.equal(late.status, 409);
    } finally {
      await h.close();
    }
  });

  it('degrades to the numbered text list when public_base_url is not configured', async () => {
    const h = await startHarness();
    try {
      scriptedAnswers = [CHOICE_ANSWER];
      await postWebhook(h.base, SECRET, inbound({ content: 'Buche einen Slot' }));
      await waitFor(() => h.sends.length === 1, 'choice bubble');
      const bubble = String(h.sends[0]?.body.content);
      assert.ok(bubble.includes('2) Mi 14:30'));
      assert.ok(!bubble.includes('/api/imessage/a/'), 'no link without public_base_url');
    } finally {
      await h.close();
    }
  });

  it('sends no answer link while the registry does not declare it for iMessage', async () => {
    const h = await startHarness({ public_base_url: 'https://omadia.example.com' });
    try {
      scriptedAnswers = [CHOICE_ANSWER];
      await postWebhook(h.base, SECRET, inbound({ content: 'Buche einen Slot' }));
      await waitFor(() => h.sends.length === 1, 'choice bubble');
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(h.sends.length, 1, 'no URL bubble');
      assert.ok(!String(h.sends[0]?.body.content).includes('http'));
    } finally {
      await h.close();
    }
  });

  it('turns a bare number into the option it names, once', async () => {
    const h = await startHarness();
    try {
      scriptedAnswers = [CHOICE_ANSWER, { text: 'Mi ist gebucht.' }, { text: 'Ok.' }];
      await postWebhook(h.base, SECRET, inbound({ content: 'Buche einen Slot' }));
      await waitFor(() => h.sends.length === 1, 'choice bubble');
      await postWebhook(h.base, SECRET, inbound({ content: '2' }));
      await waitFor(() => h.sends.length === 2, 'answer to the pick');
      assert.equal(h.chatCalls[1]?.userMessage, 'slot-mi');
      // The question is consumed: a later "2" is just text again.
      await postWebhook(h.base, SECRET, inbound({ content: '2' }));
      await waitFor(() => h.sends.length === 3, 'plain turn');
      assert.equal(h.chatCalls[2]?.userMessage, '2');
    } finally {
      await h.close();
    }
  });
});

describe('plugin.activate — US7 Agent binding (channelResolver)', () => {
  interface Probe {
    channelType: string;
    channelKey: string;
  }

  /** A ChatAgent that records the turns it was asked to handle. */
  function recordingAgent(calls: string[], label: string) {
    return {
      chat: async (input: { userMessage: string }): Promise<SemanticAnswer> => {
        calls.push(`${label}:${input.userMessage}`);
        return { text: `von ${label}`, speaker: { kind: 'agent', agentId: label, slug: label, displayName: label } };
      },
    };
  }

  async function runWithResolver(
    resolve: (channelType: string, channelKey: string) => unknown,
  ): Promise<{ probes: Probe[]; harness: Harness }> {
    const probes: Probe[] = [];
    const harness = await startHarness(
      {},
      {
        channelResolver: {
          resolve: (channelType: string, channelKey: string) => {
            probes.push({ channelType, channelKey });
            return resolve(channelType, channelKey);
          },
        },
      },
    );
    return { probes, harness };
  }

  it('probes the sender key before the line key, and a bound sender wins', async () => {
    const bound: string[] = [];
    const { probes, harness } = await runWithResolver((_t, key) =>
      key === SENDER
        ? { decision: 'bound', chatAgent: recordingAgent(bound, 'sender-agent') }
        : { decision: 'reject' },
    );
    try {
      await postWebhook(harness.base, SECRET, inbound());
      await waitFor(() => bound.length === 1, 'bound agent handled the turn');
      // Most-specific first: a bound sender must short-circuit before the line
      // is even asked about.
      assert.deepEqual(probes, [{ channelType: 'imessage', channelKey: SENDER }]);
      assert.equal(harness.chatCalls.length, 0, 'the default agent must not run');
    } finally {
      await harness.close();
    }
  });

  it('falls back to a binding on the line when the sender is unbound', async () => {
    const lineCalls: string[] = [];
    const { probes, harness } = await runWithResolver((_t, key) =>
      key === LINE
        ? { decision: 'bound', chatAgent: recordingAgent(lineCalls, 'line-agent') }
        : { decision: 'reject' },
    );
    try {
      await postWebhook(harness.base, SECRET, inbound());
      await waitFor(() => lineCalls.length === 1, 'line-bound agent handled the turn');
      assert.deepEqual(probes.map((p) => p.channelKey), [SENDER, LINE]);
      assert.equal(harness.chatCalls.length, 0);
    } finally {
      await harness.close();
    }
  });

  it('a reject with a no_agent notice on the sender still lets the line binding answer', async () => {
    const lineCalls: string[] = [];
    const { probes, harness } = await runWithResolver((_t, key) =>
      key === LINE
        ? { decision: 'bound', chatAgent: recordingAgent(lineCalls, 'line-agent') }
        : { decision: 'reject', notice: { code: 'no_agent', text: 'Schreib /agent Name.', locale: 'de' } },
    );
    try {
      await postWebhook(harness.base, SECRET, inbound());
      await waitFor(() => lineCalls.length === 1, 'line-bound agent handled the turn');
      assert.deepEqual(probes.map((p) => p.channelKey), [SENDER, LINE]);
    } finally {
      await harness.close();
    }
  });

  it('there is no fallback: the legacy "fallback" decision is not an answer', async () => {
    const fallback: string[] = [];
    const { harness } = await runWithResolver(() => ({
      decision: 'fallback',
      chatAgent: recordingAgent(fallback, 'fallback-agent'),
    }));
    try {
      await postWebhook(harness.base, SECRET, inbound());
      await waitFor(() => harness.sends.length === 1, 'refusal notice sent');
      assert.equal(fallback.length, 0, 'a fallback agent must never answer');
      assert.match(String(harness.sends[0]?.body.content), /kein Agent zugewiesen/);
    } finally {
      await harness.close();
    }
  });

  it('rank: a bound answer on the sender key is final, the line binding is not asked (selection key = narrowest key)', async () => {
    const senderCalls: string[] = [];
    const lineCalls: string[] = [];
    const { probes, harness } = await runWithResolver((_t, key) =>
      key === SENDER
        ? { decision: 'bound', chatAgent: recordingAgent(senderCalls, 'sender-or-default-agent') }
        : { decision: 'bound', chatAgent: recordingAgent(lineCalls, 'line-agent') },
    );
    try {
      await postWebhook(harness.base, SECRET, inbound());
      await waitFor(() => senderCalls.length === 1, 'sender-key agent answered');
      assert.deepEqual(probes.map((p) => p.channelKey), [SENDER]);
      assert.deepEqual(lineCalls, [], 'a line binding never beats the sender key');
    } finally {
      await harness.close();
    }
  });

  it('never falls back to the chatAgent@1 singleton while a resolver is published, refusals included', async () => {
    const { harness } = await runWithResolver(() => ({ decision: 'reject' }));
    try {
      await postWebhook(harness.base, SECRET, inbound());
      await waitFor(() => harness.sends.length === 1, 'refusal notice sent');
      assert.equal(harness.chatCalls.length, 0, 'the singleton must not run');
    } finally {
      await harness.close();
    }
  });

  it('activates without chatAgent@1 when a resolver answers every turn', async () => {
    const bound: string[] = [];
    const h = await startHarness(
      {},
      {
        chatAgent: undefined,
        channelResolver: {
          resolve: () => ({ decision: 'bound', chatAgent: recordingAgent(bound, 'resolved') }),
        },
      },
    );
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => bound.length === 1, 'resolved agent answered');
    } finally {
      await h.close();
    }
  });

  it('without a resolver and without chatAgent@1 the sender gets the failure notice', async () => {
    const h = await startHarness({}, { chatAgent: undefined });
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.sends.length === 1, 'failure notice');
      assert.match(String(h.sends[0]?.body.content), /Fehler aufgetreten/);
    } finally {
      await h.close();
    }
  });

  /** What the operator sees on the admin page. */
  async function channelStatus(h: Harness): Promise<{ status: string; lastError: string | null }> {
    const res = await fetch(`${h.adminBase}/api/status`);
    const body = (await res.json()) as { status: string; lastError: string | null };
    return { status: body.status, lastError: body.lastError };
  }

  it('refuses a conversation every key rejects — no agent runs, the sender is told, the status stays connected', async () => {
    const { probes, harness } = await runWithResolver(() => ({ decision: 'reject' }));
    try {
      await postWebhook(harness.base, SECRET, inbound());
      await waitFor(() => harness.sends.length === 1, 'refusal notice sent');
      // Both keys were asked before giving up.
      assert.deepEqual(probes.map((p) => p.channelKey), [SENDER, LINE]);
      // byte5ai/omadia#1598: a rejected conversation is refused. It must not be
      // handed to the default agent, whose own refusal used to come back as
      // "an error occurred, try again".
      assert.equal(harness.chatCalls.length, 0, 'the default agent must not run');
      const notice = String(harness.sends[0]?.body.content);
      assert.match(notice, /kein Agent zugewiesen/);
      assert.doesNotMatch(notice, /versuche es erneut/, 'retrying cannot help an unbound conversation');
      assert.equal(harness.sends[0]?.body.number, SENDER);
      // A missing binding is not a channel fault.
      assert.deepEqual(await channelStatus(harness), { status: 'connected', lastError: null });
    } finally {
      await harness.close();
    }
  });

  it('refuses the turn when the resolver throws — never another orchestrator', async () => {
    const { harness } = await runWithResolver(() => {
      throw new Error('resolver exploded');
    });
    try {
      await postWebhook(harness.base, SECRET, inbound());
      await waitFor(() => harness.sends.length === 1, 'failure notice sent');
      // Whether a binding exists is unknown, so no agent may answer in its
      // place. A resolver hiccup is transient: "try again" is honest here.
      assert.equal(harness.chatCalls.length, 0, 'the default agent must not run');
      assert.match(String(harness.sends[0]?.body.content), /versuche es erneut/);
      assert.ok(
        harness.logs.some((l) => l.includes('the channel resolver failed')),
        'the resolver failure must reach the log',
      );
      assert.deepEqual(await channelStatus(harness), { status: 'connected', lastError: null });
    } finally {
      await harness.close();
    }
  });

  it('answers a later turn once the conversation is bound', async () => {
    const bound: string[] = [];
    let isBound = false;
    const { harness } = await runWithResolver(() =>
      isBound
        ? { decision: 'bound', chatAgent: recordingAgent(bound, 'line-agent') }
        : { decision: 'reject' },
    );
    try {
      await postWebhook(harness.base, SECRET, inbound({ message_handle: 'm-unbound' }));
      await waitFor(() => harness.sends.length === 1, 'refusal notice sent');
      // The resolver is asked per turn — a binding added afterwards takes
      // effect without reactivating the channel.
      isBound = true;
      await postWebhook(harness.base, SECRET, inbound({ message_handle: 'm-bound' }));
      await waitFor(() => bound.length === 1, 'bound agent handled the second turn');
      assert.equal(harness.sends[1]?.body.content, 'von line-agent');
    } finally {
      await harness.close();
    }
  });
});

describe('plugin.activate — agents as colleagues (spec 2042)', () => {
  const MIRA = { kind: 'agent', agentId: 'ag-mira', slug: 'mira', displayName: 'Mira' } as const;
  const BEN = { kind: 'agent', agentId: 'ag-ben', slug: 'ben', displayName: 'Ben' } as const;

  const agentReturning = (answer: SemanticAnswer) => ({
    chat: async (): Promise<SemanticAnswer> => answer,
  });

  const bubbles = (h: Harness): string[] => h.sends.map((s) => String(s.body.content));

  it('forwards "/agent Mira" verbatim as ordinary text and renders the kernel notice as plain system text', async () => {
    const seen: string[] = [];
    const notice = {
      text: 'Du sprichst jetzt mit Mira.',
      speaker: { kind: 'system' },
      systemNotice: { code: 'agent_selected', text: 'Du sprichst jetzt mit Mira.', locale: 'de' },
    } as unknown as SemanticAnswer;
    const h = await startHarness(
      {},
      {
        channelResolver: {
          resolve: () => ({
            decision: 'bound',
            chatAgent: {
              chat: async (input: { userMessage: string }) => {
                seen.push(input.userMessage);
                return notice;
              },
            },
          }),
        },
      },
    );
    try {
      await postWebhook(h.base, SECRET, inbound({ content: '/agent Mira' }));
      await waitFor(() => h.sends.length === 1, 'selection notice');
      assert.deepEqual(seen, ['/agent Mira'], 'no channel-side parsing of /agent');
      assert.deepEqual(bubbles(h), ['Du sprichst jetzt mit Mira.']);
    } finally {
      await h.close();
    }
  });

  it('passes the sender principal to the resolver so the kernel can apply the selection', async () => {
    const contexts: unknown[] = [];
    const h = await startHarness(
      {},
      {
        channelResolver: {
          resolve: (_t: string, _k: string, context?: unknown) => {
            contexts.push(context);
            return { decision: 'bound', chatAgent: agentReturning({ text: 'ok' } as SemanticAnswer) };
          },
        },
      },
    );
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.sends.length === 1, 'answer');
      assert.deepEqual(contexts, [{ principal: `user:custom:${SENDER}` }]);
      // Sendblue does not tell the person's language: no locale is passed, the
      // kernel's notices come in its default instead of in a guessed one.
      assert.ok(!('locale' in (contexts[0] as object)), 'locale is omitted unless the channel knows it');
    } finally {
      await h.close();
    }
  });

  it('sends the kernel notice of an unavailable agent and does not hand the turn to the line agent', async () => {
    const lineCalls: string[] = [];
    const h = await startHarness(
      {},
      {
        channelResolver: {
          resolve: (_t: string, key: string) =>
            key === SENDER
              ? {
                  decision: 'reject',
                  notice: {
                    code: 'agent_disabled',
                    text: 'Mira ist zurzeit deaktiviert.',
                    locale: 'de',
                    agent: { slug: 'mira', displayName: 'Mira' },
                  },
                }
              : { decision: 'bound', chatAgent: recordingAgentFor(lineCalls) },
        },
      },
    );
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.sends.length === 1, 'notice');
      assert.deepEqual(bubbles(h), ['Mira ist zurzeit deaktiviert.']);
      assert.deepEqual(lineCalls, []);
    } finally {
      await h.close();
    }
  });

  function recordingAgentFor(calls: string[]) {
    return {
      chat: async (input: { userMessage: string }): Promise<SemanticAnswer> => {
        calls.push(input.userMessage);
        return { text: 'von der Leitung' } as SemanticAnswer;
      },
    };
  }

  it('shows no name line for one agent, a name line once a second agent speaks', async () => {
    let agent: typeof MIRA | typeof BEN = MIRA;
    const h = await startHarness(
      {},
      {
        channelResolver: {
          resolve: () => ({
            decision: 'bound',
            chatAgent: {
              chat: async (): Promise<SemanticAnswer> =>
                ({ text: 'Antwort.', speaker: agent }) as SemanticAnswer,
            },
          }),
        },
      },
    );
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.sends.length === 1, 'first answer');
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.sends.length === 2, 'second answer');
      assert.deepEqual(bubbles(h), ['Antwort.', 'Antwort.'], 'one agent: no name line, ever');
      agent = BEN;
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.sends.length === 3, 'third answer');
      assert.equal(bubbles(h)[2], 'Ben: Antwort.', 'the speaker changed: a name line');
    } finally {
      await h.close();
    }
  });

  it('attributes a colleague contribution in plain text', async () => {
    scriptedAnswers = [
      {
        text: 'Ich habe Mira gefragt.',
        speaker: BEN,
        contributions: [{ id: 'c1', speaker: MIRA, text: 'Das passt.', status: 'delivered' }],
      } as unknown as SemanticAnswer,
    ];
    const h = await startHarness();
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.sends.length === 1, 'answer');
      assert.deepEqual(bubbles(h), ['Ich habe Mira gefragt.\n\nMira: Das passt.']);
    } finally {
      await h.close();
    }
  });

  it('acknowledges long work exactly once and then answers (pace)', async () => {
    const clock = manualClock();
    let release: (a: SemanticAnswer) => void = () => undefined;
    const h = await startHarness(
      {},
      {
        channelResolver: {
          resolve: () => ({
            decision: 'bound',
            speaker: MIRA,
            chatAgent: {
              chat: () => new Promise<SemanticAnswer>((r) => (release = r)),
            },
          }),
        },
      },
      { paceClock: clock.clock },
    );
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => clock.pending() > 0, 'pace timer armed');
      await clock.advance(7_999);
      assert.equal(h.sends.length, 0, 'no acknowledgement before the threshold');
      await clock.advance(2);
      await waitFor(() => h.sends.length === 1, 'acknowledgement');
      await clock.advance(120_000);
      assert.equal(h.sends.length, 1, 'one acknowledgement, no progress chatter');
      assert.equal(bubbles(h)[0], 'Ich kümmere mich darum, das dauert einen Moment.');
      release({ text: 'Fertig.', speaker: MIRA } as unknown as SemanticAnswer);
      await waitFor(() => h.sends.length === 2, 'the answer');
      assert.equal(bubbles(h)[1], 'Fertig.');
    } finally {
      await h.close();
    }
  });

  it('sends no acknowledgement for a fast answer (pace)', async () => {
    const clock = manualClock();
    const h = await startHarness({}, {}, { paceClock: clock.clock });
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.sends.length === 1, 'answer');
      await clock.advance(60_000);
      assert.equal(h.sends.length, 1);
    } finally {
      await h.close();
    }
  });

  for (const command of ['/agent', '/agent Mira', '/agents']) {
    it(`passes "${command}" to the resolver ChatAgent as plain text, unchanged`, async () => {
      const seen: string[] = [];
      const h = await startHarness(
        {},
        {
          channelResolver: {
            resolve: () => ({
              decision: 'bound',
              speaker: MIRA,
              chatAgent: {
                chat: async (input: { userMessage: string }): Promise<SemanticAnswer> => {
                  seen.push(input.userMessage);
                  return {
                    text: 'Erledigt.',
                    speaker: { kind: 'system' },
                    systemNotice: { code: 'agent_directory', text: 'Erledigt.', locale: 'de' },
                  } as unknown as SemanticAnswer;
                },
              },
            }),
          },
        },
      );
      try {
        await postWebhook(h.base, SECRET, inbound({ content: command }));
        await waitFor(() => h.sends.length === 1, 'notice');
        assert.deepEqual(seen, [command], 'no channel-side routing of the command');
        assert.deepEqual(bubbles(h), ['Erledigt.']);
      } finally {
        await h.close();
      }
    });
  }

  it('on a reject, /agent still reaches the resolver ChatAgent and its system answer is what the sender gets', async () => {
    const seen: string[] = [];
    const h = await startHarness(
      {},
      {
        channelResolver: {
          resolve: () => ({
            decision: 'reject',
            notice: { code: 'no_agent', text: 'Niemand zugewiesen.', locale: 'de' },
            chatAgent: {
              chat: async (input: { userMessage: string }): Promise<SemanticAnswer> => {
                seen.push(input.userMessage);
                return {
                  text: 'Du sprichst jetzt mit Mira.',
                  speaker: { kind: 'system' },
                  systemNotice: { code: 'agent_selected', text: 'Du sprichst jetzt mit Mira.', locale: 'de' },
                } as unknown as SemanticAnswer;
              },
            },
          }),
        },
      },
    );
    try {
      await postWebhook(h.base, SECRET, inbound({ content: '/agent Mira' }));
      await waitFor(() => h.sends.length === 1, 'selection notice');
      assert.deepEqual(seen, ['/agent Mira']);
      assert.deepEqual(bubbles(h), ['Du sprichst jetzt mit Mira.']);
      assert.equal(h.chatCalls.length, 0, 'the default agent never runs on a reject');
    } finally {
      await h.close();
    }
  });

  it('on a reject, words the resolver ChatAgent returns under an agent speaker are withheld: the notice goes out as system (INV-7)', async () => {
    const h = await startHarness(
      {},
      {
        channelResolver: {
          resolve: () => ({
            decision: 'reject',
            notice: { code: 'agent_disabled', text: 'Mira ist zurzeit deaktiviert.', locale: 'de' },
            chatAgent: agentReturning({ text: 'Ich antworte trotzdem.', speaker: MIRA } as unknown as SemanticAnswer),
          }),
        },
      },
    );
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.sends.length === 1, 'notice');
      assert.deepEqual(bubbles(h), ['Mira ist zurzeit deaktiviert.']);
      assert.ok(h.logs.some((l) => l.includes('did not answer as system')));
    } finally {
      await h.close();
    }
  });

  it('withholds an answer without any speaker and tells the sender with a system notice (fail-closed)', async () => {
    scriptedAnswers = [{ text: 'Ohne Absender.', speaker: undefined }];
    const h = await startHarness();
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.sends.length === 1, 'failure notice');
      assert.doesNotMatch(bubbles(h)[0] ?? '', /Ohne Absender/);
      assert.match(bubbles(h)[0] ?? '', /Fehler aufgetreten/);
      assert.ok(h.logs.some((l) => l.includes('withheld')));
    } finally {
      await h.close();
    }
  });

  it("stamps an answer that has no speaker with the one the resolver named before the turn", async () => {
    let speaker: typeof MIRA | typeof BEN = MIRA;
    const h = await startHarness(
      {},
      {
        channelResolver: {
          resolve: () => ({
            decision: 'bound',
            speaker,
            chatAgent: agentReturning({ text: 'Antwort.' } as SemanticAnswer),
          }),
        },
      },
    );
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.sends.length === 1, 'first answer');
      speaker = BEN;
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.sends.length === 2, 'second answer');
      assert.deepEqual(bubbles(h), ['Antwort.', 'Ben: Antwort.']);
    } finally {
      await h.close();
    }
  });

  it("sends the pace acknowledgement under the agent's own speaker, not as system", async () => {
    const clock = manualClock();
    let speaker: typeof MIRA | typeof BEN = BEN;
    let release: (a: SemanticAnswer) => void = () => undefined;
    let slow = false;
    const h = await startHarness(
      {},
      {
        channelResolver: {
          resolve: () => ({
            decision: 'bound',
            speaker,
            chatAgent: {
              chat: (): Promise<SemanticAnswer> =>
                slow
                  ? new Promise<SemanticAnswer>((r) => (release = r))
                  : Promise.resolve({ text: 'Erste Antwort.', speaker: BEN } as unknown as SemanticAnswer),
            },
          }),
        },
      },
      { paceClock: clock.clock },
    );
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.sends.length === 1, 'first answer');
      speaker = MIRA;
      slow = true;
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => clock.pending() > 0, 'pace timer armed');
      await clock.advance(8_001);
      await waitFor(() => h.sends.length === 2, 'acknowledgement');
      // A `system` voice would carry no name; the speaker changed from Ben to
      // Mira, so only an agent-voiced message gets the name line.
      assert.equal(bubbles(h)[1], 'Mira: Ich kümmere mich darum, das dauert einen Moment.');
      release({ text: 'Fertig.', speaker: MIRA } as unknown as SemanticAnswer);
      await waitFor(() => h.sends.length === 3, 'the answer');
      // Two agents have now spoken in this conversation: the name line stays.
      assert.equal(bubbles(h)[2], 'Mira: Fertig.');
    } finally {
      await h.close();
    }
  });

  it('sends no acknowledgement when no speaker was resolved before the turn (no resolver): typing only', async () => {
    const clock = manualClock();
    let release: (a: SemanticAnswer) => void = () => undefined;
    const h = await startHarness(
      {},
      {
        chatAgent: { agent: { chat: () => new Promise<SemanticAnswer>((r) => (release = r)) } },
      },
      { paceClock: clock.clock },
    );
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => clock.pending() > 0, 'pace timer armed');
      await clock.advance(30_000);
      assert.equal(h.sends.length, 0, 'no acknowledgement under a name nobody resolved');
      release({ text: 'Fertig.', speaker: MIRA } as unknown as SemanticAnswer);
      await waitFor(() => h.sends.length === 1, 'the answer');
    } finally {
      await h.close();
    }
  });
});

describe('plugin.activate — send providers and conversation events (spec 2042 criterion 30)', () => {
  interface Registered {
    channelId: string;
    provider: TargetedSendProvider | ConversationSendProvider;
  }

  async function startWithCore(config: Record<string, string> = {}, coreExtra: Record<string, unknown> = {}) {
    const targeted: Registered[] = [];
    const conversation: Registered[] = [];
    const events: ConversationMessageEvent[] = [];
    const h = await startHarness({ ...config }, {}, {}, {
      registerTargetedSendProvider: (channelId: string, provider: TargetedSendProvider) =>
        targeted.push({ channelId, provider }),
      registerConversationSendProvider: (channelId: string, provider: ConversationSendProvider) =>
        conversation.push({ channelId, provider }),
      emitConversationMessage: (event: ConversationMessageEvent) => events.push(event),
      ...coreExtra,
    });
    const dm = targeted[0]?.provider as TargetedSendProvider;
    const conv = conversation[0]?.provider as ConversationSendProvider;
    return { h, dm, conv, targeted, conversation, events };
  }

  const bubbles = (h: Harness): string[] => h.sends.map((s) => String(s.body.content));
  const PRINCIPAL = `user:custom:${SENDER}`;

  const CONSENT_CARD: QuestionCard = {
    cardId: 'proposal-7',
    title: 'Termin Donnerstag 10:00',
    questions: [{ id: 'q1', kind: 'consent', label: 'Passt das für dich?' }],
  };

  it('registers both providers under the channel id and declares plain text only', async () => {
    const { h, targeted, conversation } = await startWithCore();
    try {
      assert.equal(targeted.length, 1);
      assert.equal(conversation.length, 1);
      assert.equal(targeted[0]?.channelId, 'imessage-channel');
      // The kernel posts polls and cards as numbered text for a channel that
      // declares neither, and reads the typed reply itself.
      for (const registered of [targeted[0], conversation[0]]) {
        assert.equal((registered?.provider as TargetedSendProvider).supports, undefined);
      }
    } finally {
      await h.close();
    }
  });

  it('starts without the send seams on a host that predates them', async () => {
    const h = await startHarness();
    try {
      assert.ok(h.logs.some((l) => l.includes('activated')));
    } finally {
      await h.close();
    }
  });

  it('DMs a user by principal: plain text, one bubble, delivered with the conversation', async () => {
    const { h, dm } = await startWithCore();
    try {
      const out = await dm.sendToUser({ principalId: PRINCIPAL }, { text: '**Erinnerung:** Bericht fällig.' });
      assert.equal(out.outcome, 'delivered');
      assert.deepEqual(bubbles(h), ['Erinnerung: Bericht fällig.']);
      assert.equal(h.sends[0]?.body.number, SENDER);
      assert.equal(out.outcome === 'delivered' ? out.conversationId : undefined, SENDER);
      assert.equal(out.outcome === 'delivered' ? out.messageId : undefined, 'out-1');
    } finally {
      await h.close();
    }
  });

  it('posts into a conversation addressed by the sender number, a numbered question included', async () => {
    const { h, conv } = await startWithCore();
    try {
      // What the kernel hands over for a poll it posts as text: already plain.
      const text = 'Wann treffen wir uns?\n1) Di 10:00\n2) Mi 14:30';
      const out = await conv.sendToConversation(SENDER, { text });
      assert.equal(out.outcome, 'delivered');
      assert.deepEqual(bubbles(h), [text], 'the numbered list survives the plain-text degrade');
    } finally {
      await h.close();
    }
  });

  it('attachments degrade to a link line (no outbound media)', async () => {
    const { h, dm } = await startWithCore();
    try {
      await dm.sendToUser(
        { principalId: PRINCIPAL },
        { text: 'Bericht.', attachments: [{ kind: 'file', url: 'https://x.test/r.pdf', altText: 'Bericht.pdf' }] },
      );
      assert.deepEqual(bubbles(h), ['Bericht.\n\nBericht.pdf: https://x.test/r.pdf']);
    } finally {
      await h.close();
    }
  });

  it('returns unreachable, never throws: a principal that is not an iMessage number', async () => {
    const { h, dm } = await startWithCore();
    try {
      for (const principalId of ['user:anna@example.com', 'user:teams-aad:abc', 'role:hr', 'user:custom:nope']) {
        const out = await dm.sendToUser({ principalId }, { text: 'Hallo' });
        assert.equal(out.outcome, 'unreachable', principalId);
      }
      assert.equal(h.sends.length, 0);
    } finally {
      await h.close();
    }
  });

  it('refuses a number outside the allowlist as not_permitted and sends nothing', async () => {
    const { h, dm } = await startWithCore({ allowlist: '+491700000000' });
    try {
      const out = await dm.sendToUser({ principalId: PRINCIPAL }, { text: 'Hallo' });
      assert.deepEqual(out, {
        outcome: 'unreachable',
        code: 'not_permitted',
        message: "the number is not on this channel's allowlist",
      });
      assert.equal(h.sends.length, 0);
    } finally {
      await h.close();
    }
  });

  it('returns a provider failure as unreachable channel_error', async () => {
    const { h, dm } = await startWithCore();
    try {
      sendblueFailStatus = 400;
      const out = await dm.sendToUser({ principalId: PRINCIPAL }, { text: 'Hallo' });
      assert.equal(out.outcome, 'unreachable');
      assert.equal(out.outcome === 'unreachable' ? out.code : undefined, 'channel_error');
    } finally {
      await h.close();
    }
  });

  it('refuses a poll or card should one arrive anyway, and posts nothing half-way', async () => {
    const { h, dm, conv } = await startWithCore();
    try {
      const poll = { pollId: 'p', question: 'Q?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
      for (const out of [
        await dm.sendToUser({ principalId: PRINCIPAL }, { text: 'x', poll }),
        await conv.sendToConversation(SENDER, { text: '', card: CONSENT_CARD }),
      ]) {
        assert.equal(out.outcome, 'unreachable');
        assert.equal(out.outcome === 'unreachable' ? out.code : undefined, 'channel_error');
      }
      assert.equal(h.sends.length, 0);
    } finally {
      await h.close();
    }
  });

  it('sendTyping is best-effort and posts no message', async () => {
    const { h, conv } = await startWithCore();
    try {
      await conv.sendTyping?.(SENDER);
      assert.equal(h.sends.length, 0);
    } finally {
      await h.close();
    }
  });

  it('reports an inbound message as a created event: direct, addressed to the line, no reply-to', async () => {
    const { h, events } = await startWithCore();
    try {
      await postWebhook(
        h.base,
        SECRET,
        inbound({ content: ' 2 ', message_handle: 'in-77', date_sent: '2026-11-20T10:05:00Z' }),
      );
      await waitFor(() => h.chatCalls.length === 1, 'the ordinary turn still runs');
      assert.deepEqual(events, [
        {
          channelId: 'imessage-channel',
          channelType: 'imessage',
          conversationId: SENDER,
          conversationType: 'direct',
          receivedByChannelKey: LINE,
          messageId: 'in-77',
          revision: 0,
          kind: 'created',
          author: { kind: 'custom', id: SENDER },
          text: '2',
          occurredAt: '2026-11-20T10:05:00.000Z',
          addressedToBot: true,
        },
      ]);
      assert.ok(!('replyToMessageId' in (events[0] as object)), 'Sendblue reports no reply-to id');
      assert.equal(h.chatCalls[0]?.userMessage, ' 2 ', 'the text reaches the agent as typed');
    } finally {
      await h.close();
    }
  });

  it('a dropped message (not allowlisted, duplicate) is not reported', async () => {
    const { h, events } = await startWithCore({ allowlist: '+491700000000' });
    try {
      await postWebhook(h.base, SECRET, inbound());
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(events, []);
      assert.equal(h.chatCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('starts no turn where the kernel reads every message of the conversation itself (delivery all)', async () => {
    const asked: unknown[] = [];
    const { h, events } = await startWithCore(
      {},
      {
        conversationDelivery: (...args: unknown[]) => {
          asked.push(args);
          return 'all';
        },
      },
    );
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => events.length === 1, 'event reported');
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(asked, [['imessage', SENDER, LINE]]);
      assert.equal(h.chatCalls.length, 0, 'the event is the only path');
    } finally {
      await h.close();
    }
  });

  it('delivery addressed keeps the ordinary turn', async () => {
    const { h, events } = await startWithCore({}, { conversationDelivery: () => 'addressed' });
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.chatCalls.length === 1, 'ordinary turn');
      assert.equal(events.length, 1);
    } finally {
      await h.close();
    }
  });

  it('a failing report never fails the turn', async () => {
    const { h } = await startWithCore(
      {},
      {
        emitConversationMessage: () => {
          throw new Error('kernel down');
        },
      },
    );
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.chatCalls.length === 1, 'ordinary turn');
      assert.ok(h.logs.some((l) => l.includes('report failed')));
    } finally {
      await h.close();
    }
  });

  it('without the emit seam the turn runs as before', async () => {
    const h = await startHarness();
    try {
      await postWebhook(h.base, SECRET, inbound());
      await waitFor(() => h.chatCalls.length === 1, 'ordinary turn');
    } finally {
      await h.close();
    }
  });
});

/** A manual clock: timers fire only when the test advances time. */
function manualClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; every?: number; id: number; done?: boolean }[] = [];
  let nextId = 1;
  const clock: PaceClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, fn, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (h) => {
      const t = timers.find((x) => x.id === h);
      if (t) t.done = true;
    },
    setInterval: (fn, ms) => {
      const t = { at: now + ms, fn, every: ms, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearInterval: (h) => {
      const t = timers.find((x) => x.id === h);
      if (t) t.done = true;
    },
  };
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.done && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.every !== undefined) due.at += due.every;
      else due.done = true;
      due.fn();
      await new Promise((r) => setTimeout(r, 0));
    }
    now = target;
    await new Promise((r) => setTimeout(r, 0));
  };
  return { clock, advance, pending: () => timers.filter((t) => !t.done).length };
}
