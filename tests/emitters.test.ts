import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { InMemorySpeakerHistoryStore, type SemanticAnswer } from '@omadia/channel-sdk';

import { MissingSpeakerError, agentAnswer, emitAnswer, stampSpeaker, systemAnswer } from '../src/emit.js';
import type { SendblueClient } from '../src/sendblueClient.js';

// Spec 2042 criterion 5: every user-visible message carries its speaker, and a
// test enumerates the emitter paths and fails on a new one.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
// The tests run from a transpiled copy; fall back to the repo layout.
const srcDir = (() => {
  try {
    readdirSync(SRC);
    return SRC;
  } catch {
    return join(process.cwd(), 'src');
  }
})();

describe('emitter paths (criterion 5)', () => {
  it('has exactly one place that sends a message: emit.ts', () => {
    const callSites: string[] = [];
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      if (file === 'sendblueClient.ts') continue; // the client's own definition
      const text = readFileSync(join(srcDir, file), 'utf8');
      const count = text.match(/\.sendMessage\(/g)?.length ?? 0;
      for (let i = 0; i < count; i += 1) callSites.push(file);
    }
    assert.deepEqual(callSites, ['emit.ts'], `unexpected sendMessage call sites: ${callSites.join(', ')}`);
  });

  it('every plugin-originated notice is a system answer', () => {
    const notice = systemAnswer('Hinweis.');
    assert.deepEqual(notice.speaker, { kind: 'system' });
  });

  function recordingClient(): { client: SendblueClient; sent: string[] } {
    const sent: string[] = [];
    const client = {
      sendMessage: async (input: { content: string }) => {
        sent.push(input.content);
        return {};
      },
    } as unknown as SendblueClient;
    return { client, sent };
  }

  const ctx = () => ({ conversationKey: 'c', speakerHistory: new InMemorySpeakerHistoryStore() });

  it('refuses an answer that arrives without a speaker: nothing is sent (fail-closed)', async () => {
    const { client, sent } = recordingClient();
    await assert.rejects(
      emitAnswer(client, '+1', { text: 'Hallo.' } as SemanticAnswer, ctx()),
      MissingSpeakerError,
    );
    assert.deepEqual(sent, []);
  });

  it('sends a stamped answer and reports every sent bubble to the hook', async () => {
    const { client, sent } = recordingClient();
    let reported = 0;
    await emitAnswer(client, '+1', systemAnswer('Hinweis.'), ctx(), { onSent: () => (reported += 1) });
    assert.deepEqual(sent, ['Hinweis.']);
    assert.equal(reported, 1);
  });

  it('sends without a hook (the optional hook must not skip the send)', async () => {
    const { client, sent } = recordingClient();
    await emitAnswer(client, '+1', systemAnswer('Hinweis.'), ctx());
    assert.deepEqual(sent, ['Hinweis.']);
  });
});

describe('stampSpeaker', () => {
  const MIRA = { kind: 'agent', agentId: 'ag-mira', slug: 'mira', displayName: 'Mira' } as const;

  it("fills the resolver's speaker into an answer that has none", () => {
    assert.deepEqual(stampSpeaker({ text: 'x' } as SemanticAnswer, MIRA)?.speaker, MIRA);
  });

  it("an answer's own speaker wins, a system notice stays one", () => {
    const notice = systemAnswer('Hinweis.');
    assert.deepEqual(stampSpeaker(notice, MIRA)?.speaker, { kind: 'system' });
  });

  it('is undefined when neither names a speaker', () => {
    assert.equal(stampSpeaker({ text: 'x' } as SemanticAnswer, undefined), undefined);
  });

  it('agentAnswer speaks under the given agent', () => {
    assert.deepEqual(agentAnswer('Ich kümmere mich.', MIRA).speaker, MIRA);
  });
});
