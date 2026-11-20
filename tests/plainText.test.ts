import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DECORATION_REGISTRY,
  InMemorySpeakerHistoryStore,
  REMOVED_DECORATIONS,
  admitDecorations,
  decorationsFor,
  type SemanticAnswer,
} from '@omadia/channel-sdk';

import { CHANNEL_TYPE, renderAnswerParts } from '../src/renderer.js';

const MIRA = { kind: 'agent', agentId: 'ag-mira', slug: 'mira', displayName: 'Mira' } as const;
const BEN = { kind: 'agent', agentId: 'ag-ben', slug: 'ben', displayName: 'Ben' } as const;

/** An answer with every legacy status field a kernel could still set. */
const SATURATED = {
  text: 'Die Rechnung ist bezahlt.\n\nKI-Hinweis: Diese Antwort stammt von einer KI.',
  speaker: MIRA,
  verifier: { state: 'verified' },
  followUps: [{ prompt: 'Zeig die nächste Rechnung' }],
  disclaimer: 'Ohne Gewähr.',
  answerVerbosity: { effective: 'standard', source: 'configured' },
  memoryUsed: true,
  agentsConsulted: [{ agent: 'x' }],
  maskedValues: ['Anna'],
} as unknown as SemanticAnswer;

describe('plain text answer (criteria 29, 30)', () => {
  it('is the text and the AI disclosure line, nothing else', () => {
    const { bubbles, decorations } = renderAnswerParts(SATURATED);
    assert.deepEqual(bubbles, ['Die Rechnung ist bezahlt.\n\nKI-Hinweis: Diese Antwort stammt von einer KI.']);
    assert.deepEqual(decorations, []);
  });

  it('carries none of the removed decorations in any form', () => {
    const out = renderAnswerParts(SATURATED).bubbles.join('\n');
    for (const leak of ['👀', '💡', '🔎', 'Kürzer', 'Mehr Details', 'Konsultiert', 'Direkte Antwort', 'Ohne Gewähr']) {
      assert.ok(!out.includes(leak), `leaked: ${leak}`);
    }
  });

  it('renders a card as numbered text and a system notice as its own text', () => {
    const card = renderAnswerParts({
      text: 'Wir brauchen eine Entscheidung.',
      speaker: MIRA,
      interactive: { kind: 'choice', question: 'Welche?', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
    } as unknown as SemanticAnswer);
    assert.equal(card.bubbles[0], 'Wir brauchen eine Entscheidung.\n\nWelche?\n1) A\n2) B');
    const notice = renderAnswerParts({
      text: 'x',
      speaker: { kind: 'system' },
      systemNotice: { code: 'agent_selected', text: 'Du sprichst jetzt mit Mira.', locale: 'de' },
    } as unknown as SemanticAnswer);
    assert.deepEqual(notice.bubbles, ['Du sprichst jetzt mit Mira.']);
  });

  it('uses the name line only where the speaker would be unclear (INV-4)', () => {
    const history = new InMemorySpeakerHistoryStore();
    const say = (speaker: typeof MIRA | typeof BEN, conversationKey: string) =>
      renderAnswerParts({ text: 'Hallo.', speaker } as unknown as SemanticAnswer, {
        speakerHistory: history,
        conversationKey,
      }).bubbles[0];
    assert.equal(say(MIRA, 'u'), 'Hallo.');
    assert.equal(say(MIRA, 'u'), 'Hallo.');
    assert.equal(say(BEN, 'u'), 'Ben: Hallo.', 'the speaker changed');
    assert.equal(say(BEN, 'v'), 'Hallo.', 'another conversation has its own history');
  });
});

describe('decoration registry (criterion 31)', () => {
  it('no removed decoration is declared for this channel', () => {
    const declared = new Set(decorationsFor(CHANNEL_TYPE).map((d) => d.id));
    for (const id of REMOVED_DECORATIONS) assert.ok(!declared.has(id), `${id} must stay removed`);
  });

  it('every decoration this plugin attaches is admitted by the registry', () => {
    // The only element this plugin can attach on top of the text is the answer
    // link; the gate decides, so what is attached is by construction admitted.
    const answer = {
      text: 'Q',
      speaker: MIRA,
      interactive: { kind: 'choice', question: 'Q?', options: [{ label: 'A', value: 'a' }] },
    } as unknown as SemanticAnswer;
    const { decorations } = renderAnswerParts(answer, { choiceLinkUrl: 'https://x/a/t' });
    const { refused } = admitDecorations(
      CHANNEL_TYPE,
      decorations.map((id) => ({ id })),
    );
    assert.deepEqual(refused, []);
  });

  it('the answer link is inactive: decision_card is declared for Teams and web, not for imessage', () => {
    const { admitted, refused } = admitDecorations(CHANNEL_TYPE, [{ id: 'decision_card' }]);
    assert.deepEqual(admitted, []);
    assert.deepEqual(refused, [{ id: 'decision_card', reason: 'channel_not_declared' }]);
    // The plain-text path needs no decoration: a choice is a numbered list and
    // a poll or question card is renderCardAsText (neither is a decoration).
    const answer = {
      text: 'Q',
      speaker: MIRA,
      interactive: { kind: 'choice', question: 'Q?', options: [{ label: 'A', value: 'a' }] },
    } as unknown as SemanticAnswer;
    const parts = renderAnswerParts(answer, { choiceLinkUrl: 'https://x/a/t' });
    assert.deepEqual(parts.decorations, []);
    assert.equal(parts.bubbles.length, 1);
    assert.ok(parts.bubbles[0]?.includes('1) A'));
  });

  it('fails when the registry grows an entry for this channel the plugin has not reviewed', () => {
    const reviewed = new Set(['ai_disclosure_line']);
    const forImessage = DECORATION_REGISTRY.filter(
      (d) => d.channels === '*' || d.channels.includes(CHANNEL_TYPE),
    ).map((d) => d.id);
    for (const id of forImessage) {
      assert.ok(reviewed.has(id), `registry declares "${id}" for ${CHANNEL_TYPE}: render it deliberately or update this list`);
    }
  });
});
