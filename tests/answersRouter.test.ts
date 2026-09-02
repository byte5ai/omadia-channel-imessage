import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';

import type { OutgoingChoiceCard } from '@omadia/channel-sdk';

import { AnswerStore, type AnswerEntry } from '../src/answerStore.js';
import { createAnswersRouter, maskPhone } from '../src/answersRouter.js';

const CHOICE: OutgoingChoiceCard = {
  kind: 'choice',
  question: 'Welcher <Slot> & wann?',
  rationale: 'Beide "frei".',
  options: [
    { label: 'Di 10:00', value: 'slot-di' },
    { label: 'Mi 14:30', value: 'slot-mi' },
  ],
};

const HOUR = 60 * 60 * 1000;

// Real express app on an ephemeral port — the mocked-webhook style
// integration the triage plan asks for, without any live provider.
let nowMs = 5_000_000;
let store: AnswerStore;
let replies: Array<{ entry: AnswerEntry; option: { label: string; value: string } }>;
let server: Server;
let base: string;

before(async () => {
  store = new AnswerStore({ ttlMs: HOUR, now: () => nowMs });
  replies = [];
  const app = express();
  app.use(
    '/api/imessage',
    createAnswersRouter({
      store,
      routePrefix: '/api/imessage',
      log: () => undefined,
      onReply: async (entry, option) => {
        replies.push({ entry, option });
      },
    }),
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}/api/imessage`;
});

after(() => server.close());

beforeEach(() => {
  store.clear();
  replies.length = 0;
});

describe('GET /a/:token (fallback page)', () => {
  it('renders the open question with HTML-escaped content', async () => {
    const entry = store.create('+491701234567', CHOICE);
    const res = await fetch(`${base}/a/${entry.token}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Welcher &lt;Slot&gt; &amp; wann?'), 'question escaped');
    assert.ok(!html.includes('<Slot>'), 'no raw HTML injection');
    assert.ok(html.includes('Di 10:00'));
    // no app handoff yet — the page must not advertise a dead omadia:// link
    assert.ok(!html.includes('omadia://'), 'no app-handoff button');
    assert.equal(entry.state, 'open', 'GET is side-effect free');
  });

  it('renders 404 / answered / expired states as friendly pages', async () => {
    assert.equal((await fetch(`${base}/a/unknown`)).status, 404);

    const answered = store.create('+491701234567', CHOICE);
    store.reply(answered.token, 'slot-di');
    const answeredHtml = await (await fetch(`${base}/a/${answered.token}`)).text();
    assert.ok(answeredHtml.includes('Bereits beantwortet'));

    const expired = store.create('+491702222222', CHOICE);
    nowMs += HOUR + 1;
    const expiredHtml = await (await fetch(`${base}/a/${expired.token}`)).text();
    assert.ok(expiredHtml.includes('Link abgelaufen'));
  });
});

describe('GET /answers/:token (JSON payload)', () => {
  it('returns the structured open payload', async () => {
    const entry = store.create('+491701234567', CHOICE);
    const res = await fetch(`${base}/answers/${entry.token}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.state, 'open');
    assert.equal(body.question, CHOICE.question);
    assert.deepEqual(body.interactive, { kind: 'choice', options: CHOICE.options });
    assert.equal(body.conversationHint, 'iMessage · +49 … 67');
  });

  it('maps unknown → 404 and expired → 410', async () => {
    assert.equal((await fetch(`${base}/answers/unknown`)).status, 404);
    const entry = store.create('+491701234567', CHOICE);
    nowMs += HOUR + 1;
    assert.equal((await fetch(`${base}/answers/${entry.token}`)).status, 410);
  });
});

describe('POST /answers/:token/reply', () => {
  const post = (token: string, body: unknown) =>
    fetch(`${base}/answers/${token}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('accepts one valid pick with 202 and drives the detached turn', async () => {
    const entry = store.create('+491701234567', CHOICE);
    const res = await post(entry.token, { value: 'slot-mi' });
    assert.equal(res.status, 202);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.echo, 'Mi 14:30');
    // onReply is fire-and-forget after the 202 — give the microtask a tick.
    await new Promise((r) => setImmediate(r));
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.option.value, 'slot-mi');
    assert.equal(replies[0]?.entry.conversationId, '+491701234567');
  });

  it('validates the body and the option value', async () => {
    const entry = store.create('+491701234567', CHOICE);
    assert.equal((await post(entry.token, {})).status, 400);
    assert.equal((await post(entry.token, { value: 42 })).status, 400);
    assert.equal((await post(entry.token, { value: 'not-an-option' })).status, 400);
    assert.equal(entry.state, 'open', 'invalid attempts must not consume the entry');
  });

  it('maps unknown → 404, second pick → 409, expired → 410; no turns run', async () => {
    assert.equal((await post('unknown', { value: 'x' })).status, 404);

    const entry = store.create('+491701234567', CHOICE);
    await post(entry.token, { value: 'slot-di' });
    assert.equal((await post(entry.token, { value: 'slot-di' })).status, 409);

    const expired = store.create('+491702222222', CHOICE);
    nowMs += HOUR + 1;
    assert.equal((await post(expired.token, { value: 'slot-di' })).status, 410);

    await new Promise((r) => setImmediate(r));
    assert.equal(replies.length, 1, 'only the single accepted pick drove a turn');
  });

  it('409s after a plain-text reply resolved the conversation', async () => {
    const entry = store.create('+491701234567', CHOICE);
    store.resolveOpenForConversation('+491701234567', 'text');
    assert.equal((await post(entry.token, { value: 'slot-di' })).status, 409);
  });
});

describe('maskPhone', () => {
  it('masks down to prefix and trailing digits', () => {
    assert.equal(maskPhone('+491701234567'), '+49 … 67');
    assert.equal(maskPhone('0170'), '…');
  });
});
