# Changelog

## 0.4.0

Agents as colleagues (epic byte5ai/omadia#2042, issue #2). **Needs a kernel
that provides the speaker, plain-text renderer, decoration registry and pace
contracts (omadia#2045, #2086, #2087, branch S6): do not publish before that
kernel runs on the target instance.**

- **Answers render through the SDK plain-text renderer** (`renderPlainAnswer`).
  A name line (`Mira:`) only where the speaker would be unclear (a second agent
  spoke in the conversation, or the speaker changed), never on every message.
  A consulted colleague's contribution is a plain `Mira: ...` paragraph. A kernel
  `system` notice is its own text, not under an agent's name.
- **Removed: follow-up lists (`💡 Du kannst auch fragen`) and the disclaimer
  line.** They are not declared decorations for this channel. The AI disclosure
  stays in the answer text as the operator's `ai_disclosure_frequency` renders it.
- **Choice cards are numbered** (`1) ...`) and answered by replying with the
  number; the plugin maps a bare number back to the option's value. The
  "Bitte antworte mit einer der Optionen" line is gone.
- **The choice answer link is no longer sent** while the decoration registry
  does not declare `decision_card` for `imessage` (it lists Teams and web only).
  Routes, store and settings are unchanged and the link returns once declared.
- **One emitter.** Every message, an agent's answer or a notice of the channel,
  carries its speaker (`system` for the channel's own notices) and leaves through
  `src/emit.ts`; a test counts the `sendMessage` call sites.
- **Agent selection.** The sender's principal is passed to the channel resolver
  so the kernel can apply the user's `/agent <Name>` selection ahead of a binding.
  `/agent ...` is sent to omadia unchanged (no parser in the plugin; iMessage has
  no native commands) and the kernel's notice is shown. An unavailable agent is
  named in the kernel's system notice and never replaced by another agent
  (INV-7). See "Resolver contract" below for the final rules.
- **Pace.** The agent call runs through `runPacedTurn`: typing indicator, one
  acknowledgement after about 8 s (under the agent's speaker, see below), no
  progress chatter. There is no reply window
  (the webhook is answered at once).
- **Resolver contract (omadia#2055, S1).** The channel resolver answers `bound` or
  `reject` (no `fallback`, no `match`). The first key (sender, then line) that
  binds decides; a reject that names an agent ends the search (INV-7). On a
  reject the text still goes to the resolver's ChatAgent (it carries out
  `/agent`, `/agent` empty = clear, `/agents` = list) and only its `system`
  answer is sent; an agent-voiced answer on a reject is withheld. Without a
  ChatAgent or notice the channel's own "no agent assigned" text goes out as
  `system`. No `agentSelection` use, no `parseAgentCommand`, no extra
  `optional_requires`.
- **Principal** is `channelUserPrincipal({ kind: 'custom', id: <number> })`,
  `user:custom:+49…` (was `user:<number>`). `custom` because `ChannelUserKind`
  has no iMessage member and the turn's `userRef` must use one; the kernel derives
  the same principal from it. No e-mail: Sendblue does not verify one.
- **Speaker up front.** The pace acknowledgement is sent under the agent the
  resolver named before the answer (`ChannelResolveResult.speaker`), not as
  `system`. An answer without a speaker takes the resolver's speaker; with
  neither it is **withheld** and the sender gets a `system` notice (fail-closed;
  the old "warn and send anyway" is gone). Without a resolver no speaker is known
  beforehand and no acknowledgement is sent.
- **Send providers (criterion 30).** `TargetedSend` and `ConversationSend`
  providers: text, polls and single-question cards as numbered text
  (`renderCardAsText`), replies parsed with `parseCardReply` and forwarded as
  typed `card_answer` conversation messages (`emitConversationMessage`). Declared:
  `poll`, `card` (7 kinds, 1 question, no update). Not declared: `asChannelKey`,
  `mentions`, `aiLabel`. Numbers outside the allowlist are `not_permitted`.
- **compat.core** is the placeholder `>=1.74.0 <2.0` (the parent session sets the
  final floor and the version when the kernel lands).
- README (EN, DE): per-agent identity is **not supported** (one Sendblue line
  per installation; what multiple lines would take and why it is not built),
  `/agent` selection, what an answer looks like, groups unsupported.
- Tests: criterion 5 (emitter paths), 29/30 (plain text, channel parity),
  31 (decoration registry), resolution order, pace with a manual clock. The
  suite runner now aliases both the channel SDK and plugin-api dists
  (`OMADIA_CHANNEL_SDK_DIST`, `OMADIA_PLUGIN_API_DIST`).

## 0.3.1

- **A conversation without an Agent is refused in the chat**
  (byte5ai/omadia#1598). When the host's binding resolver rejects every key of
  a turn — no binding on the sender, none on the line, no platform fallback
  Agent — the sender is told that no Agent is assigned to the conversation.
  Before, the turn went to the default agent, whose own refusal came back as
  "an error occurred, please try again" and turned the channel status red
  although the channel was working.
- **A resolver error refuses the turn as well** instead of handing it to the
  default agent: whether a binding exists is unknown at that point, and another
  orchestrator would answer with its own grants. The sender gets the
  "try again" notice. The default agent still answers on a host that publishes
  no resolver.
- Neither refusal changes the channel status; no typing indicator is shown for
  a refused turn.
- **Manifest texts are `{ en, de }` maps** (byte5ai/omadia#1401):
  `identity.description` and the label and help of all nine setup fields. They
  were German-only strings and showed in German in an English UI.
- README: the agent-binding section describes the refusal.

## 0.3.0

The channel no longer needs anything from the omadia core to be reachable. Its
public routes are served through a public path the operator grants
(byte5ai/omadia#410).

- **Public routes go through `ctx.routes.register` with `auth: 'custom'`**
  instead of `core.registerRouter`. The manifest declares `/api/imessage` under
  `permissions.public_paths`. The host serves a plugin route without an
  operator session only for a declared, operator-granted prefix registered this
  way; a router mounted with `core.registerRouter` stays behind the session
  gate and answers 401 to every Sendblue delivery.
- **Operator action on install and on upgrade from 0.2.x:** grant
  `/api/imessage` (install dialog, or plugin page → Grants). Until then the
  webhook and every answer link are not reachable. The webhook URL registered
  in the Sendblue dashboard does not change.
- **`compat.core` is now `>=1.47.0 <2.0`.** The host claims public paths for
  channel plugins since byte5ai/omadia#1616; an older host refuses the install
  instead of answering every delivery with 401.
- The admin UI stays on `/api/imessage-channel/admin`, behind the operator
  login, and is not part of the grant.
- `userRef.kind` is `custom`. The host SDK's `ChannelUserKind` union has no
  iMessage member, so the previous `imessage-handle` did not compile against a
  released host.
- Route registrations are disposed explicitly on deactivate.
- Tests: route registration (public router through `ctx.routes`, admin behind
  the session gate, disposal on close) and manifest ↔ public-path consistency.
