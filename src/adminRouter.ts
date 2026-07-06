import express, { type Router } from 'express';

import type { ChannelState } from './state.js';

export interface AdminRouterDeps {
  /** Absolute path to the bundled `assets/admin-ui` directory. */
  uiAssetsPath: string;
  state: ChannelState;
  /** True during the kernel's admin-route smoke probe — return mock data. */
  smokeMode: boolean;
  /** The webhook path template shown to the operator (secret NOT substituted —
   *  the page never sees the real token). */
  webhookPath: string;
}

/**
 * Express router for the iMessage admin UI. Mounted by `activate()` at
 * `/api/imessage-channel/admin` via `ctx.routes.register`, then surfaced as an
 * iframe by web-ui because the manifest declares `admin_ui_path`. Serves the
 * single-file status page plus a tiny JSON API the page polls.
 *
 * Status-only (like Discord): a webhook channel has no long-lived connection
 * to reconnect and no session to log out of.
 *
 * Response contract (host smoke-checks this): every endpoint returns
 * `{ ok: true, ... }` on success or `{ ok: false, error }` on failure.
 */
export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = express.Router();

  // Static single-file UI. `redirect: false` avoids the trailing-slash →
  // Next-rewrite → express.static 3x-redirect chain that breaks iframe loads.
  router.use(express.static(deps.uiAssetsPath, { redirect: false }));

  router.get('/api/status', (_req, res) => {
    if (deps.smokeMode) {
      res.json({
        ok: true,
        status: 'connected',
        me: { fromNumber: '+15550000000' },
        webhookPath: deps.webhookPath,
        webhookVerified: true,
        lastInboundAt: deps.state.lastInboundAt ?? null,
        lastError: null,
        updatedAt: deps.state.updatedAt,
      });
      return;
    }
    const s = deps.state;
    res.json({
      ok: true,
      status: s.status,
      me: s.me,
      webhookPath: deps.webhookPath,
      webhookVerified: s.webhookVerified ?? false,
      lastInboundAt: s.lastInboundAt ?? null,
      lastError: s.lastError,
      updatedAt: s.updatedAt,
    });
  });

  return router;
}
