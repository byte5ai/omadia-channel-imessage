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
mountet über `ctx.routes.register` mit `auth: 'custom'` einen öffentlichen
Webhook unter

```
POST /api/imessage/webhook/:token
```

Sendblue hat keinen omadia-Login. Das Manifest deklariert deshalb
`/api/imessage` unter `permissions.public_paths`; omadia liefert dieses Präfix
erst dann ohne Operator-Sitzung aus, wenn der Operator es freigegeben hat (siehe
[Installation](#installation)).

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
5. Gib den öffentlichen Pfad frei. Der Installationsdialog fragt, ob das Plugin
   `/api/imessage` ohne Operator-Sitzung ausliefern darf; wurde das
   übersprungen, öffne die Plugin-Seite → **Freigaben** und erteile die Freigabe
   dort. Bis dahin ist keine Route unter `/api/imessage` erreichbar — die
   Zustellungen von Sendblue und jeder Antwort-Link schlagen fehl. Jede dieser
   Anfragen authentifiziert das Plugin selbst (Webhook-Secret, einmalig
   gültiges Antwort-Link-Token); die Admin-UI unter `/api/imessage-channel`
   gehört nicht zur Freigabe und bleibt hinter dem Login.
6. Trage im Sendblue-Dashboard den Receive-Webhook ein:
   `https://<PUBLIC_BASE_URL>/api/imessage/webhook/<webhook_secret>` Bietet
   Sendblue zusätzlich ein Webhook-Secret-Feld an, trage dort dasselbe Token
   ein.

**Host-Version:** Benötigt einen omadia-Host mit `@omadia/plugin-api` 1.47.0
oder neuer (`compat.core` im Manifest). Ältere Hosts liefern die öffentlichen
Pfade eines Channel-Plugins nicht aus; sie lehnen die Installation ab, statt
jeden Webhook mit 401 zu beantworten.

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
| `answer_link_ttl_hours`   | Wie lange ein Antwort-Link beantwortbar bleibt. Default `24`. Siehe State-Hinweis unten — die TTL ist eine Obergrenze, keine Zusage. |

## Antwort-Links (interaktive Auswahlfragen)

> **Inaktiv, bis omadia es deklariert.** Seit 0.4.0 muss jedes Element, das der
> Channel um eine Antwort legt, in omadias Dekorations-Registry deklariert sein.
> Der Registry-Eintrag `decision_card` (die Auswahl-Affordance) listet `teams`
> und `web` als Channels, nicht `imessage`; der Link wird daher vorerst **nicht
> gesendet**, eine Auswahlkarte kommt als nummerierte Liste an, und eine Antwort
> wie `2` beantwortet sie. Es fehlt genau dieser eine Eintrag in `decorations.ts`
> des Kernels (seine Channel-Liste, mit der schriftlichen Begründung: ein
> Link-Tipp gegenüber dem Tippen einer Ziffer). Routen und Code unten bleiben
> bestehen; der Link kehrt von selbst zurück, sobald die Registry ihn für
> `imessage` deklariert.

iMessage kann keine Auswahl-Buttons darstellen. Ist `public_base_url` gesetzt
und die Affordance deklariert, enthält eine Antwort mit interaktiver
Auswahlkarte zusätzlich eine Capability-URL:

```
https://<public_base_url>/api/imessage/a/<token>
```

Ein Tap öffnet eine eigenständige Auswahlseite im Browser; die Auswahl wird
per POST zurückgegeben und in **dieselbe iMessage-Konversations-Session** injiziert —
die nächste Antwort kommt wie gewohnt per iMessage. Antworten per Text
funktioniert immer weiter; eine Text-Antwort invalidiert den offenen Link (ein
späterer Tap zeigt „bereits beantwortet“). Das Token ist 128 Bit Zufall,
einmalig nutzbar, TTL-gebunden und die einzige Autorisierung (es wird
ausschließlich an die Empfänger-Nummer zugestellt). Nur `POST` speichert je
eine Antwort — Apples Link-Preview-Crawler kann durch das Abrufen der Seite
also nie „antworten“.

Nach der Auswahl ersetzt die Seite die Frage durch eine Bestätigung und bietet
einen `sms:`-Link auf die konfigurierte `from_number` an — den Thread, in dem
die Antwort ankommt. Der User wird also zurück in die Unterhaltung geführt statt
im Browser zu stranden. Die Seite folgt der Lume-Designsprache von omadia; die
**Design-Tokens** (Farben, Abstände, Typografie) sind als Kopie in die Datei
eingebettet, weil sie ohne externe Assets ausgeliefert wird.

**Der State liegt im Prozess — das ist eine echte Einschränkung.** Offene
Antwort-Links und das Dedupe-Set für Webhooks liegen in einfachen In-Memory-Maps
in der Plugin-Instanz: nichts wird persistiert, nichts geteilt. Zwei Folgen, die
man vor dem Einsatz von Antwort-Links kennen sollte:

- **Ein Neustart entwertet alle offenen Links.** Deploy, Host-Neustart oder
  Plugin-Toggle verwerfen den Store — ein Link, den der User vor einer Minute
  bekommen hat, antwortet dann „Link nicht gefunden“, unabhängig von der TTL.
  `answer_link_ttl_hours` ist also eine Obergrenze, keine Zusage.
- **Mehr als eine Middleware-Replica bricht Links und kann Turns doppeln.** Ein
  auf Replica A erzeugtes Token kennt Replica B nicht — ein Tap, den der
  Load-Balancer auf B leitet, läuft auf 404. Ebenso wiederholt Sendblue eine
  eingehende Zustellung bis zu 3x; ein Retry auf einer Replica, die das
  Original nie gesehen hat, gilt nicht als Duplikat und startet den
  Orchestrator ein zweites Mal.

Bis der Store persistiert ist: diesen Channel auf einer einzelnen Replica
betreiben.

**Link-Preview.** Der Antwort-Link geht als zweite Bubble raus, die nur die
URL enthält — iMessage macht aus einem Link nur dann eine Preview-Card, wenn die
Nachricht ausschließlich aus der URL besteht. Die Fallback-Seite liefert
`og:title` (die Frage), `og:url` und ein statisches `og:image`-Banner, die
Card zeigt also die Frage über einem Omadia-Banner. Ob die Card tatsächlich
erscheint, hängt davon ab, ob der sendende Relay die Preview erzeugt (oder das
Empfänger-Gerät sie nachlädt); die Text-Bubble bleibt in jedem Fall vollständig.

Routen (auf demselben öffentlichen Router wie das Webhook):

| Route | Zweck |
| --- | --- |
| `GET /api/imessage/a/:token` | HTML-Fallback-Seite (zugleich OG-Preview-Ziel). |
| `GET /api/imessage/a/assets/preview.jpg` | Statisches 1200×630-Banner, referenziert als `og:image`. |
| `GET /api/imessage/answers/:token` | Strukturierter JSON-Payload (API-Clients; ein Mobile-App-Handoff ist noch nicht angebunden). |
| `POST /api/imessage/answers/:token/reply` | Nimmt `{ "value": … }` an; `202`, Turn läuft detached. |

## Agenten als Kolleginnen und Kollegen

### Einen Agenten erreichen: eine Line, `/agent <Name>`

**Eine eigene Identität pro Agent unterstützt dieses Plugin nicht.** Eine
Installation nutzt eine Sendblue-Line (`from_number`); alle Agenten antworten
also von derselben Telefonnummer. Auf Providerseite ist mehr möglich: Sendblue
erlaubt mehrere Lines pro Konto, wählt die Sende-Line über `from_number` und
meldet die empfangende Line als `sendblue_number` im Inbound-Webhook. Ein Plugin
könnte also eine Line je Agent betreiben. Dieses tut es nicht, weil:

- jede weitere Line für den Betreiber eine eigene Sendblue-Line ist und der
  Provider keine Multi-Line-Preise veröffentlicht (offenbar Vertriebsgespräch,
  teils Enterprise-Funktion): aktuelle Sendblue-Konditionen prüfen;
- Sessions, Antwort-Links und Allowlist heute auf der Absender-Nummer beruhen;
  eine zweite Line braucht einen neuen Unterhaltungs-Key (Line + Absender),
  sonst teilten zwei Agenten einen Chatverlauf;
- omadia noch keinen Vertrag für „diese Line **ist** die Identität jenes
  Agenten, vor der Auswahl eines Nutzers“ hat (siehe offene Fragen im
  0.4.0-PR).

Stattdessen wählt der Nutzer den Agenten per Text, im 1:1-Chat:

```
/agent Mira     Mira in dieser Unterhaltung verwenden
/agent          meine Wahl aufheben (das Binding gilt wieder)
/agents         die für mich hier verfügbaren Agenten auflisten
```

iMessage hat keine nativen Bot-Commands, das Plugin parst diese Eingaben daher
**nicht**: Die Nachricht geht unverändert an omadia, der ChatAgent, den omadias
Channel-Resolver liefert, führt den Befehl aus (er speichert die Auswahl des
Nutzers oder listet die Agenten) und antwortet mit einer kurzen System-Notiz.
Ein leeres `/agent` löscht die Auswahl; die Liste zeigt `/agents`. Das gilt auch
für einen Absender, den noch kein Agent bedient (der Resolver weist den Turn ab,
sein ChatAgent beantwortet den Befehl trotzdem). Wählbar sind nur Agenten, die
diesem Nutzer in iMessage zur Verfügung stehen.

Der Absender wird über den SDK-Principal `user:custom:<Nummer>` identifiziert
(z. B. `user:custom:+491701234567`), die eine Form, die jeder Channel nutzt;
zwei Personen, die dieselbe Line anschreiben, behalten so je ihren Agenten, auch
nach einem Neustart (die Auswahl liegt in omadia, nicht in diesem Plugin). Die
Art ist `custom`, der Platz, den das Channel-SDK für Channels außerhalb seiner
geschlossenen Liste bietet, weil der `userRef` des Turns sie nutzen muss und
omadia daraus anderswo denselben Principal ableitet. Es hängt keine E-Mail-Adresse
dran: Sendblue nennt eine Telefonnummer, nie eine verifizierte E-Mail.

### Wie eine Antwort aussieht

Klartext, so wie ein Kollege schreibt:

- der Antworttext; **keine Namenszeile**, solange ein Agent in der Unterhaltung
  spricht. Eine Zeile `Mira:` erscheint nur, wenn ein zweiter Agent in der
  Unterhaltung gesprochen hat oder der Sprecher gewechselt hat (der Verlauf
  liegt im Speicher: nach einem Neustart kann die nächste Antwort eine Zeile zu
  viel tragen, nie eine zu wenig);
- ein vom Agenten befragter Kollege erscheint als schlichter Absatz
  `Mira: ...`;
- eine Meldung von omadia selbst (Agent deaktiviert, für dich nicht verfügbar,
  ...) ist ein eigener Text, nie unter dem Namen eines Agenten;
- eine Auswahl ist eine nummerierte Liste; die Antwort mit der Nummer
  beantwortet sie;
- die KI-Kennzeichnung ist Teil des Textes, wie es die Häufigkeits-Einstellung
  des Betreibers vorgibt. Keine Folgefragen-Listen, Prüf-Badges, Quellen-Chips
  oder „Kürzer / Mehr Details“; die Details bleiben in omadia und lassen sich in
  Worten erfragen.

Bei längerer Arbeit zeigt der Agent den Tippindikator, sagt nach etwa 8
Sekunden einmal, dass er dran ist („Ich kümmere mich darum, das dauert einen
Moment.“), und antwortet, wenn er fertig ist. Die Bestätigung geht unter dem
Agenten raus, der für den Turn aufgelöst wurde (der Resolver nennt ihn vor der
Antwort), in den Worten des Agenten, mit der üblichen Namenszeile nur, wo INV-4
eine verlangt. Auf einem Host ohne Channel-Resolver ist vorab kein Agent bekannt
und es geht keine Bestätigung raus (der Tippindikator bleibt).

Eine Antwort ohne Sprecher, zu der auch der Resolver keinen genannt hat, wird
**zurückgehalten**: Der Absender erhält eine kurze System-Notiz, dass etwas schief
ging, das Betreiber-Log einen Fehler. Ein Pfad, der seinen Sprecher nicht nennen
kann, darf nicht senden.

### Gruppen

Gruppenchats werden nicht unterstützt: Sie werden verworfen
(`src/inbound.ts`), also ist in einer Gruppe kein Agent anwesend und es braucht
keinen Roster-Provider. Agenten arbeiten nur in 1:1-Chats.

## Agent-Bindings (Operator-Channels-Dashboard)

Das Plugin trägt die konfigurierte Line ins Operator-Channels-Dashboard ein
(`GET /api/v1/operator/channels`) — die Line ist damit ein auswählbarer
Binding-Key. Pro Turn fragt das Plugin omadias Channel-Resolver zuerst mit der
Absender-Nummer, dann mit der Line und gibt den Principal des Absenders mit.
Der Resolver antwortet `bound` oder `reject`; es gibt keinen Fallback-Agenten.
Der erste Key, der bindet, entscheidet. Die eigene Auswahl eines Nutzers
(`/agent`), ein Binding und die Default-Agent-Tabelle wendet der Resolver je Key
an. Darf der angesprochene oder gebundene Agent die Unterhaltung nicht bedienen
(deaktiviert, gelöscht, für den Absender nicht verfügbar), erhält der Absender
omadias System-Notiz mit dem Namen des Agenten, und kein anderer Agent antwortet
an seiner Stelle: Dieses Reject beendet die Suche. Spricht gar nichts einen
Agenten an, erfährt der Absender, dass kein Agent zugewiesen ist (vorher wird
noch der Line-Key versucht). Bei einem Reject läuft kein Agent; es geht nur eine
`system`-Nachricht raus, nie Worte eines Agenten. Auf einem Host ohne
Multi-Agent-Registry beantwortet dessen einziger Orchestrator jede Unterhaltung.

**Auswahlschlüssel.** omadia hängt eine Agentenauswahl an den engsten
Gesprächsschlüssel des Turns (der `channelKey` des Resolve-Aufrufs) plus den
Principal des Absenders. In einem iMessage-Chat ist das die **Absender-Nummer**:
sie ist das Gespräch und wird als Erstes übergeben, die `/agent`-Auswahl eines
Nutzers und ein Binding auf eine Absender-Nummer liegen also dort. Die **Line**
ist der zweite Key, weil das Channel-Verzeichnis sie als Binding-Key listet.
Rangfolge:

1. der Absender-Key: Auswahl, dann Binding, dann Default-Agent-Tabelle (von
   omadia je Key angewandt); ein `bound` hier ist endgültig;
2. der Line-Key, nur wenn der Absender-Key ohne Agentennennung abgelehnt hat.

Folge: Ein Default-Agent-Eintrag, der für den Absender-Key einen Agenten nennt,
verdeckt ein Binding, das nur auf der Line sitzt. Die Line nur binden, wenn die
Default-Tabelle für diesen Channel `off` ist, oder die Absender-Nummern binden.
Ein `/agent`, das getippt wird, während nur die Line bindet, wird unter dem
Line-Key gespeichert.

Das Plugin fällt nie auf den einzelnen `chatAgent@1`-Orchestrator zurück, solange
ein Resolver veröffentlicht ist, auch nicht nach einer Ablehnung: Jeder Turn
nutzt den ChatAgent des Resolve-Ergebnisses. Nur ein Host ohne Resolver (keine
Multi-Agent-Registry) nutzt den Singleton. Es wird keine Sprache an den Resolver
übergeben: Sendblue meldet die Sprache der Person nicht, omadias Notices kommen
daher in seinem Standard.

## Proaktive Nachrichten, Umfragen und Fragekarten

Eine Moderation oder ein Conductor-Schritt kann in eine iMessage-Unterhaltung
posten: Der Channel registriert TargetedSend- und ConversationSend-Provider, die
Klartext liefern (Anhänge gehen als Linkzeilen raus, es gibt keine ausgehenden
Medien; ein Principal wird als `user:custom:<Nummer>` angesprochen; Nummern
außerhalb der `allowlist` werden als nicht erlaubt abgelehnt). Sie deklarieren
**keine** Umfragen, Karten, das Senden „als eigene Identität eines Agenten“ (alle
Agenten teilen die Sendblue-Line, omadia lehnt so ein Senden ab), Erwähnungen und
kein KI-Label.

Eine Umfrage oder Fragekarte braucht in diesem Plugin keinen Code. iMessage kann
keine Karte darstellen, also postet omadia sie selbst als nummerierten Text über
den Conversation-Send, merkt sich die offene Frage und macht aus einer passenden
getippten Antwort (`2`, `1,3`, `Ja`, ...) das typisierte `card_answer`,
deterministisch und ohne Modell. Dafür muss omadia die Antwort sehen: Das Plugin
meldet jede angenommene eingehende Nachricht als `created`-Konversationsnachricht
(direkt, `addressedToBot: true`, weil jede iMessage eine Direktnachricht an die
Line ist, Autor ist die von Sendblue genannte Nummer). Sendblue liefert keine
Reply-to-Nachrichten-ID, `replyToMessageId` wird also nie gesetzt; bei genau einer
offenen Frage in der Unterhaltung reicht die adressierte Antwort. Das Plugin meldet die Nachricht mit
`reportConversationMessage` und wartet auf das Urteil des Kernels, bevor es einen
Turn startet: Hat omadia die Nachricht als getippte Antwort genommen
(`answeredCard`), startet **kein Turn** (keine Bestätigung, keine Agentenantwort;
der Agent antwortet nicht zusätzlich auf „2“). Das Warten ist auf 1,5 s begrenzt:
Ein langsamer oder fehlschlagender Report heißt „nicht verbraucht“, und der Turn
läuft. Liest omadia alle Nachrichten einer Unterhaltung selbst
(`conversationDelivery` ist `all`), ist das Event der einzige Weg und es startet
kein Turn. Auf einem Kernel ohne `reportConversationMessage` wird die Nachricht
ohne Warten gemeldet und der Turn läuft wie bisher.

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
