import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { safeEqual, verifyWebhookAuth } from '../src/verify.js';

const SECRET = 'a-long-random-webhook-secret';

describe('safeEqual', () => {
  it('compares strings of any length without throwing', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('short', 'a-much-longer-string'), false);
    assert.equal(safeEqual('', ''), true);
  });
});

describe('verifyWebhookAuth', () => {
  it('accepts a matching path token', () => {
    assert.equal(verifyWebhookAuth(SECRET, SECRET, {}), true);
  });

  it('accepts the secret from any header value (string or array)', () => {
    assert.equal(verifyWebhookAuth(SECRET, undefined, { 'x-sendblue-secret': SECRET }), true);
    assert.equal(verifyWebhookAuth(SECRET, 'wrong', { 'some-header': ['nope', SECRET] }), true);
  });

  it('rejects wrong or missing credentials', () => {
    assert.equal(verifyWebhookAuth(SECRET, 'wrong', {}), false);
    assert.equal(verifyWebhookAuth(SECRET, undefined, {}), false);
    assert.equal(verifyWebhookAuth(SECRET, undefined, { h: 'wrong', n: 42 }), false);
  });

  it('rejects everything when the configured secret is empty', () => {
    assert.equal(verifyWebhookAuth('', '', { h: '' }), false);
    assert.equal(verifyWebhookAuth('', undefined, {}), false);
  });
});
