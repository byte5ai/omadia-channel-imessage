<div align="center">

# @omadia/channel-imessage

### Talk to your omadia agents from iMessage.

An omadia channel plugin that connects Apple iMessage to your agent team via the [Sendblue](https://sendblue.com) REST API. Inbound texts arrive over a webhook, replies go back through Sendblue's send-message endpoint.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Built for omadia](https://img.shields.io/badge/built%20for-omadia-2496ED.svg)](https://github.com/byte5ai/omadia)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[**Main repo**](https://github.com/byte5ai/omadia) · [**Website**](https://omadia.ai) · [**Plugin hub**](https://hub.omadia.ai) · [**What it does**](#what-it-does) · [**Install**](#install)

🇩🇪 Diese Anleitung gibt es auch [auf Deutsch](./README.de.md).

</div>

---

omadia is a self-hostable agentic OS: compose multi-agent teams from signed plugins, run them on your own machine, and get an auditable trail for every action. This plugin lets you reach those agents from iMessage. Main repo: [byte5ai/omadia](https://github.com/byte5ai/omadia).

## What it does

Connects iMessage to omadia through Sendblue, a hosted iMessage relay with a REST API. One-to-one chats sent to your Sendblue line are routed into the omadia orchestrator, and the reply comes back in the same chat (with a best-effort typing indicator while the agent thinks). You can limit access with a phone-number allowlist. Group chats are not supported in v1 and are dropped.

> ⚠️ **Note:** Apple offers no public iMessage API — Sendblue is an unofficial relay, so continuity depends on the provider. The connector is provider-swappable: only the thin REST client (`src/sendblueClient.ts`) is Sendblue-specific.

## How it works in omadia

A channel plugin (`kind: channel`). The omadia kernel activates it from `manifest.yaml` and calls the exported `activate(ctx, core)`. The plugin mounts a public webhook at

```
POST /api/imessage/webhook/:token
```

via `core.registerRouter`. Every inbound Sendblue webhook is verified with a timing-safe shared-secret check (the `:token` path segment — or any request-header value — must equal the configured `webhook_secret`), answered with `200` immediately, and processed asynchronously: status callbacks / echoes / groups / duplicates are filtered, the message becomes an `IncomingTurn` (`channelType: imessage`), the orchestrator answers, and the rendered plain-text reply is sent back through `POST {api_base_url}/api/send-message`.

It needs an LLM provider assigned to the orchestrator first.

## Install

1. Install from the [plugin hub](https://hub.omadia.ai) in the omadia admin UI (Store, Upload), or drop the built ZIP in directly.
2. Create a [Sendblue](https://sendblue.com) account, note your line number (E.164) and copy the **API Key ID** / **API Secret Key** from the dashboard.
3. Generate a long random webhook secret yourself (e.g. `openssl rand -hex 32`).
4. Fill in the setup fields (below) and start the plugin.
5. In the Sendblue dashboard, register the receive webhook:
   `https://<PUBLIC_BASE_URL>/api/imessage/webhook/<webhook_secret>`
   If Sendblue offers a separate webhook-secret field, put the same token there too.

**Sandbox note:** on Sendblue's free/sandbox tier you share a line — recipients must have texted the line first / be verified before the API can message them.

## Configuration

| Setup field | Notes |
| --- | --- |
| `api_key_id` (secret) | Sendblue API Key ID (sent as `sb-api-key-id`). |
| `api_secret_key` (secret) | Sendblue API Secret Key (sent as `sb-api-secret-key`). |
| `from_number` | Your Sendblue line, E.164 (e.g. `+15122164639`). |
| `webhook_secret` (secret) | Self-generated random token; last path segment of the webhook URL. |
| `api_base_url` | Default `https://api.sendblue.co` (send-message). |
| `api_v2_base_url` | Default `https://api.sendblue.com` (typing indicator — note `.com`). |
| `allowlist` | Optional comma-separated E.164 numbers; empty = everyone. |
| `public_base_url` | Optional public HTTPS origin of the omadia instance. Enables **answer links** (see below); empty = disabled. |
| `answer_link_ttl_hours` | How long an answer link stays answerable. Default `24`. |

## Answer links (interactive choices)

iMessage cannot render choice buttons. With `public_base_url` set, an answer
carrying an interactive choice card additionally includes a capability URL:

```
https://<public_base_url>/api/imessage/a/<token>
```

Tapping it opens a self-contained selection page in the browser; the pick is
POSTed back and injected into the **same iMessage conversation session** — the next
answer arrives in iMessage as usual. Replying by text always keeps working;
a text reply invalidates the pending link (a later tap shows "already
answered"). The token is 128-bit random, single-use, TTL-bound, and the only
authorization (it is delivered exclusively to the recipient's number). `GET`
is side-effect free, so Apple's link-preview crawler can never answer.

After a pick, the page replaces the question with a confirmation and offers a
`sms:` link back to the configured `from_number` — the thread the answer
arrives in — so the user is handed back to the conversation instead of being
left in the browser. The page follows omadia's Lume design language; it carries
its own token copy because it ships without external assets.

**Link preview.** The answer link is sent as a second bubble containing only
the URL — iMessage unfurls a link into a preview card only when the message is
nothing but the URL. The fallback page carries `og:title` (the question),
`og:url` and a static `og:image` banner, so the card shows the question
over an Omadia banner. Whether the card actually appears depends on the
sending relay generating the preview (or the recipient's device fetching it);
the text bubble stays complete either way.

Routes (mounted on the same public router as the webhook):

| Route | Purpose |
| --- | --- |
| `GET /api/imessage/a/:token` | HTML fallback page (also the OG-preview target). |
| `GET /api/imessage/a/assets/preview.jpg` | Static 1200×630 banner referenced as `og:image`. |
| `GET /api/imessage/answers/:token` | Structured JSON payload (API clients; a mobile-app handoff is not wired yet). |
| `POST /api/imessage/answers/:token/reply` | Accept `{ "value": … }`; `202`, then the turn runs detached. |

## Agent binding (operator channels dashboard)

The plugin contributes its configured line to the operator channels dashboard
(`GET /api/v1/operator/channels`), so the line is a pickable binding key.
Binding an Agent to the **line** (`from_number`) makes it the default for every
conversation on that line; a binding on a specific **sender E.164** wins over
it. Unbound conversations fall back to the platform fallback Agent, then to the
default orchestrator.

## Privacy & data transit

> ⚠️ **All message content transits Sendblue's infrastructure** — both
> directions, including attachments (inbound media is fetched by the
> orchestrator from Sendblue-hosted URLs). Sendblue is a third-party relay and
> **not an Apple-sanctioned API**; Apple could disrupt relays at any time.

Treat the channel as **opt-in**: enable it deliberately, inform the people who
will text the line that a relay provider processes the content, and use the
`allowlist` to keep the audience explicit. omadia's outbound privacy-guard
masking applies to iMessage exactly as to every other external channel — it
runs in the orchestrator's answer path, before this plugin renders and sends.

Webhook-secret handling: the secret rides as the last URL path segment, which
can surface in intermediary access logs (reverse proxies, load balancers). If
Sendblue's dashboard offers a webhook-secret **header** field, set the same
token there too — the plugin accepts the secret from any request header and
the path segment then never needs to appear in logs you don't control.
Answer-link tokens are 128-bit random, single-use, TTL-bound capability
tokens; treat an answer-link URL like the message content it represents.

## Build from source

```bash
npm install         # dev deps only — the plugin has zero runtime deps
npm run typecheck   # tsc --noEmit (needs the adjacent omadia checkout, see below)
npm test            # node:test suite — unit tests + mocked-webhook integration tests
npm run build       # esbuild bundle → dist/plugin.js, then zip in out/
```

`@omadia/channel-sdk` and `@omadia/plugin-api` are provided by the omadia host at runtime (peer deps, never installed here). For the typecheck (and the test bundle) they are resolved from an adjacent checkout at `../omadia/middleware/packages/*/dist` — build those package dists first (`npm run build` inside each package).

The test suite (`tests/`) covers the markdown-degradation renderer, webhook auth (timing-safe secret, 401 path), inbound filtering (allowlist, dedupe, group drop), the answer-link store/routes, and a full mocked-webhook integration pass (Sendblue stubbed, orchestrator scripted) — no live Sendblue account needed.

## License

[MIT](LICENSE), byte5 GmbH
