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

interface Harness {
  base: string;
  chatCalls: ChatCall[];
  sends: SendblueSend[];
  directories: ChannelKeyDirectory[];
  unregistered: string[];
  logs: string[];
  close(): Promise<void>;
}

/** Next scripted answer(s) the fake orchestrator returns (FIFO, repeats last). */
let scriptedAnswers: SemanticAnswer[] = [{ text: 'Antwort vom Agenten.' }];

async function startHarness(config: Record<string, string> = {}): Promise<Harness> {
  const chatCalls: ChatCall[] = [];
  const sends: SendblueSend[] = [];
  const directories: ChannelKeyDirectory[] = [];
  const unregistered: string[] = [];
  const logs: string[] = [];

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
    routes: { register: (_prefix: string, _router: Router) => () => undefined },
  } as unknown as PluginContext;

  let publicRouter: Router | undefined;
  const core = {
    log: (_level: string, msg: string) => {
      logs.push(msg);
    },
    registerRouter: (_channelId: string, _prefix: string, router: Router) => {
      publicRouter = router;
    },
  };

  const handle = await activate(ctx, core as never);
  assert.ok(publicRouter, 'plugin must register its public router');

  const app = express();
  app.use(express.json()); // the omadia host parses JSON on the root app
  app.use('/api/imessage', publicRouter);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');

  return {
    base: `http://127.0.0.1:${addr.port}/api/imessage`,
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
