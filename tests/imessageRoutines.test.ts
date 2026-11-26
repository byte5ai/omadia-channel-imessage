import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemorySpeakerHistoryStore } from '@omadia/channel-sdk';

import { createIMessageProactiveSend, createIMessageRoutineTurn } from '../src/imessageRoutines.js';

/**
 * Triggers and routines on iMessage (spec 2042 §5.12, omadia#1086): the turn
 * files the conversation as a generic channel ref, and a delivery goes to that
 * number through the one emitter, under the same allowlist as every send.
 */

const CHANNEL_ID = 'imessage-channel';
const SENDER = '+491701234567';
const mira = { kind: 'agent', agentId: 'a-mira', slug: 'mira', displayName: 'Mira' } as const;
const jonas = { kind: 'agent', agentId: 'a-jonas', slug: 'jonas', displayName: 'Jonas' } as const;

function proactive(allowlist: string[] = []) {
  const sends: Array<{ number: string; content: string }> = [];
  const send = createIMessageProactiveSend({
    client: {
      sendMessage: async (input: { number: string; content: string }) => {
        sends.push(input);
        return { status: 'OK', message_handle: `out-${String(sends.length)}` };
      },
    } as never,
    allowlist: new Set(allowlist),
    speakerHistory: new InMemorySpeakerHistoryStore(),
  });
  return { send, sends };
}

const ref = (conversationId: string, extra: Record<string, unknown> = {}) => ({
  kind: 'channel',
  channelId: CHANNEL_ID,
  conversationId,
  ...extra,
});

describe('routines scope per turn', () => {
  it('files the number as a generic channel ref, never as the Conductor binding', () => {
    const seen: unknown[] = [];
    const routines = {
      beginRoutineTurn: (info: unknown) => {
        seen.push(info);
        return <T,>(fn: () => Promise<T>) => fn();
      },
    };
    createIMessageRoutineTurn(routines as never, CHANNEL_ID)({ userId: SENDER, conversationId: SENDER });
    assert.deepEqual(seen, [
      {
        userId: SENDER,
        channel: 'imessage',
        conductorBinding: false,
        conversationRef: { kind: 'channel', channelId: CHANNEL_ID, conversationId: SENDER },
      },
    ]);
  });
});

describe('proactive send', () => {
  it("delivers an agent's message with a name line where the speaker changes", async () => {
    const p = proactive();
    await p.send(ref(SENDER), { text: 'Dein Bericht ist fertig.', speaker: mira });
    await p.send(ref(SENDER), { text: 'Die Rechnung ist raus.', speaker: jonas });
    assert.equal(p.sends.length, 2);
    assert.equal(p.sends[0]?.number, SENDER);
    assert.match(p.sends[0]?.content ?? '', /Dein Bericht ist fertig\./);
    assert.match(p.sends[1]?.content ?? '', /Jonas/);
    assert.match(p.sends[1]?.content ?? '', /Die Rechnung ist raus\./);
  });

  it('a kernel text without a speaker goes out as plain system text', async () => {
    const p = proactive();
    await p.send(ref(SENDER), { text: 'Freigabe nötig.' });
    assert.deepEqual(p.sends, [{ number: SENDER, content: 'Freigabe nötig.' }]);
  });

  it('"nothing to report" is dropped', async () => {
    const p = proactive();
    await p.send(ref(SENDER), { text: 'NO_REPLY', speaker: mira });
    assert.equal(p.sends.length, 0);
  });

  it('refuses a ref that names no iMessage number', async () => {
    const p = proactive();
    for (const bad of [undefined, 'x', { kind: 'channel' }, ref('  '), ref('C0123-slack'), ref('42')]) {
      await assert.rejects(p.send(bad, { text: 'x', speaker: mira }));
    }
    assert.equal(p.sends.length, 0);
  });

  it('refuses a ref that names a bot: every agent shares the one line', async () => {
    const p = proactive();
    await assert.rejects(p.send(ref(SENDER, { asChannelKey: 'imessage:mira' }), { text: 'x', speaker: mira }), /one line/);
    assert.equal(p.sends.length, 0);
  });

  it('refuses a number the allowlist no longer names', async () => {
    const p = proactive(['491709999999']);
    await assert.rejects(p.send(ref(SENDER), { text: 'x', speaker: mira }), /allowlist/);
    await p.send(ref('+491709999999'), { text: 'Hallo.', speaker: mira });
    assert.equal(p.sends.length, 1);
  });
});
