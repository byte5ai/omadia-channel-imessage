<div align="center">

# @omadia/channel-imessage

### Sprich mit deinen omadia-Agenten aus iMessage.

Ein omadia-Channel-Plugin, das Apple iMessage über die
[Sendblue](https://sendblue.com)-REST-API mit deinem Agenten-Team verbindet.
Eingehende Nachrichten kommen per Webhook an, Antworten gehen über Sendblues
send-message-Endpoint zurück.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Built for omadia](https://img.shields.io/badge/built%20for-omadia-2496ED.svg)](https://github.com/byte5ai/omadia)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[**Haupt-Repo**](https://github.com/byte5ai/omadia) ·
[**Website**](https://omadia.ai) · [**Plugin-Hub**](https://hub.omadia.ai) ·
[**Was es kann**](#was-es-kann) · [**Installation**](#installation)

🇬🇧 This guide is also available [in English](./README.md).

</div>

---

omadia ist ein selbst-hostbares agentisches OS: stelle Multi-Agent-Teams aus
signierten Plugins zusammen, betreibe sie auf der eigenen Maschine und erhalte
für jede Aktion eine nachvollziehbare Spur. Dieses Plugin macht diese Agenten
aus iMessage erreichbar. Haupt-Repo:
[byte5ai/omadia](https://github.com/byte5ai/omadia).

## Was es kann

Verbindet iMessage über Sendblue — einen gehosteten iMessage-Relay mit REST-API
— mit omadia. Einzelchats an deine Sendblue-Line werden in den
omadia-Orchestrator geleitet, und die Antwort kommt im selben Chat zurück (mit
Best-Effort-Tipp-Indikator, während der Agent nachdenkt). Den Zugriff kannst du
mit einer Nummern-Allowlist begrenzen. Gruppenchats werden in v1 nicht
unterstützt und verworfen.

> ⚠️ **Hinweis:** Apple bietet keine öffentliche iMessage-API — Sendblue ist
> eine inoffizielle Anbindung, die Kontinuität hängt also vom Provider ab.

## So funktioniert es in omadia

Ein Channel-Plugin (`kind: channel`). Der omadia-Kernel aktiviert es aus der
`manifest.yaml` und ruft das exportierte `activate(ctx, core)` auf. Das Plugin
mountet über `core.registerRouter` einen öffentlichen Webhook unter

```
POST /api/imessage/webhook/:token
```

Jeder eingehende Sendblue-Webhook wird timing-sicher gegen das Shared-Secret
geprüft (das Pfadsegment `:token` — oder ein beliebiger Request-Header-Wert —
muss dem konfigurierten `webhook_secret` entsprechen), sofort mit `200`
beantwortet und asynchron verarbeitet: Status-Callbacks / Echos / Gruppen /
Duplikate werden gefiltert, die Nachricht wird zum `IncomingTurn`
(`channelType: imessage`), der Orchestrator antwortet, und die gerenderte
Klartext-Antwort geht per `POST {api_base_url}/api/send-message` zurück.

Es braucht zuerst einen LLM-Provider, der dem Orchestrator zugewiesen ist.

## Installation

1. Installiere über den [Plugin-Hub](https://hub.omadia.ai) in der
   omadia-Admin-UI (Store, Upload), oder lade das gebaute ZIP direkt hoch.
2. Lege ein [Sendblue](https://sendblue.com)-Konto an, notiere deine Line-Nummer
   (E.164) und kopiere **API Key ID** / **API Secret Key** aus dem Dashboard.
3. Generiere selbst ein langes Zufallstoken als Webhook-Secret (z.B.
   `openssl rand -hex 32`).
4. Fülle die Setup-Felder (unten) aus und starte das Plugin.
5. Trage im Sendblue-Dashboard den Receive-Webhook ein:
   `https://<PUBLIC_BASE_URL>/api/imessage/webhook/<webhook_secret>` Bietet
   Sendblue zusätzlich ein Webhook-Secret-Feld an, trage dort dasselbe Token
   ein.

**Sandbox-Hinweis:** Im Free-/Sandbox-Tarif von Sendblue teilst du dir eine Line
— Empfänger müssen die Nummer zuerst anschreiben bzw. verifiziert sein, bevor
die API sie erreichen darf.

## Konfiguration

| Setup-Feld                | Hinweis                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `api_key_id` (Secret)     | Sendblue API Key ID (gesendet als `sb-api-key-id`).                   |
| `api_secret_key` (Secret) | Sendblue API Secret Key (gesendet als `sb-api-secret-key`).           |
| `from_number`             | Deine Sendblue-Line, E.164 (z.B. `+15122164639`).                     |
| `webhook_secret` (Secret) | Selbst generiertes Zufallstoken; letztes Pfadsegment der Webhook-URL. |
| `api_base_url`            | Default `https://api.sendblue.co` (send-message).                     |
| `api_v2_base_url`         | Default `https://api.sendblue.com` (Tipp-Indikator — beachte `.com`). |
| `allowlist`               | Optionale komma-getrennte E.164-Nummern; leer = alle erlaubt.         |

## Aus dem Quellcode bauen

```bash
npm install         # nur Dev-Deps — das Plugin hat null Runtime-Deps
npm run typecheck   # tsc --noEmit (braucht den benachbarten omadia-Checkout, siehe unten)
npm run build       # esbuild-Bundle → dist/plugin.js, dann Zip in out/
```

`@omadia/channel-sdk` und `@omadia/plugin-api` stellt der omadia-Host zur
Laufzeit bereit (Peer-Deps, werden hier nie installiert). Für den Typecheck
werden sie über die `tsconfig.json`-`paths` aus einem benachbarten Checkout
unter `../omadia/middleware/packages/*/dist` aufgelöst — baue diese
Package-Dists zuerst (`npm run build` im jeweiligen Package).

## Lizenz

[MIT](LICENSE), byte5 GmbH
