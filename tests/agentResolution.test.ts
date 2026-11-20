import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { AgentSpeaker, ChatAgent } from '@omadia/channel-sdk';

import {
  numberFromPrincipal,
  principalFor,
  resolveAgentForTurn,
  type ChannelResolveResult,
  type RouteLookup,
  type TurnRoute,
} from '../src/agentResolution.js';

const agent = (name: string) => ({ name }) as unknown as ChatAgent;
const DEFAULT = agent('default');
const MIRA: AgentSpeaker = { kind: 'agent', agentId: 'ag-mira', slug: 'mira', displayName: 'Mira' };

const resolverOf = (byKey: Record<string, ChannelResolveResult>, probes: string[] = []): RouteLookup =>
  (key) => {
    probes.push(key);
    return byKey[key] ?? { decision: 'reject' as const };
  };

const nameOf = (a: ChatAgent | undefined) => (a as unknown as { name: string } | undefined)?.name;
const pick = (r: TurnRoute) => (r.kind === 'agent' ? nameOf(r.agent) : r);

describe('resolveAgentForTurn — bound or reject, never a fallback', () => {
  it('the first key that binds decides, later keys are not asked', () => {
    const probes: string[] = [];
    const r = resolveAgentForTurn(
      resolverOf(
        { S: { decision: 'bound', chatAgent: agent('S') }, L: { decision: 'bound', chatAgent: agent('L') } },
        probes,
      ),
      ['S', 'L'],
      () => DEFAULT,
    );
    assert.equal(pick(r), 'S');
    assert.deepEqual(probes, ['S']);
  });

  it('hands on the speaker the resolver named before the answer', () => {
    const r = resolveAgentForTurn(
      resolverOf({ S: { decision: 'bound', chatAgent: agent('S'), speaker: MIRA } }),
      ['S'],
      () => DEFAULT,
    );
    assert.deepEqual(r.kind === 'agent' ? r.speaker : undefined, MIRA);
  });

  it('a reject without an agent named lets the line key try', () => {
    const r = resolveAgentForTurn(
      resolverOf({ L: { decision: 'bound', chatAgent: agent('L') } }),
      ['S', 'L'],
      () => DEFAULT,
    );
    assert.equal(pick(r), 'L');
  });

  it('a no_agent notice also lets the next key try', () => {
    const notice = { code: 'no_agent', text: 'Schreib /agent Name.', locale: 'de' } as const;
    const r = resolveAgentForTurn(
      resolverOf({ S: { decision: 'reject', notice }, L: { decision: 'bound', chatAgent: agent('L') } }),
      ['S', 'L'],
      () => DEFAULT,
    );
    assert.equal(pick(r), 'L');
  });

  it('a reject naming an agent is final: the line agent never takes its place (INV-7)', () => {
    const notice = { code: 'agent_deleted', text: 'Mira wurde gelöscht.', locale: 'de' } as const;
    const r = resolveAgentForTurn(
      resolverOf({
        S: { decision: 'reject', notice, chatAgent: agent('S-reject') },
        L: { decision: 'bound', chatAgent: agent('L') },
      }),
      ['S', 'L'],
      () => DEFAULT,
    );
    assert.equal(r.kind, 'refused');
    if (r.kind !== 'refused') return;
    assert.equal(r.reason, 'agent_unavailable');
    assert.deepEqual(r.notice, notice);
    assert.equal(nameOf(r.agent), 'S-reject', 'the reject ChatAgent still handles /agent');
  });

  it('when no key binds, the FIRST reject answers: the sender key is where /agent stores a selection', () => {
    const notice = { code: 'no_agent', text: 'Schreib /agent Name.', locale: 'de' } as const;
    const r = resolveAgentForTurn(
      resolverOf({
        S: { decision: 'reject', notice, chatAgent: agent('S-reject') },
        L: { decision: 'reject', chatAgent: agent('L-reject') },
      }),
      ['S', 'L'],
      () => DEFAULT,
    );
    assert.equal(r.kind, 'refused');
    if (r.kind !== 'refused') return;
    assert.equal(r.reason, 'unassigned');
    assert.equal(nameOf(r.agent), 'S-reject');
    assert.deepEqual(r.notice, notice);
  });

  it('a bare reject (an older platform) is refused without an agent or notice', () => {
    const r = resolveAgentForTurn(resolverOf({}), ['S', 'L'], () => DEFAULT);
    assert.deepEqual(r, { kind: 'refused', reason: 'unassigned' });
  });

  it('answers with the singleton only on a host without a resolver (lookup is undefined)', () => {
    assert.equal(pick(resolveAgentForTurn(() => undefined, ['S'], () => DEFAULT)), 'default');
  });

  it('never asks for the singleton while a resolver exists, not even after a refusal', () => {
    let asked = 0;
    const getDefault = () => (asked += 1, DEFAULT);
    resolveAgentForTurn(resolverOf({}), ['S', 'L'], getDefault);
    resolveAgentForTurn(resolverOf({ S: { decision: 'bound', chatAgent: agent('S') } }), ['S', 'L'], getDefault);
    assert.equal(asked, 0);
  });

  it('a host with neither resolver nor orchestrator is a failure, not a silent drop', () => {
    const r = resolveAgentForTurn(() => undefined, ['S'], () => undefined);
    assert.equal(r.kind, 'resolver-failed');
  });

  it('passes the route context (principal) to every probe', () => {
    const seen: unknown[] = [];
    resolveAgentForTurn(
      (_k, context) => (seen.push(context), { decision: 'reject' as const }),
      ['S', 'L'],
      () => DEFAULT,
      { principal: 'user:custom:+49170' },
    );
    assert.deepEqual(seen, [{ principal: 'user:custom:+49170' }, { principal: 'user:custom:+49170' }]);
  });

  it('refuses when the resolver throws', () => {
    const r = resolveAgentForTurn(
      () => {
        throw new Error('boom');
      },
      ['S'],
      () => DEFAULT,
    );
    assert.deepEqual(r, { kind: 'resolver-failed', error: 'boom' });
  });
});

describe('principalFor', () => {
  it('is the SDK channelUserPrincipal of the custom kind, lowercase', async () => {
    const sdk = await import('@omadia/channel-sdk');
    const number = ' +491701234567 ';
    assert.equal(principalFor(number), sdk.channelUserPrincipal({ kind: 'custom', id: '+491701234567' }));
    assert.equal(principalFor(number), 'user:custom:+491701234567');
    assert.equal(principalFor('  '), undefined);
  });

  it('agrees with the principal the kernel derives from the turn userRef', async () => {
    const sdk = await import('@omadia/channel-sdk');
    assert.equal(principalFor('+491701234567'), sdk.turnPrincipal({ kind: 'custom', id: '+491701234567' }));
  });

  it('never uses an e-mail: Sendblue states a number, not a verified address', async () => {
    assert.doesNotMatch(String(principalFor('+491701234567')), /@/);
  });

  it('numberFromPrincipal is the inverse for a number and refuses anything else', () => {
    assert.equal(numberFromPrincipal('user:custom:+491701234567'), '+491701234567');
    assert.equal(numberFromPrincipal('USER:custom:+491701234567'), '+491701234567');
    assert.equal(numberFromPrincipal('user:teams-aad:abc'), undefined);
    assert.equal(numberFromPrincipal('user:anna@example.com'), undefined);
    assert.equal(numberFromPrincipal('role:hr'), undefined);
    assert.equal(numberFromPrincipal('user:custom:not-a-number'), undefined);
  });
});
