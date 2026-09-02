import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import path from 'node:path';
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
      publicBaseUrl: 'https://omadia.example.com/',
      ogAssetsPath: path.resolve(process.cwd(), 'assets/og'),
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

describe('answer page — return-to-conversation deep link', () => {
  // The confirmation hands the user back to the thread. The link target is the
  // Sendblue line (`from_number`), never the recipient's own conversationId —
  // that would open a thread with themselves.
  const SENDBLUE_LINE = '+4915199988877';
  const RECIPIENT = '+491701234567';

  async function pageWith(returnNumber: string | undefined): Promise<string> {
    const local = new AnswerStore({ ttlMs: HOUR, now: () => nowMs });
    const app = express();
    app.use(
      '/api/imessage',
      createAnswersRouter({
        store: local,
        routePrefix: '/api/imessage',
        log: () => undefined,
        onReply: async () => undefined,
        ...(returnNumber === undefined ? {} : { returnNumber }),
      }),
    );
    const srv = app.listen(0);
    await new Promise<void>((resolve) => srv.once('listening', resolve));
    const addr = srv.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const entry = local.create(RECIPIENT, CHOICE);
    const html = await (await fetch(`http://127.0.0.1:${addr.port}/api/imessage/a/${entry.token}`)).text();
    srv.close();
    return html;
  }

  it('renders an sms: link to the Sendblue line, not to the recipient', async () => {
    const html = await pageWith(SENDBLUE_LINE);
    assert.ok(html.includes(`sms:${SENDBLUE_LINE}`), 'deep link targets the configured line');
    assert.ok(!html.includes(`sms:${RECIPIENT}`), 'never links back to the recipient itself');
    assert.ok(html.includes('Zurück zu iMessage'), 'confirmation offers the way back');
  });

  it('falls back to a written instruction when no line is configured', async () => {
    const html = await pageWith(undefined);
    assert.ok(!html.includes('sms:'), 'no dead deep link without a number');
    assert.ok(html.includes('Messages'), 'points at the system back affordance instead');
  });

  it('drops an unusable number instead of rendering a broken link', async () => {
    const html = await pageWith('nicht-gesetzt');
    assert.ok(!html.includes('sms:'), 'garbage in config never becomes an href');
  });

  it('replaces the question with a confirmation instead of appending a status line', async () => {
    const html = await pageWith(SENDBLUE_LINE);
    assert.ok(html.includes('Antwort gesendet'), 'takeover headline is rendered on 202');
    assert.ok(html.includes('card.innerHTML'), 'the question screen is replaced, not annotated');
  });
});

describe('maskPhone', () => {
  it('masks down to prefix and trailing digits', () => {
    assert.equal(maskPhone('+491701234567'), '+49 … 67');
    assert.equal(maskPhone('0170'), '…');
  });
});

describe('GET /a/:token — link-preview (Open Graph) tags', () => {
  it('carries og:url and the og:image banner with absolute URLs', async () => {
    const entry = store.create('+491701234567', CHOICE);
    const html = await (await fetch(`${base}/a/${entry.token}`)).text();
    assert.ok(html.includes('<meta property="og:title" content="Welcher &lt;Slot&gt; &amp; wann?">'));
    assert.ok(
      html.includes(
        `<meta property="og:url" content="https://omadia.example.com/api/imessage/a/${entry.token}">`,
      ),
      'og:url must be absolute and point at the page itself (trailing slash of the origin trimmed)',
    );
    assert.ok(
      html.includes(
        '<meta property="og:image" content="https://omadia.example.com/api/imessage/a/assets/preview.jpg">',
      ),
    );
    assert.ok(html.includes('<meta property="og:image:width" content="1200">'));
    assert.ok(html.includes('<meta property="og:image:height" content="630">'));
  });

  it('serves the banner as image/jpeg, cacheable, without touching /a/:token', async () => {
    const res = await fetch(`${base}/a/assets/preview.jpg`);
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') ?? '').startsWith('image/jpeg'));
    assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.ok(bytes.length > 1000, 'banner must be a real file, not a 404 page');
    assert.deepEqual([...bytes.slice(0, 3)], [0xff, 0xd8, 0xff], 'JPEG magic');
  });

  it('serves the banner from a dot-directory (core installs under .uploaded-packages/)', async () => {
    const { mkdtempSync, mkdirSync, copyFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dotRoot = path.join(mkdtempSync(path.join(tmpdir(), 'omadia-')), '.uploaded-packages', 'og');
    mkdirSync(dotRoot, { recursive: true });
    copyFileSync(path.resolve(process.cwd(), 'assets/og/preview.jpg'), path.join(dotRoot, 'preview.jpg'));

    const app = express();
    app.use(
      '/api/imessage',
      createAnswersRouter({
        store: new AnswerStore({ ttlMs: HOUR, now: () => nowMs }),
        routePrefix: '/api/imessage',
        publicBaseUrl: 'https://omadia.example.com',
        ogAssetsPath: dotRoot,
        log: () => undefined,
        onReply: async () => undefined,
      }),
    );
    const srv = app.listen(0);
    await new Promise<void>((resolve) => srv.once('listening', resolve));
    try {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/imessage/a/assets/preview.jpg`);
      assert.equal(res.status, 200, 'sendFile without root 404s on dot segments — regression guard');
      assert.ok((res.headers.get('content-type') ?? '').startsWith('image/jpeg'));
    } finally {
      srv.close();
    }
  });

  it('omits og:url / og:image when no public base URL is configured', async () => {
    const app = express();
    const bare = new AnswerStore({ ttlMs: HOUR, now: () => nowMs });
    app.use(
      '/api/imessage',
      createAnswersRouter({
        store: bare,
        routePrefix: '/api/imessage',
        log: () => undefined,
        onReply: async () => undefined,
      }),
    );
    const srv = app.listen(0);
    await new Promise<void>((resolve) => srv.once('listening', resolve));
    try {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      const entry = bare.create('+491701234567', CHOICE);
      const html = await (
        await fetch(`http://127.0.0.1:${addr.port}/api/imessage/a/${entry.token}`)
      ).text();
      assert.ok(html.includes('og:title'));
      assert.ok(!html.includes('og:url'));
      assert.ok(!html.includes('og:image'));
      const img = await fetch(`http://127.0.0.1:${addr.port}/api/imessage/a/assets/preview.jpg`);
      assert.equal(img.status, 404);
    } finally {
      srv.close();
    }
  });
});
