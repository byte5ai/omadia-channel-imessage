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
| `public_base_url`         | Optionaler öffentlicher HTTPS-Origin der omadia-Instanz. Aktiviert **Antwort-Links** (siehe unten); leer = deaktiviert. |
| `answer_link_ttl_hours`   | Wie lange ein Antwort-Link beantwortbar bleibt. Default `24`.         |

## Antwort-Links (interaktive Auswahlfragen)

iMessage kann keine Auswahl-Buttons darstellen. Ist `public_base_url` gesetzt,
enthält eine Antwort mit interaktiver Auswahlkarte zusätzlich eine
Capability-URL:

```
https://<public_base_url>/api/imessage/a/<token>
```

Ein Tap öffnet eine eigenständige Auswahlseite im Browser; die Auswahl wird
per POST zurückgegeben und in **dieselbe iMessage-Konversations-Session** injiziert —
die nächste Antwort kommt wie gewohnt per iMessage. Antworten per Text
funktioniert immer weiter; eine Text-Antwort invalidiert den offenen Link (ein
späterer Tap zeigt „bereits beantwortet“). Das Token ist 128 Bit Zufall,
einmalig nutzbar, TTL-gebunden und die einzige Autorisierung (es wird
ausschließlich an die Empfänger-Nummer zugestellt). `GET` ist
nebenwirkungsfrei — Apples Link-Preview-Crawler kann nie „antworten“.

Routen (auf demselben öffentlichen Router wie das Webhook):

| Route | Zweck |
| --- | --- |
| `GET /api/imessage/a/:token` | HTML-Fallback-Seite (zugleich OG-Preview-Ziel). |
| `GET /api/imessage/answers/:token` | Strukturierter JSON-Payload (API-Clients; ein Mobile-App-Handoff ist noch nicht angebunden). |
| `POST /api/imessage/answers/:token/reply` | Nimmt `{ "value": … }` an; `202`, Turn läuft detached. |

## Agent-Bindings (Operator-Channels-Dashboard)

Das Plugin trägt die konfigurierte Line ins Operator-Channels-Dashboard ein
(`GET /api/v1/operator/channels`) — die Line ist damit ein auswählbarer
Binding-Key. Ein Agent-Binding auf die **Line** (`from_number`) wirkt als
Default für alle Unterhaltungen auf dieser Line; ein Binding auf eine konkrete
**Absender-Nummer** (E.164) gewinnt dagegen. Ungebundene Unterhaltungen fallen
auf den Plattform-Fallback-Agenten zurück, danach auf den
Standard-Orchestrator.

## Datenschutz & Datentransit

> ⚠️ **Sämtlicher Nachrichteninhalt läuft über die Infrastruktur von
> Sendblue** — in beide Richtungen, inklusive Anhängen (eingehende Medien
> holt der Orchestrator von Sendblue-gehosteten URLs). Sendblue ist ein
> Dritt-Relay und **keine von Apple sanktionierte API**; Apple kann Relays
> jederzeit stören.

Behandle den Channel als **Opt-in**: aktiviere ihn bewusst, informiere die
Personen, die die Line anschreiben, dass ein Relay-Provider die Inhalte
verarbeitet, und halte den Kreis mit der `allowlist` explizit. omadias
Outbound-Privacy-Guard-Maskierung greift bei iMessage genau wie bei jedem
anderen externen Channel — sie läuft im Antwort-Pfad des Orchestrators, bevor
dieses Plugin rendert und sendet.

Zum Webhook-Secret: Das Secret steht als letztes URL-Pfadsegment und kann in
Access-Logs von Zwischenstationen auftauchen (Reverse Proxies, Load Balancer).
Bietet das Sendblue-Dashboard ein Feld für einen Webhook-Secret-**Header**,
trage dasselbe Token auch dort ein — das Plugin akzeptiert das Secret aus
jedem Request-Header, und das Pfadsegment muss dann nie in fremden Logs
erscheinen. Antwort-Link-Tokens sind 128-Bit-Zufalls-Capability-Tokens
(einmalig nutzbar, TTL-gebunden); behandle eine Antwort-Link-URL wie den
Nachrichteninhalt, den sie repräsentiert.

## Aus dem Quellcode bauen

```bash
npm install         # nur Dev-Deps — das Plugin hat null Runtime-Deps
npm run typecheck   # tsc --noEmit (braucht den benachbarten omadia-Checkout, siehe unten)
npm test            # node:test-Suite — Unit-Tests + Mocked-Webhook-Integrationstests
npm run build       # esbuild-Bundle → dist/plugin.js, dann Zip in out/
```

`@omadia/channel-sdk` und `@omadia/plugin-api` stellt der omadia-Host zur
Laufzeit bereit (Peer-Deps, werden hier nie installiert). Für den Typecheck
(und das Test-Bundle) werden sie aus einem benachbarten Checkout unter
`../omadia/middleware/packages/*/dist` aufgelöst — baue diese Package-Dists
zuerst (`npm run build` im jeweiligen Package).

Die Test-Suite (`tests/`) deckt den Markdown-Degradation-Renderer, die
Webhook-Authentifizierung (timing-sicheres Secret, 401-Pfad), das
Inbound-Filtern (Allowlist, Dedupe, Gruppen-Drop), Store/Routen der
Antwort-Links sowie einen kompletten Mocked-Webhook-Integrationslauf ab
(Sendblue gestubbt, Orchestrator geskriptet) — kein Live-Sendblue-Konto
nötig.

## Lizenz

[MIT](LICENSE), byte5 GmbH
