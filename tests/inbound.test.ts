import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  attachmentFromUrl,
  createLruSet,
  evaluateInbound,
  normalizePhone,
  type SendbluePayload,
} from '../src/inbound.js';

const payload = (over: Partial<SendbluePayload> = {}): SendbluePayload => ({
  from_number: '+491701234567',
  content: 'Hallo',
  status: 'RECEIVED',
  is_outbound: false,
  message_handle: 'mh-1',
  sendblue_number: '+15550001111',
  ...over,
});

const opts = (over: Partial<Parameters<typeof evaluateInbound>[1]> = {}) => ({
  channelId: 'imessage-channel',
  allowlist: new Set<string>(),
  seen: createLruSet(8),
  ...over,
});

describe('evaluateInbound — mapping', () => {
  it('maps an inbound message to an IncomingTurn keyed on the sender E.164', () => {
    const result = evaluateInbound(payload({ service: 'iMessage' }), opts());
    assert.ok('turn' in result);
    const t = result.turn;
    assert.equal(t.channelType, 'imessage');
    assert.equal(t.conversationId, '+491701234567');
    assert.equal(t.channelKey, '+491701234567');
    assert.deepEqual(t.userRef, { kind: 'imessage-handle', id: '+491701234567' });
    assert.equal(t.text, 'Hallo');
    assert.equal(t.attachments, undefined);
    assert.deepEqual(t.metadata, { service: 'iMessage' });
  });

  it('maps media_url to a single typed attachment', () => {
    const result = evaluateInbound(
      payload({ media_url: 'https://cdn.example.com/pic.HEIC?sig=x' }),
      opts(),
    );
    assert.ok('turn' in result);
    assert.deepEqual(result.turn.attachments, [
      { kind: 'image', url: 'https://cdn.example.com/pic.HEIC?sig=x', mediaType: 'image/heic' },
    ]);
  });

  it('accepts a media-only message (empty text)', () => {
    const result = evaluateInbound(
      payload({ content: '', media_url: 'https://cdn.example.com/voice.m4a' }),
      opts(),
    );
    assert.ok('turn' in result);
    assert.equal(result.turn.attachments?.[0]?.kind, 'audio');
  });
});

describe('evaluateInbound — drops', () => {
  it('drops malformed payloads', () => {
    assert.deepEqual(evaluateInbound(null, opts()), { drop: 'malformed' });
    assert.deepEqual(evaluateInbound([], opts()), { drop: 'malformed' });
    assert.deepEqual(evaluateInbound({ content: 'no sender' }, opts()), { drop: 'malformed' });
  });

  it('drops status callbacks and outbound echoes', () => {
    assert.deepEqual(evaluateInbound(payload({ is_outbound: true }), opts()), {
      drop: 'not-inbound',
    });
    assert.deepEqual(evaluateInbound(payload({ status: 'DELIVERED' }), opts()), {
      drop: 'not-inbound',
    });
  });

  it('drops group messages (v1 unsupported)', () => {
    assert.deepEqual(evaluateInbound(payload({ group_id: 'g-1' }), opts()), {
      drop: 'group-unsupported',
    });
    assert.deepEqual(evaluateInbound(payload({ message_type: 'group' }), opts()), {
      drop: 'group-unsupported',
    });
  });

  it('drops our own line and empty messages', () => {
    assert.deepEqual(
      evaluateInbound(payload({ from_number: '+15550001111' }), opts()),
      { drop: 'self' },
    );
    assert.deepEqual(evaluateInbound(payload({ content: '   ' }), opts()), { drop: 'empty' });
  });

  it('enforces the allowlist on normalized numbers', () => {
    const allow = opts({ allowlist: new Set([normalizePhone('+49 170 1234567')]) });
    assert.ok('turn' in evaluateInbound(payload(), allow));
    assert.deepEqual(evaluateInbound(payload({ from_number: '+15559999999' }), allow), {
      drop: 'not-allowlisted',
    });
  });

  it('deduplicates on message_handle across retries', () => {
    const shared = opts();
    assert.ok('turn' in evaluateInbound(payload(), shared));
    assert.deepEqual(evaluateInbound(payload(), shared), { drop: 'duplicate' });
    assert.ok('turn' in evaluateInbound(payload({ message_handle: 'mh-2' }), shared));
  });
});

describe('helpers', () => {
  it('normalizePhone keeps digits only', () => {
    assert.equal(normalizePhone('+49 (170) 123-4567'), '491701234567');
  });

  it('attachmentFromUrl falls back to a generic file', () => {
    assert.deepEqual(attachmentFromUrl('https://x/blob'), {
      kind: 'file',
      url: 'https://x/blob',
      mediaType: 'application/octet-stream',
    });
    assert.equal(attachmentFromUrl('https://x/clip.mov').kind, 'video');
  });

  it('LruSet evicts its oldest entry beyond the cap', () => {
    const set = createLruSet(2);
    set.add('a');
    set.add('b');
    set.add('c');
    assert.equal(set.has('a'), false);
    assert.equal(set.has('b'), true);
    assert.equal(set.has('c'), true);
  });
});
