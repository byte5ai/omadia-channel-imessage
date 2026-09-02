import type { AnswerEntry } from './answerStore.js';

/**
 * Server-rendered fallback page for answer links (`GET /api/imessage/a/:token`).
 *
 * This page is what a recipient WITHOUT the Omadia app sees — and what
 * Apple's link-preview crawler fetches for the bubble card (hence the OG
 * tags). Fully self-contained (inline CSS/JS, no external assets) so it
 * renders behind any self-hosted reverse proxy. Rendering is side-effect
 * free; the actual answer is a JS `fetch` POST to the reply endpoint.
 */

export interface AnswerPageView {
  /** null → unknown token (404 page). */
  entry: AnswerEntry | null;
  /** Absolute reply endpoint path, e.g. `/api/imessage/answers/<token>/reply`. */
  replyPath: string;
  /** Optional deep-link URL for an "open in app" button; null/undefined hides
   *  it. Reserved — no consumer today (the mobile app registers no scheme). */
  appUrl?: string | null;
}

export function renderAnswerPage(view: AnswerPageView): string {
  const { entry } = view;
  const question = entry ? entry.choice.question : 'Link nicht gefunden';
  const ogTitle = truncate(question, 120);

  let main: string;
  if (!entry) {
    main = notice(
      'Link nicht gefunden',
      'Dieser Antwort-Link ist unbekannt oder wurde bereits entfernt. Du kannst einfach direkt in iMessage antworten.',
    );
  } else if (entry.state === 'expired') {
    main = notice(
      'Link abgelaufen',
      'Diese Frage ist abgelaufen. Antworte einfach direkt in iMessage, dann geht es dort weiter.',
    );
  } else if (entry.state === 'answered') {
    main = notice(
      'Bereits beantwortet',
      entry.answeredVia === 'link'
        ? 'Diese Frage wurde schon beantwortet. Die Unterhaltung geht in iMessage weiter.'
        : 'Diese Frage wurde inzwischen in der Unterhaltung beantwortet oder von einer neueren Frage abgelöst. Es geht in iMessage weiter.',
    );
  } else {
    main = openCard(entry, view.replyPath);
  }

  const appButton =
    view.appUrl && entry && entry.state === 'open'
      ? `<a class="app-link" href="${escapeAttr(view.appUrl)}">In der Omadia-App öffnen</a>`
      : '';

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta property="og:site_name" content="Omadia">
<meta property="og:title" content="${escapeAttr(ogTitle)}">
<meta property="og:description" content="Antwort-Auswahl · Omadia">
<meta property="og:type" content="website">
<title>Omadia · Antwort</title>
<style>
  :root {
    --bg: #f5f7fa; --card: #ffffff; --ink: #17212c; --muted: #61707f;
    --line: #d9e0e8; --accent: #0a6be0; --accent-ink: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e141b; --card: #17202a; --ink: #e5ecf4; --muted: #93a3b4;
      --line: #2b3a48; --accent: #4da3ff; --accent-ink: #06121f;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    line-height: 1.5; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 1.25rem;
  }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 14px;
    padding: 1.6rem 1.4rem; max-width: 26rem; width: 100%;
    display: flex; flex-direction: column; gap: 1rem;
  }
  .brand { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
  h1 { font-size: 1.15rem; font-weight: 650; line-height: 1.35; }
  .rationale, .notice-text { color: var(--muted); font-size: 0.92rem; }
  .options { display: flex; flex-direction: column; gap: 0.55rem; }
  button.opt {
    appearance: none; width: 100%; text-align: left; cursor: pointer;
    font: inherit; font-weight: 550; color: var(--ink);
    background: var(--card); border: 1.5px solid var(--line); border-radius: 10px;
    padding: 0.7rem 0.95rem; transition: border-color 120ms ease, background 120ms ease;
  }
  button.opt:hover, button.opt:focus-visible { border-color: var(--accent); outline: none; }
  button.opt:disabled { opacity: 0.55; cursor: default; }
  .options.done button.opt.picked { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--card)); }
  .status { font-size: 0.88rem; color: var(--muted); min-height: 1.3em; }
  .status.ok { color: var(--accent); font-weight: 550; }
  .app-link {
    text-align: center; font-weight: 600; text-decoration: none;
    color: var(--accent); border: 1.5px solid var(--accent); border-radius: 10px;
    padding: 0.6rem 0.95rem;
  }
  .hint { font-size: 0.8rem; color: var(--muted); }
</style>
</head>
<body>
<main class="card">
  <span class="brand">Omadia</span>
  ${main}
  ${appButton}
</main>
</body>
</html>`;
}

function openCard(entry: AnswerEntry, replyPath: string): string {
  const rationale = entry.choice.rationale
    ? `<p class="rationale">${escapeHtml(entry.choice.rationale)}</p>`
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
  <p class="status" id="status"></p>
  <p class="hint">Deine Auswahl wird in die iMessage-Unterhaltung übernommen — die Antwort kommt dort an.</p>
  <script>
    (function () {
      var replyPath = ${JSON.stringify(replyPath)};
      var box = document.getElementById('options');
      var status = document.getElementById('status');
      box.addEventListener('click', function (ev) {
        var btn = ev.target.closest('button.opt');
        if (!btn || btn.disabled) return;
        var buttons = box.querySelectorAll('button.opt');
        buttons.forEach(function (b) { b.disabled = true; });
        btn.classList.add('picked');
        status.textContent = 'Wird gesendet …';
        fetch(replyPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: btn.dataset.value })
        }).then(function (res) {
          if (res.status === 202) {
            box.classList.add('done');
            status.className = 'status ok';
            status.textContent = 'Übernommen — die Antwort kommt gleich per iMessage.';
            return;
          }
          return res.json().catch(function () { return {}; }).then(function (body) {
            status.textContent = res.status === 409
              ? 'Diese Frage wurde inzwischen schon beantwortet.'
              : res.status === 410
                ? 'Der Link ist inzwischen abgelaufen — antworte direkt in iMessage.'
                : 'Senden fehlgeschlagen (' + res.status + '). Antworte direkt in iMessage.';
            if (res.status !== 409 && res.status !== 410) {
              buttons.forEach(function (b) { b.disabled = false; });
              btn.classList.remove('picked');
            }
            void body;
          });
        }).catch(function () {
          status.textContent = 'Netzwerkfehler — bitte erneut versuchen.';
          buttons.forEach(function (b) { b.disabled = false; });
          btn.classList.remove('picked');
        });
      });
    })();
  </script>`;
}

function notice(title: string, text: string): string {
  return `<h1>${escapeHtml(title)}</h1>
  <p class="notice-text">${escapeHtml(text)}</p>`;
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
