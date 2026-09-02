import express, { Router } from 'express';

import { renderAnswerPage } from './answerPage.js';
import type { AnswerEntry, AnswerStore } from './answerStore.js';

/**
 * Public answer-link routes (Phase 1 of the deep-link concept). Mounted onto
 * the channel's public router (same `core.registerRouter` mount as the
 * Sendblue webhook), so all paths below are relative to `/api/imessage`:
 *
 *   GET  /a/:token              HTML fallback page (also the OG-preview target)
 *   GET  /answers/:token        structured JSON payload (API clients)
 *   POST /answers/:token/reply  accept the selection, drive the turn detached
 *
 * Authorization is the capability token itself — the link was delivered only
 * to the recipient's iMessage number. GET is side-effect free by contract
 * (Apple's preview crawler fetches the page); only the POST transitions state.
 */

export interface AnswersRouterDeps {
  store: AnswerStore;
  /** Route prefix the parent router is mounted under (for absolute paths in
   *  the page/JSON), e.g. `/api/imessage`. */
  routePrefix: string;
  /**
   * Drive one orchestrator turn for an accepted reply. Called DETACHED after
   * the 202 — an orchestrator turn can take longer than any sane HTTP
   * timeout. Must not throw (mirrors the webhook's handleInbound contract).
   */
  onReply: (entry: AnswerEntry, option: { label: string; value: string }) => Promise<void>;
  log: (
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    data?: Record<string, unknown>,
  ) => void;
}

export function createAnswersRouter(deps: AnswersRouterDeps): Router {
  const router = Router();

  router.get('/a/:token', (req, res) => {
    const token = String((req.params as Record<string, string>)['token'] ?? '');
    const entry = deps.store.get(token) ?? null;
    // No app handoff yet: the mobile app registers no URL scheme, so the page
    // renders the web selection only (appUrl stays null).
    res
      .status(entry ? 200 : 404)
      .type('html')
      .send(
        renderAnswerPage({
          entry,
          replyPath: `${deps.routePrefix}/answers/${encodeURIComponent(token)}/reply`,
          appUrl: null,
        }),
      );
  });

  router.get('/answers/:token', (req, res) => {
    const token = String((req.params as Record<string, string>)['token'] ?? '');
    const entry = deps.store.get(token);
    if (!entry) {
      res.status(404).json({ ok: false, error: 'unknown token' });
      return;
    }
    if (entry.state === 'expired') {
      res.status(410).json({ ok: false, error: 'expired', state: 'expired' });
      return;
    }
    res.json({
      ok: true,
      state: entry.state,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      question: entry.choice.question,
      ...(entry.choice.rationale ? { rationale: entry.choice.rationale } : {}),
      interactive: {
        kind: 'choice',
        options: entry.choice.options,
      },
      conversationHint: `iMessage · ${maskPhone(entry.conversationId)}`,
    });
  });

  router.post('/answers/:token/reply', express.json(), (req, res) => {
    const token = String((req.params as Record<string, string>)['token'] ?? '');
    const value =
      typeof (req.body as { value?: unknown } | undefined)?.value === 'string'
        ? (req.body as { value: string }).value
        : '';
    if (value.length === 0) {
      res.status(400).json({ ok: false, error: 'value (string) is required' });
      return;
    }

    const result = deps.store.reply(token, value);
    switch (result.outcome) {
      case 'missing':
        res.status(404).json({ ok: false, error: 'unknown token' });
        return;
      case 'expired':
        res.status(410).json({ ok: false, error: 'expired', state: 'expired' });
        return;
      case 'conflict':
        res.status(409).json({ ok: false, error: 'already answered', state: 'answered' });
        return;
      case 'invalid-value':
        res.status(400).json({ ok: false, error: 'value is not one of the offered options' });
        return;
      case 'ok':
        break;
    }

    // 202 immediately — the orchestrator turn runs detached and its answer
    // arrives via Sendblue in the iMessage conversation, not on this response.
    res.status(202).json({ ok: true, state: 'answered', echo: result.option.label });

    void deps.onReply(result.entry, result.option).catch((err) => {
      deps.log('error', 'iMessage answer-link reply turn crashed', {
        error: (err as Error).message,
        conversationId: result.entry.conversationId,
      });
    });
  });

  return router;
}

/** Mask a phone number down to its trailing digits: `+491701234567` → `+49 … 67`. */
export function maskPhone(value: string): string {
  const digits = value.replace(/[^\d+]/g, '');
  if (digits.length <= 4) return '…';
  const prefix = digits.startsWith('+') ? digits.slice(0, 3) : digits.slice(0, 2);
  return `${prefix} … ${digits.slice(-2)}`;
}
