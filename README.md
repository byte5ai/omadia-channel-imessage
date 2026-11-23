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

Connects iMessage to omadia through Sendblue, a hosted iMessage relay with a REST API. One-to-one chats sent to your Sendblue line are routed to your agents, and the reply comes back in the same chat (with a best-effort typing indicator while the agent thinks). You can limit access with a phone-number allowlist. Group chats are not supported and are dropped. Users choose the agent they talk to with `/agent <Name>` (see [Agents as colleagues](#agents-as-colleagues)).

> ⚠️ **Note:** Apple offers no public iMessage API — Sendblue is an unofficial relay, so continuity depends on the provider. The connector is provider-swappable: only the thin REST client (`src/sendblueClient.ts`) is Sendblue-specific.

## How it works in omadia

A channel plugin (`kind: channel`). The omadia kernel activates it from `manifest.yaml` and calls the exported `activate(ctx, core)`. The plugin mounts a public webhook at

```
POST /api/imessage/webhook/:token
```

via `ctx.routes.register` with `auth: 'custom'`. Sendblue has no omadia login, so the manifest declares `/api/imessage` under `permissions.public_paths`; omadia serves that prefix without an operator session only once the operator has granted it (see [Install](#install)). Every inbound Sendblue webhook is verified with a timing-safe shared-secret check (the `:token` path segment — or any request-header value — must equal the configured `webhook_secret`), answered with `200` immediately, and processed asynchronously: status callbacks / echoes / groups / duplicates are filtered, the message becomes an `IncomingTurn` (`channelType: imessage`), the agent answers, and the rendered plain-text reply is sent back through `POST {api_base_url}/api/send-message`.

It needs an LLM provider assigned to the agent runtime first.

## Install

1. Install from the [plugin hub](https://hub.omadia.ai) in the omadia admin UI (Store, Upload), or drop the built ZIP in directly.
2. Create a [Sendblue](https://sendblue.com) account, note your line number (E.164) and copy the **API Key ID** / **API Secret Key** from the dashboard.
3. Generate a long random webhook secret yourself (e.g. `openssl rand -hex 32`).
4. Fill in the setup fields (below) and start the plugin.
5. Grant the public path. The install dialog asks whether the plugin may serve `/api/imessage` without an operator session; if you skipped it, open the plugin page → **Grants** and grant it there. Until you do, no route under `/api/imessage` is reachable — Sendblue's deliveries and every answer link fail. The plugin authenticates each of those requests itself (webhook secret, single-use answer-link token); the admin UI under `/api/imessage-channel` is not part of the grant and stays behind the login.
6. In the Sendblue dashboard, register the receive webhook:
   `https://<PUBLIC_BASE_URL>/api/imessage/webhook/<webhook_secret>`
   If Sendblue offers a separate webhook-secret field, put the same token there too.

**Host version:** needs an omadia host whose `@omadia/plugin-api` is 1.47.0 or newer (`compat.core` in the manifest). Older hosts do not serve a channel plugin's public paths; they refuse the install instead of answering every webhook with 401.

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
| `answer_link_ttl_hours` | How long an answer link stays answerable. Default `24`. See the state caveat below — the TTL is an upper bound, not a guarantee. |

## Answer links (interactive choices)

> **Inactive until omadia declares it.** Since 0.4.0 every element the channel
> adds around an answer must be declared in omadia's decoration registry. The
> registry entry `decision_card` (the choice affordance) lists `teams` and `web`
> as channels, not `imessage`, so the link is **not sent** for now; a choice card
> arrives as a numbered list and a reply like `2` answers it. What is missing is
> that one entry in the kernel's `decorations.ts` (its channel list, with the
> written justification: a link tap versus typing a digit). The routes and the
> code below stay in place and the link returns on its own once the registry
> declares it for `imessage`.

iMessage cannot render choice buttons. With `public_base_url` set and the
affordance declared, an answer carrying an interactive choice card additionally
includes a capability URL:

```
https://<public_base_url>/api/imessage/a/<token>
```

Tapping it opens a self-contained selection page in the browser; the pick is
POSTed back and injected into the **same iMessage conversation session** — the next
answer arrives in iMessage as usual. Replying by text always keeps working;
a text reply invalidates the pending link (a later tap shows "already
answered"). The token is 128-bit random, single-use, TTL-bound, and the only
authorization (it is delivered exclusively to the recipient's number). Only
`POST` ever records an answer, so Apple's link-preview crawler can never
answer by fetching the page.

After a pick, the page replaces the question with a confirmation and offers a
`sms:` link back to the configured `from_number` — the thread the answer
arrives in — so the user is handed back to the conversation instead of being
left in the browser. The page follows omadia's Lume design language; it carries
its own token copy because it ships without external assets.

**State is in-process, and that is a real limit.** Open answer links and the
webhook dedupe set live in plain in-memory maps inside the plugin instance —
nothing is persisted and nothing is shared. Two consequences worth knowing
before you rely on answer links:

- **A restart voids every outstanding link.** Redeploying, restarting the
  host, or toggling the plugin drops the store, so a link the user received a
  minute ago answers with "link not found" regardless of the configured TTL.
  Treat `answer_link_ttl_hours` as an upper bound.
- **More than one middleware replica breaks links and can duplicate turns.** A
  token minted on replica A is unknown to replica B, so a tap that the load
  balancer routes to B 404s. Likewise, Sendblue retries an inbound delivery up
  to 3x; a retry landing on a replica that never saw the original is not
  recognised as a duplicate and drives the agent runtime a second time.

Run this channel on a single replica until the store is persisted.

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

## Agents as colleagues

### Reaching an agent: one line, `/agent <Name>`

**Own identity per agent is not supported by this plugin.** One installation
uses one Sendblue line (`from_number`), so every agent answers from the same
phone number. What is possible on the provider side: Sendblue lets one account
hold several lines, chooses the sending line with `from_number` and reports the
receiving line as `sendblue_number` in the inbound webhook. A plugin could
therefore run one line per agent. This one does not, because:

- every further line is a separate Sendblue line for the operator, and the
  provider does not publish multi-line pricing (it appears to be a sales
  conversation, partly an enterprise feature): check Sendblue's current terms;
- sessions, answer links and the allowlist are keyed on the sender's number
  today, so a second line needs a new conversation key (line + sender) or two
  agents would share one chat history;
- omadia has no contract yet for "this line **is** that agent's identity" that
  outranks a user's selection (see the open questions of the 0.4.0 PR).

Instead the user picks the agent by text, in the 1:1 chat:

```
/agent Mira     use Mira in this conversation
/agent          clear my choice (the binding applies again)
/agents         list the agents available to me here
```

iMessage has no native bot commands, so the plugin does **not** parse these: the
message goes to omadia unchanged, the ChatAgent omadia's channel resolver returns
carries out the command (it stores the user's selection, or lists the agents) and
answers with a short system notice. An empty `/agent` clears the selection; the
list is `/agents`. This also works for a sender no agent serves yet (the resolver
rejects the turn, and its ChatAgent still answers the command). Only agents
available to that user in iMessage can be selected.

The sender is identified by the SDK principal `user:custom:<number>` (for example
`user:custom:+491701234567`), the one form every channel uses, so two people
texting the same line each keep their own agent, also after a restart (the
selection lives in omadia, not in this plugin). The kind is `custom`, the slot
the channel SDK offers for channels outside its closed list, because the turn's
`userRef` must use it and omadia derives the same principal from it elsewhere.
No e-mail address is attached: Sendblue states a phone number, never a verified
e-mail.

### What an answer looks like

Plain text, as a colleague would write it:

- the answer text; **no name line** while one agent talks in the conversation.
  A line `Mira:` appears only when a second agent has spoken in the conversation
  or the speaker changed (the speaker history is in memory: after a restart the
  next answer may carry one line too many, never one too few);
- a colleague consulted by the agent appears as a plain `Mira: ...` paragraph;
- a notice of omadia itself (agent disabled, not available to you, ...) is its
  own text, never under an agent's name;
- a choice is a numbered list; replying with the number answers it;
- the AI disclosure line is part of the text as the operator's disclosure
  frequency setting says. No follow-up lists, verifier badges, source chips or
  "shorter / more detail" prompts; the details stay in omadia and can be asked
  for in words.

For long work the agent shows the typing indicator, says once that it is on it
("Ich kümmere mich darum, das dauert einen Moment.") after about 8 seconds, and
answers when done. The acknowledgement goes out under the agent that was resolved
for the turn (the resolver names it before the answer), in the agent's words,
with the usual name line only where INV-4 asks for one. On a host without a
channel resolver no agent is known beforehand and no acknowledgement is sent
(the typing indicator stays).

An answer that carries no speaker, and for which the resolver named none, is
**withheld**: the sender gets a short system notice that something went wrong, the
operator log gets an error. A path that cannot name its speaker cannot emit.

### Groups

Group chats are not supported: they are dropped (`src/inbound.ts`), so no
agent is present in a group and no roster provider is needed. Agents work in
1:1 chats only.

## Agent binding (operator channels dashboard)

The plugin contributes its configured line to the operator channels dashboard
(`GET /api/v1/operator/channels`), so the line is a pickable binding key.
Per turn the plugin asks omadia's channel resolver with the sender's number
first and the line second, and passes the sender's principal. The resolver
answers `bound` or `reject`; there is no fallback agent. The first key that
binds decides. A user's own selection (`/agent`), a binding and the
default-agent table are applied by the resolver within one key. If the agent
that was addressed or bound may not serve the conversation (disabled, deleted,
not available to the sender), the sender gets omadia's system notice naming it,
and no other agent answers in its place: that reject ends the search. If nothing
addresses an agent at all, the sender is told that no Agent is assigned (the
line key is still tried before). On a reject no agent runs; only a `system`
message goes out, never an agent's words. On a host without the multi-Agent
registry, its single agent runtime answers every conversation.

**Selection key.** omadia ties an agent selection to the narrowest conversation
key of the turn (the `channelKey` of the resolve call) plus the sender's
principal. In an iMessage chat that key is the **sender's number**: it is the
conversation, and it is what the plugin passes first, so a user's `/agent`
selection and a binding on a sender number both live there. The **line** is the
second key, kept because the channel directory lists it as a binding key. Rank:

1. the sender key: selection, then binding, then the default-agent table
   (applied by omadia within the key); a `bound` answer here is final;
2. the line key, only when the sender key rejected without naming an agent.

Consequence: a default-agent entry that names an agent for the sender key hides
a binding set on the line only. Bind the line only when the default table is
`off` for this channel, or bind the sender numbers. A `/agent` typed while only
the line binds is stored under the line key.

The plugin never falls back to the single `chatAgent@1` agent runtime while a
resolver is published, a refusal included: every turn uses the ChatAgent of the
resolve result. Only a host without a resolver (no multi-agent registry) uses the
singleton. No locale is passed to the resolver: Sendblue does not report the
person's language, so omadia's notices come in its default.

## Proactive messages, polls and question cards

A facilitation or a Conductor step can post into an iMessage conversation: the
channel registers TargetedSend and ConversationSend providers that deliver plain
text (attachments go out as link lines, there is no outbound media; a principal is
addressed as `user:custom:<number>`; numbers outside the `allowlist` are refused
as not permitted). They declare **no** poll, card, "as an agent's own identity"
(all agents share the Sendblue line, so omadia refuses such a send), mention or AI
label capability.

A poll or question card needs no code in this plugin. iMessage cannot render a
card, so omadia itself posts it as numbered text through the conversation send,
remembers the open question and turns a fitting typed reply (`2`, `1,3`, `Ja`,
...) into the typed `card_answer`, deterministically and without a model. For that
it has to see the reply, so the plugin reports every accepted inbound message as a
`created` conversation message: direct, `addressedToBot: true` (every iMessage is a
direct message to the line), author the number Sendblue states. Sendblue reports no
reply-to message id, so `replyToMessageId` is never set; with one open question in
the conversation the addressed reply is enough. The plugin reports the message with
`reportConversationMessage` and waits for the kernel's verdict before starting a
turn: when omadia took the message as the typed answer (`answeredCard`), **no turn
starts** (no acknowledgement, no agent answer; the agent does not also answer
"2"). The wait is capped at 1.5 s: a slow or failing report means "not consumed"
and the turn runs. Where omadia reads every message of a conversation itself
(`conversationDelivery` is `all`) the event is the only path and no turn is
started. On a kernel without `reportConversationMessage` the message is emitted
without waiting and the turn runs as before.

## Privacy & data transit

> ⚠️ **All message content transits Sendblue's infrastructure** — both
> directions, including attachments (inbound media is fetched by the
> agent runtime from Sendblue-hosted URLs). Sendblue is a third-party relay and
> **not an Apple-sanctioned API**; Apple could disrupt relays at any time.

Treat the channel as **opt-in**: enable it deliberately, inform the people who
will text the line that a relay provider processes the content, and use the
`allowlist` to keep the audience explicit. omadia's outbound privacy-guard
masking applies to iMessage exactly as to every other external channel — it
runs in the agent runtime's answer path, before this plugin renders and sends.

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

The test suite (`tests/`) covers the markdown-degradation renderer, webhook auth (timing-safe secret, 401 path), inbound filtering (allowlist, dedupe, group drop), the answer-link store/routes, and a full mocked-webhook integration pass (Sendblue stubbed, agent runtime scripted) — no live Sendblue account needed.

## License

[MIT](LICENSE), byte5 GmbH
