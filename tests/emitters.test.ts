import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { InMemorySpeakerHistoryStore, type SemanticAnswer } from '@omadia/channel-sdk';

import { emitAnswer, systemAnswer } from '../src/emit.js';
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

  it('reports an answer that arrives without a speaker, and still delivers it', async () => {
    const { client, sent } = recordingClient();
    let unstamped = 0;
    await emitAnswer(client, '+1', { text: 'Hallo.' } as SemanticAnswer, ctx(), {
      onUnstamped: () => (unstamped += 1),
    });
    assert.equal(unstamped, 1);
    assert.deepEqual(sent, ['Hallo.']);
  });

  it('does not report a stamped answer', async () => {
    const { client } = recordingClient();
    let unstamped = 0;
    await emitAnswer(client, '+1', systemAnswer('Hinweis.'), ctx(), { onUnstamped: () => (unstamped += 1) });
    assert.equal(unstamped, 0);
  });
});
