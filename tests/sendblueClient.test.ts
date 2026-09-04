import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { SendblueClient } from '../src/sendblueClient.js';

// The Sendblue REST client is the only code path that talks to the provider,
// and a bad API key pair only ever manifests here (Sendblue has no auth
// handshake). The integration harness stubs any URL containing "sendblue" with
// a 200, so none of the behaviour below is exercised there.

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function makeClient(
  responses: Array<Response | Error>,
  overrides: Partial<ConstructorParameters<typeof SendblueClient>[0]> = {},
) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const next = responses[i++];
    if (next === undefined) throw new Error('unexpected extra fetch');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;

  const client = new SendblueClient({
    apiBaseUrl: 'https://api.sendblue.co',
    apiV2BaseUrl: 'https://api.sendblue.com',
    apiKeyId: 'key-id',
    apiSecretKey: 'key-secret',
    fromNumber: '+15122164639',
    fetchImpl,
    retryDelayMs: 0,
    ...overrides,
  });
  return { client, calls };
}

const ok = (body: unknown = { status: 'QUEUED', message_handle: 'h1' }): Response =>
  new Response(JSON.stringify(body), { status: 200 });

describe('SendblueClient.sendMessage — request shape', () => {
  it('posts to send-message on the v1 base with both auth headers', async () => {
    const { client, calls } = makeClient([ok()]);
    await client.sendMessage({ number: '+491701234567', content: 'hallo' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.sendblue.co/api/send-message');
    // Header names are provider-specified — a typo here is a silent 401.
    assert.equal(calls[0]?.headers['sb-api-key-id'], 'key-id');
    assert.equal(calls[0]?.headers['sb-api-secret-key'], 'key-secret');
    assert.deepEqual(calls[0]?.body, {
      from_number: '+15122164639',
      number: '+491701234567',
      content: 'hallo',
    });
  });

  it('includes media_url only when set', async () => {
    const { client, calls } = makeClient([ok(), ok()]);
    await client.sendMessage({ number: '+49170', content: 'a' });
    assert.equal('media_url' in (calls[0]?.body ?? {}), false);
    await client.sendMessage({ number: '+49170', content: 'a', media_url: 'https://e.com/i.png' });
    assert.equal(calls[1]?.body.media_url, 'https://e.com/i.png');
  });
});

describe('SendblueClient.sendMessage — retry policy', () => {
  it('retries ONCE on 429 (rejected, not queued) and succeeds', async () => {
    const { client, calls } = makeClient([new Response('rate limited', { status: 429 }), ok()]);
    const res = await client.sendMessage({ number: '+49170', content: 'a' });
    assert.equal(calls.length, 2);
    assert.equal(res.message_handle, 'h1');
  });

  it('retries once on 5xx and gives up after the second failure', async () => {
    const { client, calls } = makeClient([
      new Response('boom', { status: 502 }),
      new Response('boom', { status: 502 }),
    ]);
    await assert.rejects(
      () => client.sendMessage({ number: '+49170', content: 'a' }),
      /failed after retry/,
    );
    assert.equal(calls.length, 2, 'exactly one retry, never a loop');
  });

  it('treats a network-level failure as retryable', async () => {
    const { client, calls } = makeClient([new Error('ECONNRESET'), ok()]);
    await client.sendMessage({ number: '+49170', content: 'a' });
    assert.equal(calls.length, 2);
  });

  it('does NOT retry a 4xx that is not 429', async () => {
    const { client, calls } = makeClient([new Response('nope', { status: 401 })]);
    await assert.rejects(
      () => client.sendMessage({ number: '+49170', content: 'a' }),
      /HTTP 401/,
    );
    assert.equal(calls.length, 1, 'a bad key pair must fail fast, not retry');
  });
});

describe('SendblueClient.sendMessage — provider errors inside a 200', () => {
  it('rejects status ERROR', async () => {
    const { client } = makeClient([ok({ status: 'ERROR', error_message: 'not a contact' })]);
    await assert.rejects(
      () => client.sendMessage({ number: '+49170', content: 'a' }),
      /provider error/,
    );
  });

  it('rejects a real error_code', async () => {
    const { client } = makeClient([ok({ status: 'QUEUED', error_code: 4001 })]);
    await assert.rejects(() => client.sendMessage({ number: '+49170', content: 'a' }));
  });

  it('accepts error_code 0 and "" as "no error"', async () => {
    // Both are the same statement as null in a JSON API; treating them as
    // failures raised on a message that was in fact delivered, which sent the
    // user a bogus error bubble.
    const { client } = makeClient([
      ok({ status: 'QUEUED', error_code: 0 }),
      ok({ status: 'QUEUED', error_code: '' }),
    ]);
    await client.sendMessage({ number: '+49170', content: 'a' });
    await client.sendMessage({ number: '+49170', content: 'a' });
  });

  it('tolerates a non-JSON 200 body', async () => {
    const { client } = makeClient([new Response('not json', { status: 200 })]);
    await client.sendMessage({ number: '+49170', content: 'a' });
  });
});

describe('SendblueClient.sendTypingIndicator', () => {
  it('posts to the v2 host (.com, not .co) and reports success', async () => {
    const { client, calls } = makeClient([new Response('', { status: 200 })]);
    assert.equal(await client.sendTypingIndicator('+49170'), true);
    assert.equal(calls[0]?.url, 'https://api.sendblue.com/api/send-typing-indicator');
    assert.equal(calls[0]?.body.from_number, '+15122164639');
    assert.equal(calls[0]?.body.state, 'start');
  });

  it('never throws — a failure is a false, so callers can fire-and-forget', async () => {
    const { client } = makeClient([new Error('offline')]);
    assert.equal(await client.sendTypingIndicator('+49170'), false);
    const { client: c2 } = makeClient([new Response('', { status: 500 })]);
    assert.equal(await c2.sendTypingIndicator('+49170'), false);
  });
});
