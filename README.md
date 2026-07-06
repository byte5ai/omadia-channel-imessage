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

## Build from source

```bash
npm install         # dev deps only — the plugin has zero runtime deps
npm run typecheck   # tsc --noEmit (needs the adjacent omadia checkout, see below)
npm run build       # esbuild bundle → dist/plugin.js, then zip in out/
```

`@omadia/channel-sdk` and `@omadia/plugin-api` are provided by the omadia host at runtime (peer deps, never installed here). For the typecheck they are resolved via `tsconfig.json` `paths` from an adjacent checkout at `../omadia/middleware/packages/*/dist` — build those package dists first (`npm run build` inside each package).

## License

[MIT](LICENSE), byte5 GmbH
