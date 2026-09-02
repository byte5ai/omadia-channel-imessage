import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { OutgoingChoiceCard } from '@omadia/channel-sdk';

import { AnswerStore } from '../src/answerStore.js';

const CHOICE: OutgoingChoiceCard = {
  kind: 'choice',
  question: 'Welcher Slot?',
  options: [
    { label: 'Di 10:00', value: 'slot-di' },
    { label: 'Mi 14:30', value: 'slot-mi' },
  ],
};

const HOUR = 60 * 60 * 1000;

/** Store with an injectable, manually advanced clock. */
function makeStore(opts: { ttlMs?: number; cap?: number; retentionMs?: number } = {}) {
  let nowMs = 1_000_000;
  const store = new AnswerStore({
    ttlMs: opts.ttlMs ?? 24 * HOUR,
    ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
    ...(opts.retentionMs !== undefined ? { retentionMs: opts.retentionMs } : {}),
    now: () => nowMs,
  });
  return { store, advance: (ms: number) => (nowMs += ms) };
}

describe('AnswerStore — create / get', () => {
  it('mints a base64url token and stores the open entry', () => {
    const { store } = makeStore();
    const entry = store.create('+491701', CHOICE);
    assert.match(entry.token, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(entry.state, 'open');
    assert.equal(store.get(entry.token), entry);
    assert.equal(store.get('unknown'), undefined);
  });

  it('supersedes a previous open entry of the same conversation', () => {
    const { store } = makeStore();
    const first = store.create('+491701', CHOICE);
    const other = store.create('+491999', CHOICE);
    const second = store.create('+491701', CHOICE);
    assert.equal(first.state, 'answered');
    assert.equal(first.answeredVia, 'superseded');
    assert.equal(second.state, 'open');
    assert.equal(other.state, 'open', 'foreign conversations stay untouched');
  });

  it('expires an entry lazily once the TTL passed', () => {
    const { store, advance } = makeStore({ ttlMs: HOUR });
    const entry = store.create('+491701', CHOICE);
    advance(HOUR + 1);
    assert.equal(store.get(entry.token)?.state, 'expired');
  });
});

describe('AnswerStore — reply', () => {
  it('accepts a valid option value exactly once', () => {
    const { store } = makeStore();
    const entry = store.create('+491701', CHOICE);
    const ok = store.reply(entry.token, 'slot-mi');
    assert.equal(ok.outcome, 'ok');
    if (ok.outcome === 'ok') {
      assert.equal(ok.option.label, 'Mi 14:30');
      assert.equal(ok.entry.answeredVia, 'link');
      assert.equal(ok.entry.answeredValue, 'slot-mi');
    }
    assert.equal(store.reply(entry.token, 'slot-di').outcome, 'conflict');
  });

  it('rejects unknown tokens, foreign values and expired entries', () => {
    const { store, advance } = makeStore({ ttlMs: HOUR });
    assert.equal(store.reply('nope', 'slot-di').outcome, 'missing');
    const entry = store.create('+491701', CHOICE);
    assert.equal(store.reply(entry.token, 'not-an-option').outcome, 'invalid-value');
    assert.equal(entry.state, 'open', 'an invalid value must not consume the entry');
    advance(HOUR + 1);
    assert.equal(store.reply(entry.token, 'slot-di').outcome, 'expired');
  });
});

describe('AnswerStore — conversation resolution (text reply wins)', () => {
  it('terminally resolves every open entry of the conversation', () => {
    const { store } = makeStore();
    const entry = store.create('+491701', CHOICE);
    const other = store.create('+491999', CHOICE);
    assert.equal(store.resolveOpenForConversation('+491701', 'text'), 1);
    assert.equal(entry.state, 'answered');
    assert.equal(entry.answeredVia, 'text');
    assert.equal(other.state, 'open');
    assert.equal(store.reply(entry.token, 'slot-di').outcome, 'conflict');
    assert.equal(store.resolveOpenForConversation('+491701', 'text'), 0, 'idempotent');
  });
});

describe('AnswerStore — bounds', () => {
  it('evicts the oldest entry beyond the cap', () => {
    const { store } = makeStore({ cap: 2 });
    const a = store.create('+1', CHOICE);
    const b = store.create('+2', CHOICE);
    const c = store.create('+3', CHOICE);
    assert.equal(store.get(a.token), undefined, 'oldest evicted');
    assert.ok(store.get(b.token));
    assert.ok(store.get(c.token));
  });

  it('sweeps terminal entries only after the retention horizon', () => {
    const { store, advance } = makeStore({ ttlMs: HOUR, retentionMs: 2 * HOUR });
    const entry = store.create('+491701', CHOICE);
    advance(HOUR + 1); // expired, but retained → still visible (410-style page)
    store.create('+491999', CHOICE); // create() triggers the sweep
    assert.equal(store.get(entry.token)?.state, 'expired');
    advance(2 * HOUR + 1); // past expiry + retention
    store.create('+491888', CHOICE);
    assert.equal(store.get(entry.token), undefined, 'swept after retention');
  });

  it('clear() drops everything', () => {
    const { store } = makeStore();
    const entry = store.create('+491701', CHOICE);
    store.clear();
    assert.equal(store.get(entry.token), undefined);
  });
});
