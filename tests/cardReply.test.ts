import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { CardQuestion } from '@omadia/channel-sdk';

import { matchCardReply } from '../src/cardReply.js';
import { OPEN_CARD_TTL_MS, OpenCards, expiryOf } from '../src/openCards.js';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const NUMBER = '+491701234567';
const CTX = { channelId: 'imessage-channel', channelType: 'imessage', line: '+15550001111', now: NOW };

function open(question: CardQuestion, over: { kind?: 'poll' | 'card'; expiresAt?: number } = {}): OpenCards {
  const cards = new OpenCards();
  cards.open(NUMBER, {
    kind: over.kind ?? 'card',
    cardId: 'c1',
    cardMessageId: 'm1',
    question,
    prompt: 'Frage?',
    expiresAt: over.expiresAt ?? NOW + 1000,
  });
  return cards;
}

const answersOf = (outcome: ReturnType<typeof matchCardReply>) =>
  outcome.kind === 'answered' ? outcome.event.cardAnswer?.answers : undefined;

describe('matchCardReply — typed answers from plain text (criterion 30)', () => {
  const options = [
    { id: 'a', label: 'Eins' },
    { id: 'b', label: 'Zwei' },
    { id: 'c', label: 'Drei' },
  ];

  it('multiple choice: "1,3" and labels', () => {
    const q: CardQuestion = { id: 'q', kind: 'multiple_choice', label: 'Welche?', options };
    assert.deepEqual(answersOf(matchCardReply(open(q), NUMBER, '1,3', CTX)), [
      { questionId: 'q', kind: 'multiple_choice', optionIds: ['a', 'c'] },
    ]);
  });

  it('ranking: "2,1,3" in order', () => {
    const q: CardQuestion = { id: 'q', kind: 'ranking', label: 'Reihenfolge?', options };
    assert.deepEqual(answersOf(matchCardReply(open(q), NUMBER, '2,1,3', CTX)), [
      { questionId: 'q', kind: 'ranking', ranking: ['b', 'a', 'c'] },
    ]);
  });

  it('number and date, text', () => {
    assert.deepEqual(answersOf(matchCardReply(open({ id: 'q', kind: 'number', label: 'Wie viele?' }), NUMBER, '4,5', CTX)), [
      { questionId: 'q', kind: 'number', value: 4.5 },
    ]);
    assert.deepEqual(answersOf(matchCardReply(open({ id: 'q', kind: 'date', label: 'Wann?' }), NUMBER, '2026-12-01', CTX)), [
      { questionId: 'q', kind: 'date', value: '2026-12-01' },
    ]);
    assert.deepEqual(answersOf(matchCardReply(open({ id: 'q', kind: 'text', label: 'Was?' }), NUMBER, 'Kaffee', CTX)), [
      { questionId: 'q', kind: 'text', text: 'Kaffee' },
    ]);
  });

  it('the event names the verified number as author and the line as receiver', () => {
    const outcome = matchCardReply(open({ id: 'q', kind: 'text', label: 'Was?' }), NUMBER, 'x', CTX);
    assert.equal(outcome.kind, 'answered');
    if (outcome.kind !== 'answered') return;
    assert.deepEqual(outcome.event.author, { kind: 'custom', id: NUMBER });
    assert.equal(outcome.event.receivedByChannelKey, CTX.line);
    assert.equal(outcome.event.messageId, 'm1');
  });

  it('a question that closed by time is no longer asked: the reply is an ordinary turn', () => {
    const cards = open({ id: 'q', kind: 'text', label: 'Was?' }, { expiresAt: NOW });
    assert.deepEqual(matchCardReply(cards, NUMBER, 'x', CTX), { kind: 'none' });
    assert.equal(cards.get(NUMBER, NOW), undefined);
  });

  it('nothing open: none', () => {
    assert.deepEqual(matchCardReply(new OpenCards(), NUMBER, '1', CTX), { kind: 'none' });
  });

  it('is per conversation: another number is not affected', () => {
    const cards = open({ id: 'q', kind: 'text', label: 'Was?' });
    assert.deepEqual(matchCardReply(cards, '+4915100000000', 'x', CTX), { kind: 'none' });
    assert.equal(matchCardReply(cards, NUMBER, 'x', CTX).kind, 'answered');
  });
});

describe('expiryOf', () => {
  it('uses closesAt when valid, else the default wait', () => {
    assert.equal(expiryOf({ closesAt: '2026-11-21T00:00:00Z' }, NOW), Date.parse('2026-11-21T00:00:00Z'));
    assert.equal(expiryOf({}, NOW), NOW + OPEN_CARD_TTL_MS);
    assert.equal(expiryOf({ closesAt: 'nonsense' }, NOW), NOW + OPEN_CARD_TTL_MS);
  });
});
