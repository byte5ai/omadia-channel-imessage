import type { AnswerEntry } from './answerStore.js';

/**
 * Server-rendered fallback page for answer links (`GET /api/imessage/a/:token`).
 *
 * This page is what a recipient WITHOUT the Omadia app sees — and what
 * Apple's link-preview crawler fetches for the bubble card (hence the OG
 * tags). Fully self-contained (inline CSS/JS, no external assets) so it
 * renders behind any self-hosted reverse proxy. Rendering is side-effect
 * free; the actual answer is a JS `fetch` POST to the reply endpoint.
 *
 * Styling follows the Lume design language (omadia visual spec v0.4): surface
 * luminosity (gradient pairs), accent-as-illumination (two-stop glow),
 * directional borders (top edge catches light), radius scale 6/8/12.
 *
 * Token duplication is deliberate and unavoidable here: the operator UI keeps
 * the tokens in `web-ui/app/_lib/theme.css`, but this page is a standalone
 * HTML string served by a plugin process that never loads that stylesheet.
 * The subset below is a copy of the light/dark pairs for the default palette
 * (Lagoon) — re-copy it when the palette moves. Two further deviations from
 * the shell, both forced by "no external assets":
 *   - `prefers-color-scheme` blocks instead of `light-dark()` (no iOS Safari
 *     17.5 floor for a page that must work on whatever the recipient has),
 *   - the system font stack instead of self-hosted Geist.
 *
 * After a successful reply the page does NOT stay on the question: it hands
 * the user back to the conversation. The question screen is replaced by a
 * confirmation with a `sms:` deep link to the Sendblue line — the thread the
 * answer actually arrives in. Leaving the answered question on screen reads
 * as "nothing happened" and strands the user in Safari.
 */

export interface AnswerPageView {
  /** null → unknown token (404 page). */
  entry: AnswerEntry | null;
  /** Absolute reply endpoint path, e.g. `/api/imessage/answers/<token>/reply`. */
  replyPath: string;
  /**
   * The Sendblue line in E.164 (`from_number`) — the OTHER end of the
   * conversation, and therefore the `sms:` deep-link target that returns the
   * user to the right thread. NOT `entry.conversationId`: that is the
   * recipient's own number, which would open a thread with themselves.
   * Empty/missing → the return button is replaced by a written instruction.
   */
  returnNumber?: string | null;
  /** Optional deep-link URL for an "open in app" button; null/undefined hides
   *  it. Reserved — no consumer today (the mobile app registers no scheme). */
  appUrl?: string | null;
  /** Absolute URL of this page → `og:url`. Null omits the tag. */
  pageUrl?: string | null;
  /** Absolute URL of the 1200×630 JPEG banner → `og:image`. Null omits the
   *  image tags; iMessage then renders the small title-only card. */
  imageUrl?: string | null;
}

