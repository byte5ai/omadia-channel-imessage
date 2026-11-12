import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import { describe, it } from 'node:test';

import express, { type Router } from 'express';

import type { ChannelKeyDirectory, SemanticAnswer } from '@omadia/channel-sdk';
import type { PluginContext } from '@omadia/plugin-api';

import { activate } from '../src/plugin.js';

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

async function startHarness(
  config: Record<string, string> = {},
  extraServices: Record<string, unknown> = {},
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
          return next ?? { text: 'Antwort vom Agenten.' };
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
  };

  const handle = await activate(ctx, core as never);

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
    const h = await startHarness({ public_base_url: 'https://omadia.example.com' });
    try {
      scriptedAnswers = [CHOICE_ANSWER, { text: 'Di ist gebucht.' }];

      await postWebhook(h.base, SECRET, inbound({ content: 'Buche einen Slot' }));
      await waitFor(() => h.sends.length === 2, 'choice text bubble + link bubble');

      // Two bubbles, in order: the self-sufficient text (no URL inside), then
      // the bare URL so iMessage can unfurl it into a preview card.
      const text = String(h.sends[0]?.body.content);
      assert.ok(text.includes('• Di 10:00'), `text bubble must list the options, got:\n${text}`);
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
    const h = await startHarness({ public_base_url: 'https://omadia.example.com' });
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

  it('degrades to the plain text list when public_base_url is not configured', async () => {
    const h = await startHarness();
    try {
      scriptedAnswers = [CHOICE_ANSWER];
      await postWebhook(h.base, SECRET, inbound({ content: 'Buche einen Slot' }));
      await waitFor(() => h.sends.length === 1, 'choice bubble');
      const bubble = String(h.sends[0]?.body.content);
      assert.ok(bubble.includes('Bitte antworte mit einer der Optionen.'));
      assert.ok(!bubble.includes('/api/imessage/a/'), 'no link without public_base_url');
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
        return { text: `von ${label}` };
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

  it('prefers an explicit binding over a platform fallback', async () => {
    const fallback: string[] = [];
    const boundCalls: string[] = [];
    const { harness } = await runWithResolver((_t, key) =>
      key === SENDER
        ? { decision: 'fallback', chatAgent: recordingAgent(fallback, 'fallback-agent') }
        : { decision: 'bound', chatAgent: recordingAgent(boundCalls, 'line-agent') },
    );
    try {
      await postWebhook(harness.base, SECRET, inbound());
      await waitFor(() => boundCalls.length === 1, 'bound agent won over the fallback');
      assert.equal(fallback.length, 0, 'a fallback must never beat an explicit binding');
    } finally {
      await harness.close();
    }
  });

  it('uses the remembered fallback when nothing is explicitly bound', async () => {
    const fallback: string[] = [];
    const { harness } = await runWithResolver((_t, key) =>
      key === SENDER
        ? { decision: 'fallback', chatAgent: recordingAgent(fallback, 'fallback-agent') }
        : { decision: 'reject' },
    );
    try {
      await postWebhook(harness.base, SECRET, inbound());
      await waitFor(() => fallback.length === 1, 'fallback agent handled the turn');
      assert.equal(harness.chatCalls.length, 0);
    } finally {
      await harness.close();
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
