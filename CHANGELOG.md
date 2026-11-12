# Changelog

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
