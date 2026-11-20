import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgent } from '@omadia/channel-sdk';

import {
  principalFor,
  resolveAgentForTurn,
  type ChannelResolveResult,
} from '../src/agentResolution.js';

const agent = (name: string) => ({ name }) as unknown as ChatAgent;
const DEFAULT = agent('default');

const resolverOf = (byKey: Record<string, ChannelResolveResult>, probes: string[] = []) => ({
  resolve: (_t: string, key: string) => {
    probes.push(key);
    return byKey[key] ?? { decision: 'reject' as const };
  },
});

const pick = (r: ReturnType<typeof resolveAgentForTurn>) =>
  'agent' in r ? (r.agent as unknown as { name: string }).name : r;

describe('resolveAgentForTurn — selection, binding, default', () => {
  it("the sender's selection wins over the line binding", () => {
    const probes: string[] = [];
    const r = resolveAgentForTurn(
      resolverOf({ S: { decision: 'bound', match: 'selection', chatAgent: agent('B') }, L: { decision: 'bound', chatAgent: agent('A') } }, probes),
      'imessage',
      ['S', 'L'],
      DEFAULT,
    );
    assert.equal(pick(r), 'B');
    assert.deepEqual(probes, ['S']);
  });

  it('a binding on the sender wins over one on the line', () => {
    const r = resolveAgentForTurn(
      resolverOf({ S: { decision: 'bound', match: 'binding', chatAgent: agent('S') }, L: { decision: 'bound', match: 'binding', chatAgent: agent('L') } }),
      'imessage',
      ['S', 'L'],
      DEFAULT,
    );
    assert.equal(pick(r), 'S');
  });

  it('a default-table answer on the sender does not hide the line binding', () => {
    const r = resolveAgentForTurn(
      resolverOf({ S: { decision: 'bound', match: 'default', chatAgent: agent('D') }, L: { decision: 'bound', match: 'binding', chatAgent: agent('L') } }),
      'imessage',
      ['S', 'L'],
      DEFAULT,
    );
    assert.equal(pick(r), 'L');
  });

  it('keeps the default when nothing is bound', () => {
    const r = resolveAgentForTurn(
      resolverOf({ S: { decision: 'bound', match: 'default', chatAgent: agent('D') } }),
      'imessage',
      ['S', 'L'],
      DEFAULT,
    );
    assert.equal(pick(r), 'D');
  });

  it('a reject naming an agent is final: the line agent never takes its place (INV-7)', () => {
    const notice = { code: 'agent_deleted', text: 'Mira wurde gelöscht.', locale: 'de' } as const;
    const r = resolveAgentForTurn(
      resolverOf({ S: { decision: 'reject', notice }, L: { decision: 'bound', chatAgent: agent('L') } }),
      'imessage',
      ['S', 'L'],
      DEFAULT,
    );
    assert.deepEqual(r, { refused: 'agent_unavailable', notice });
  });

  it('no_agent lets the next key try, and is the refusal text when none does', () => {
    const notice = { code: 'no_agent', text: 'Schreib /agent Name.', locale: 'de' } as const;
    const r = resolveAgentForTurn(resolverOf({ S: { decision: 'reject', notice } }), 'imessage', ['S', 'L'], DEFAULT);
    assert.deepEqual(r, { refused: 'unassigned', notice });
  });

  it('answers with the default agent only without a resolver', () => {
    assert.equal(pick(resolveAgentForTurn(undefined, 'imessage', ['S'], DEFAULT)), 'default');
  });

  it('refuses when the resolver throws', () => {
    const r = resolveAgentForTurn(
      { resolve: () => { throw new Error('boom'); } },
      'imessage',
      ['S'],
      DEFAULT,
    );
    assert.deepEqual(r, { refused: 'resolver-failed', error: 'boom' });
  });
});

describe('principalFor', () => {
  it('matches the SDK principal wire form', async () => {
    const sdk = await import('@omadia/channel-sdk');
    const id = ' +491701234567 ';
    const expected = sdk.formatPrincipal(sdk.makePrincipal('user', id)!);
    assert.equal(principalFor(id), expected);
    assert.equal(principalFor('  '), undefined);
  });
});