export function renderAnswerPage(view: AnswerPageView): string {
  const { entry } = view;
  const question = entry ? entry.choice.question : 'Link nicht gefunden';
  const ogTitle = truncate(question, 120);
  const smsLink = smsHref(view.returnNumber);

  let main: string;
  if (!entry) {
    main = notice(
      'Link nicht gefunden',
      'Dieser Antwort-Link ist unbekannt oder wurde bereits entfernt. Du kannst einfach direkt in iMessage antworten.',
      smsLink,
    );
  } else if (entry.state === 'expired') {
    main = notice(
      'Link abgelaufen',
      'Diese Frage ist abgelaufen. Antworte einfach direkt in iMessage, dann geht es dort weiter.',
      smsLink,
    );
  } else if (entry.state === 'answered') {
    main = notice(
      'Bereits beantwortet',
      entry.answeredVia === 'link'
        ? 'Diese Frage wurde schon beantwortet. Die Unterhaltung geht in iMessage weiter.'
        : 'Diese Frage wurde inzwischen in der Unterhaltung beantwortet oder von einer neueren Frage abgelöst. Es geht in iMessage weiter.',
      smsLink,
    );
  } else {
    main = openCard(entry, view.replyPath, smsLink);
  }

  const appButton =
    view.appUrl && entry && entry.state === 'open'
      ? `<a class="btn btn-secondary" href="${escapeAttr(view.appUrl)}">In der Omadia-App öffnen</a>`
      : '';

  const ogExtra = [
    view.pageUrl ? `<meta property="og:url" content="${escapeAttr(view.pageUrl)}">` : '',
    view.imageUrl
      ? `<meta property="og:image" content="${escapeAttr(view.imageUrl)}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<meta property="og:site_name" content="Omadia">
<meta property="og:title" content="${escapeAttr(ogTitle)}">
<meta property="og:description" content="Antwort-Auswahl · Omadia">
<meta property="og:type" content="website">
${ogExtra}
<title>Omadia · Antwort</title>
<style>
  /* ---- Lume tokens (spec §2), Lagoon palette, light values ---------------- */
  :root {
    --bg-canvas-top: #FDFDFE;
    --bg-canvas-btm: #F7F8FB;
    --surface-top: #FFFFFF;
    --surface-btm: #FCFCFE;

    --fg: #1B1D24;
    --fg-muted: #5B5F6B;
    --fg-subtle: #8D9099;
    --fg-on-accent: #FCFCFD;

    --border-subtle-top: rgba(20, 24, 36, 0.05);
    --border-subtle-btm: rgba(20, 24, 36, 0.09);
    --border-default-top: rgba(20, 24, 36, 0.08);
    --border-default-btm: rgba(20, 24, 36, 0.14);

    --accent: #1F8FA3;
    --accent-hover: #197D90;
    --accent-active: #146B7C;
    --accent-subtle: rgba(31, 143, 163, 0.12);
    --accent-glow: rgba(60, 175, 195, 0.32);
    --accent-glow-strong: rgba(60, 175, 195, 0.48);
    --accent-glow-core: rgba(180, 238, 248, 0.60);

    --danger: #A8443B;

    /* Radii (§2.9) / spacing (§2.8, 4pt grid) / motion (§2.11) */
    --radius-sm: 6px;
    --radius-md: 8px;
    --radius-lg: 12px;
    --motion-quick: 100ms;
    --motion-smooth: 200ms;
    --motion-deliberate: 320ms;
    --easing-standard: cubic-bezier(0.22, 0.61, 0.36, 1);
    --easing-emphasis: cubic-bezier(0.40, 0.00, 0.20, 1);

    --font-sans: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg-canvas-top: #232631;
      --bg-canvas-btm: #1B1D24;
      --surface-top: #303440;
      --surface-btm: #292C37;

      --fg: #EEEFF3;
      --fg-muted: #B6B9C3;
      --fg-subtle: #888B95;
      --fg-on-accent: #1F2127;

      --border-subtle-top: rgba(255, 255, 255, 0.06);
      --border-subtle-btm: rgba(0, 0, 0, 0.40);
      --border-default-top: rgba(255, 255, 255, 0.10);
      --border-default-btm: rgba(0, 0, 0, 0.50);

      --accent: #6FC8D6;
      --accent-hover: #88D2DE;
      --accent-active: #A1DCE6;
      --accent-subtle: rgba(111, 200, 214, 0.20);
      --accent-glow: rgba(111, 200, 214, 0.32);
      --accent-glow-strong: rgba(111, 200, 214, 0.48);
      --accent-glow-core: rgba(210, 245, 250, 0.50);

      --danger: #E08577;
    }
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    /* §3.1 surface luminosity — the page reads as condensed light. */
    background: linear-gradient(180deg, var(--bg-canvas-top) 0%, var(--bg-canvas-btm) 100%);
    background-attachment: fixed;
    color: var(--fg);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
    line-height: 1.5; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 16px;
  }

  /* §3.1 + §3.4 — raised surface, directional border, inset top highlight.
     Cards carry no drop shadow in Lume; depth comes from the material. */
  .card {
    background: linear-gradient(180deg, var(--surface-top) 0%, var(--surface-btm) 100%);
    border: 1px solid var(--border-subtle-btm);
    border-top-color: var(--border-subtle-top);
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.06) inset;
    border-radius: var(--radius-lg);
    padding: 24px; max-width: 26rem; width: 100%;
    display: flex; flex-direction: column; gap: 16px;
  }

  /* §2.7 type scale */
  .brand { font-size: 0.75rem; line-height: 1.4; font-weight: 600; letter-spacing: 0.02em;
           text-transform: uppercase; color: var(--fg-subtle); }
  h1 { font-size: 1.375rem; line-height: 1.25; font-weight: 600; letter-spacing: -0.005em; }
  .body { font-size: 0.875rem; line-height: 1.5; color: var(--fg-muted); }
  .caption { font-size: 0.75rem; line-height: 1.4; color: var(--fg-subtle); }
  .body strong { color: var(--fg); font-weight: 600; }

  .options { display: flex; flex-direction: column; gap: 8px; }

  /* §4.2 button-secondary — raised surface + directional border. */
  button.opt {
    appearance: none; width: 100%; text-align: left; cursor: pointer;
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    font: inherit; font-size: 0.875rem; font-weight: 500; color: var(--fg);
    background: linear-gradient(180deg, var(--surface-top) 0%, var(--surface-btm) 100%);
    border: 1px solid var(--border-default-btm);
    border-top-color: var(--border-default-top);
    border-radius: var(--radius-md);
    padding: 12px 16px;
    transition: box-shadow var(--motion-quick) var(--easing-standard),
                border-color var(--motion-quick) var(--easing-standard),
                transform var(--motion-quick) var(--easing-standard);
  }
  button.opt:hover:not(:disabled) { box-shadow: inset 0 0 0 999px var(--accent-subtle); }
  button.opt:active:not(:disabled) { transform: scale(0.97); }
  button.opt:disabled { cursor: default; opacity: 0.6; }
  /* §4.2 selection — a lit pocket, not a paint stroke. */
  .options.done button.opt.picked {
    opacity: 1; border-color: var(--accent); border-top-color: var(--accent);
    background: var(--accent-subtle);
    box-shadow: 0 0 4px var(--accent-glow-core), 0 4px 12px var(--accent-glow);
  }

  /* §4.2 button-primary — accent gradient fill + two-stop glow (§3.2). */
  .btn {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    font: inherit; font-size: 0.875rem; font-weight: 600; text-decoration: none;
    border-radius: var(--radius-md); padding: 12px 16px; cursor: pointer;
    border: 1px solid transparent; transition: box-shadow var(--motion-quick) var(--easing-standard),
                filter var(--motion-quick) var(--easing-standard);
  }
  .btn-primary {
    background: linear-gradient(180deg, var(--accent) 0%, var(--accent-hover) 100%);
    border-color: var(--accent-hover); border-top-color: rgba(255, 255, 255, 0.18);
    color: var(--fg-on-accent);
    box-shadow: 0 0 4px var(--accent-glow-core), 0 4px 12px var(--accent-glow);
  }
  .btn-primary:hover {
    box-shadow: 0 0 6px var(--accent-glow-core), 0 6px 18px var(--accent-glow-strong);
    filter: brightness(1.04);
  }
  .btn-primary:active { background: var(--accent-active); filter: none; }
  .btn-secondary {
    background: transparent; color: var(--accent);
    border-color: var(--border-default-btm); border-top-color: var(--border-default-top);
  }

  /* §4.2 focus — the layered ring on top of the two-stop glow. */
  button:focus-visible, a:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--bg-canvas-btm), 0 0 0 4px var(--accent),
                0 0 4px var(--accent-glow-core), 0 4px 12px var(--accent-glow);
  }

  /* The status line only exists when it has something to say. While the reply
     is in flight it stays a screen-reader-only live region — the visible
     in-flight state lives on the pressed button (§7.3) — so it never reserves
     an empty row between the options and the caption. */
  .status { font-size: 0.875rem; line-height: 1.5; color: var(--danger); }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  /* §7.3 in-flight — verb plus animated dots. Never a spinner. */
  .busy::after {
    content: '.'; display: inline-block; width: 1.2em; text-align: left;
    animation: dots 1.2s steps(1, end) infinite;
  }
  @keyframes dots { 0% { content: '.'; } 33% { content: '..'; } 66% { content: '...'; } }

  /* ---- Confirmation takeover ---------------------------------------------- */
  .done-view { display: flex; flex-direction: column; align-items: center; gap: 16px; text-align: center; }
  .done-view:focus { outline: none; }
  /* §3.3 donut glow — the glyph sits in a clean pocket, the ring radiates. */
  .seal {
    width: 56px; height: 56px; border-radius: 50%; flex: none;
    display: grid; place-items: center; color: var(--accent);
    background: radial-gradient(circle at center,
      var(--accent-subtle) 0%, var(--accent-subtle) 35%,
      var(--accent-glow-core) 75%, transparent 100%);
    box-shadow: 0 0 12px var(--accent-glow-core), 0 0 22px -4px var(--accent-glow-strong);
  }
  .seal svg { display: block; }
  /* §3.5/§6.1 condensation — the confirmation materialises out of light. */
  .condense { animation: condense var(--motion-deliberate) var(--easing-emphasis) both; }
  @keyframes condense {
    from { opacity: 0; transform: scale(0.96); filter: blur(4px); }
    to   { opacity: 1; transform: none; filter: blur(0); }
  }
  .cta-row { display: flex; flex-direction: column; gap: 8px; width: 100%; }

  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: 1ms !important; transition-duration: 1ms !important; }
    .condense { animation: none; }
  }
</style>
</head>
<body>
<main class="card" id="card">
  <span class="brand">Omadia</span>
  ${main}
  ${appButton}
</main>
</body>
</html>`;
}

function openCard(entry: AnswerEntry, replyPath: string, smsLink: string | null): string {
  const rationale = entry.choice.rationale
    ? `<p class="body">${escapeHtml(entry.choice.rationale)}</p>`
    : '';
  const buttons = entry.choice.options
    .map(
      (o) =>
        `<button class="opt" type="button" data-value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</button>`,
    )
    .join('\n    ');
  return `<h1>${escapeHtml(entry.choice.question)}</h1>
  ${rationale}
  <div class="options" id="options">
    ${buttons}
  </div>
  <p class="status sr-only" id="status" role="status" aria-live="polite"></p>
  <p class="caption">Deine Auswahl wird in die iMessage-Unterhaltung übernommen.</p>
  <script>
    (function () {
      var replyPath = ${JSON.stringify(replyPath)};
      var smsLink = ${JSON.stringify(smsLink)};
      var card = document.getElementById('card');
      var box = document.getElementById('options');
      var status = document.getElementById('status');

      function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      // The takeover: the answered question is replaced, so "sent" is a state
      // the page is IN, not a line of text appended below the question.
      function confirm(label) {
        var back = smsLink
          ? '<div class="cta-row">'
            + '<a class="btn btn-primary" href="' + esc(smsLink) + '">Zurück zu iMessage &nbsp;&rsaquo;</a>'
            + '</div>'
          : '<p class="caption">Tipp oben links auf &laquo; Messages, um zur Unterhaltung zurückzukehren.</p>';
        card.innerHTML =
          '<div class="done-view condense" id="done" tabindex="-1" role="status">'
          + '<div class="seal" aria-hidden="true">'
          + '<svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor"'
          + ' stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'
          + '<path d="M5 13.5 L10.5 19 L21 7"/></svg>'
          + '</div>'
          + '<h1>Antwort gesendet</h1>'
          + '<p class="body">Du hast <strong>' + esc(label) + '</strong> gewählt.</p>'
          + '<p class="body">Die Unterhaltung geht in iMessage weiter — dort kommt gleich die Antwort an.</p>'
          + back
          + '</div>';
        var done = document.getElementById('done');
        if (done) done.focus();
      }

      // Anti-flicker floor: the POST answers in ~50ms on a warm connection, so
      // the in-flight state would appear and vanish inside one or two frames —
      // read as a glitch, not as feedback. Once shown it stays at least this
      // long; a slower reply is never delayed beyond its own latency.
      var MIN_BUSY_MS = 450;

      box.addEventListener('click', function (ev) {
        var btn = ev.target.closest('button.opt');
        if (!btn || btn.disabled) return;
        var buttons = box.querySelectorAll('button.opt');
        var label = btn.textContent;
        var startedAt = Date.now();
        // §7.3 in-flight lives on the button that was pressed — verb plus
        // animated dots, never a spinner, and never a second row of layout.
        var dots = document.createElement('span');
        dots.className = 'busy';
        dots.setAttribute('aria-hidden', 'true');

        function settle(fn) {
          var rest = MIN_BUSY_MS - (Date.now() - startedAt);
          if (rest > 0) setTimeout(fn, rest); else fn();
        }
        function dropDots() {
          if (dots.parentNode) dots.parentNode.removeChild(dots);
        }
        function reset() {
          dropDots();
          buttons.forEach(function (b) { b.disabled = false; });
          btn.classList.remove('picked');
          box.classList.remove('done');
        }
        function fail(text) {
          status.className = 'status';
          status.textContent = text;
        }

        buttons.forEach(function (b) { b.disabled = true; });
        btn.classList.add('picked');
        box.classList.add('done');
        btn.appendChild(dots);
        status.className = 'status sr-only';
        status.textContent = 'Wird gesendet';

        fetch(replyPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: btn.dataset.value })
        }).then(function (res) {
          if (res.status === 202) {
            settle(function () { confirm(label); });
            return;
          }
          return res.json().catch(function () { return {}; }).then(function (body) {
            settle(function () {
              if (res.status === 409 || res.status === 410) dropDots();
              else reset();
              fail(res.status === 409
                ? 'Diese Frage wurde inzwischen schon beantwortet.'
                : res.status === 410
                  ? 'Der Link ist inzwischen abgelaufen — antworte direkt in iMessage.'
                  : 'Senden fehlgeschlagen (' + res.status + '). Antworte direkt in iMessage.');
            });
            void body;
          });
        }).catch(function () {
          settle(function () {
            reset();
            fail('Netzwerkfehler — bitte erneut versuchen.');
          });
        });
      });
    })();
  </script>`;
}

function notice(title: string, text: string, smsLink: string | null): string {
  // Terminal states strand the user in Safari just like a fresh answer does,
  // so they get the same way back into the conversation.
  const back = smsLink
    ? `<div class="cta-row"><a class="btn btn-primary" href="${escapeAttr(smsLink)}">Zurück zu iMessage &nbsp;&rsaquo;</a></div>`
    : '';
  return `<h1>${escapeHtml(title)}</h1>
  <p class="body">${escapeHtml(text)}</p>
  ${back}`;
}

/**
 * `sms:` href for the Sendblue line, or null when no usable number is
 * configured. Anything that is not a plausible phone number is dropped rather
 * than rendered — a broken deep link is worse than no button at all.
 */
function smsHref(returnNumber: string | null | undefined): string | null {
  const raw = (returnNumber ?? '').trim();
  if (raw.length === 0) return null;
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (!/^\+?\d{6,15}$/.test(cleaned)) return null;
  return `sms:${cleaned}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
