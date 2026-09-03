import type {
  FollowUpOption,
  OutgoingAttachment,
  OutgoingChoiceCard,
  SemanticAnswer,
} from '@omadia/channel-sdk';

export interface RenderOptions {
  /** Absolute answer-link URL for a choice card. When set, the rendered
   *  choice invites a tap on the link (native/web selection UI) while the
   *  text options stay listed — replying by text always keeps working. */
  choiceLinkUrl?: string;
}

/**
 * Render the orchestrator's channel-agnostic {@link SemanticAnswer} into a
 * single iMessage text message.
 *
 * iMessage (via Sendblue) is PLAIN TEXT — no markdown, no `*bold*`
 * convention, no inline keyboards. Every richer element degrades to text: a
 * choice card becomes a "reply with one of these" list, follow-ups become
 * copyable suggestions, and attachments become links. This matches the SDK's
 * documented graceful-degradation contract for connectors without rich UI.
 * A choice card can additionally carry an answer link (deep-link concept
 * Phase 1) — see {@link RenderOptions.choiceLinkUrl}.
 */
export function renderAnswer(a: SemanticAnswer, opts?: RenderOptions): string {
  return renderAnswerBubbles(a, opts).join('\n\n');
}

/**
 * Render into the ordered list of iMessage bubbles to send. Normally one
 * bubble; a choice card WITH an answer link yields two — the text, then the
 * bare URL on its own. iMessage only unfurls a link into a preview card when
 * the message consists of nothing but the URL; embedded in text it stays an
 * inline link. The text bubble stays self-sufficient (options listed), so a
 * failed second send still leaves an answerable question.
 */
export function renderAnswerBubbles(a: SemanticAnswer, opts?: RenderOptions): string[] {
  const parts: string[] = [];

  const body = mdToPlainText(a.text).trim();
  if (body) parts.push(body);

  const linkUrl = a.interactive?.kind === 'choice' ? opts?.choiceLinkUrl : undefined;
  if (a.interactive?.kind === 'choice') {
    parts.push(renderChoice(a.interactive, Boolean(linkUrl)));
  }

  const links = renderAttachments(a.attachments);
  if (links) parts.push(links);

  if (a.followUps && a.followUps.length > 0) {
    parts.push(renderFollowUps(a.followUps));
  }

  if (a.disclaimer) parts.push(a.disclaimer);

  const text = parts.join('\n\n');
  const bubbles = text.trim().length > 0 ? [text] : [];
  if (linkUrl) bubbles.push(linkUrl);
  return bubbles;
}

/**
 * Best-effort Markdown → plain text. iMessage renders no markup at all, so
 * every construct degrades to its best plain-text shape instead of leaking
 * raw markdown syntax: emphasis/code markers are stripped (not converted),
 * links become `label (url)`, headings become UPPERCASE lines set off by
 * blank lines (whitespace is the only layout tool a bubble has), blockquotes
 * become `» ` lines, list markers become `•` (task checkboxes dropped, done
 * items keep a ✓), thematic breaks (`---`) become
 * a blank line, backslash escapes resolve to their literal character, and
 * GFM tables are flipped to per-row key/value stacks (the mobile-friendly
 * pattern the Telegram channel uses — a monospace grid is impossible without
 * monospace).
 */
export function mdToPlainText(md: string): string {
  // Shelter code from every transform below: fenced blocks and inline code
  // keep their content VERBATIM (fences/backticks dropped), so an asterisk
  // or pipe inside code is never mistaken for markup.
  const sheltered: string[] = [];
  const stash = (content: string): string => `\x00${sheltered.push(content) - 1}\x00`;

  let text = shelterFences(md, stash)
    // GFM task items: the checkbox after a list marker is dropped (`• [ ]`
    // is noise in a bubble); a checked box keeps a ✓ so done-state survives.
    // Models often wrap the box in backticks (`- \`[x]\` Kisten`), so a code
    // span holding exactly the box counts too — hence this runs BEFORE the
    // inline-code shelter. A bare `[ ]` without list marker is prose and stays.
    .replace(/^(\s*(?:[-*+]|\d+[.)])\s+)(`?)\[( |[xX])\]\2\s+/gm, (_m, lead: string, _tick: string, mark: string) =>
      mark === ' ' ? lead : `${lead}✓ `)
    // \` → literal backtick; sheltered BEFORE code-span detection so an
    // escaped backtick can never open a span (CommonMark: escapes win)
    .replace(/\\`/g, () => stash('`'))
    // code spans per CommonMark: a run of n backticks closes with a run of
    // exactly n, so `` `Text` `` yields `Text` with the inner backticks kept.
    // One leading AND trailing space is stripped (the padding convention).
    .replace(/(`+)([^\n]*?[^`\n])\1(?!`)/g, (_m, _ticks: string, code: string) =>
      stash(/^ .* $/.test(code) ? code.slice(1, -1) : code))
    // remaining backslash escapes (\* \_ \# …) → the literal character,
    // sheltered so the emphasis/heading transforms below never see it
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (_m, ch: string) => stash(ch));

  // GFM tables → per-row key/value stacks (before emphasis stripping, so
  // cell contents get the same cleanup afterwards).
  text = renderTables(text);

  // Emphasis may span lines but never a blank line (a paragraph boundary),
  // and the markers must hug non-space so prose math (`2 * 3`) survives.
  const emphasis = (open: string, close = open, inner = '[\\s\\S]'): RegExp =>
    new RegExp(`${open}((?=\\S)(?:(?!\\n\\n)${inner})+?(?<=\\S))${close}`, 'g');

  text = text
    // thematic break (--- / *** / ___, optionally spaced) → blank line; must
    // run before list markers (`- - -`) and emphasis (`*****`) see it
    .replace(/^ {0,3}([-*_])(?: *\1){2,} *$/gm, '')
    // **bold** / __bold__ / ~~strike~~ → bare text
    .replace(emphasis('\\*\\*'), '$1')
    .replace(emphasis('__'), '$1')
    .replace(emphasis('~~'), '$1')
    // *italic*
    .replace(emphasis('\\*', '\\*', '[^*]'), '$1')
    // _italic_ — word-internal underscores (snake_case) survive
    .replace(emphasis('(?<![\\w_])_', '_(?![\\w_])', '[^_]'), '$1')
    // [label](url) → label (url); the url is sheltered so the heading
    // uppercasing below can never mangle a case-sensitive path
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => `${label} (${stash(url)})`)
    // headings → UPPERCASE line set off by blank lines
    .replace(/^#{1,6}\s+(.+)$/gm, (_m, h: string) => `\n${h.trim().toUpperCase()}\n`)
    // blockquotes (incl. nested) → » line
    .replace(/^(?:>\s?)+/gm, '» ')
    // unordered list markers → •
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    // collapse the blank-line padding introduced above
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '');

  return text.replace(/\x00(\d+)\x00/g, (_m, i: string) => sheltered[Number(i)] ?? '');
}

/**
 * Fenced code blocks per CommonMark, line-based: the opening fence is a line
 * of >=3 backticks (up to 3 spaces indent) plus an optional info string; the
 * closing fence is a line holding ONLY >= that many backticks. Anything else
 * is content — a ```lang line inside an open block (models nest fences when
 * they "show markdown"), or ``` inline in prose ("Code-Blöcke (```)"). The
 * body is sheltered verbatim, both fence lines are dropped.
 *
 * An unclosed fence is deliberately NOT CommonMark (which would swallow the
 * rest of the document as code): the fence line is dropped and the rest stays
 * prose. A bubble is not a document, and models regularly leave one open.
 */
function shelterFences(md: string, stash: (content: string) => string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const open = /^ {0,3}(`{3,})([^`]*)$/.exec(line);
    if (!open) {
      out.push(line);
      i += 1;
      continue;
    }
    const closer = new RegExp(`^ {0,3}\`{${open[1]?.length ?? 3},} *$`);
    let j = i + 1;
    while (j < lines.length && !closer.test(lines[j] ?? '')) j += 1;
    if (j >= lines.length) {
      // unclosed: drop the fence line, keep scanning the rest as prose
      i += 1;
      continue;
    }
    out.push(stash(lines.slice(i + 1, j).join('\n')));
    i = j + 1;
  }
  return out.join('\n');
}

interface ParsedTable {
  header: string[];
  rows: string[][];
}

/** Replace every GFM pipe table in `text` with its plain-text stack form. */
function renderTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const tbl = tryParseTableAt(lines, i);
    if (tbl) {
      out.push(formatTable(tbl.parsed));
      i = tbl.nextIndex;
      continue;
    }
    out.push(lines[i] ?? '');
    i += 1;
  }
  return out.join('\n');
}

function tryParseTableAt(
  lines: string[],
  startIndex: number,
): { parsed: ParsedTable; nextIndex: number } | null {
  const headerLine = lines[startIndex];
  const sepLine = lines[startIndex + 1];
  if (!headerLine || !sepLine) return null;
  if (!isTableRow(headerLine) || !isTableSeparator(sepLine)) return null;

  const header = splitTableCells(headerLine);
  const rows: string[][] = [];
  let cursor = startIndex + 2;
  while (cursor < lines.length && isTableRow(lines[cursor] ?? '')) {
    rows.push(splitTableCells(lines[cursor] ?? ''));
    cursor += 1;
  }
  if (rows.length === 0) return null;
  return { parsed: { header, rows }, nextIndex: cursor };
}

function isTableRow(line: string): boolean {
  // Must start AND end with `|` (CommonMark requires the pipes; the looser
  // pipe-separated-without-borders variant false-positives on prose).
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length >= 3;
}

function isTableSeparator(line: string): boolean {
  if (!isTableRow(line)) return false;
  const cells = splitTableCells(line);
  return cells.every((c) => /^:?-{3,}:?$/.test(c.trim()));
}

function splitTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * Mobile-friendly vertical rendering: an iPhone bubble is narrow and
 * proportional, so a column grid is unreadable. Two-column tables become
 * compact `key: value` lines; wider tables become one block per row with
 * the first column (or an "{n}." index) as the row heading and the
 * remaining columns as indented `name: value` fields.
 */
function formatTable(t: ParsedTable): string {
  const colCount = Math.max(t.header.length, ...t.rows.map((r) => r.length));
  const cell = (row: string[] | undefined, i: number): string => (row?.[i] ?? '').trim();

  // 2-column compact path: "key: value" lines (typical for report tables).
  if (colCount === 2) {
    return t.rows.map((r) => `${cell(r, 0)}: ${cell(r, 1)}`).join('\n');
  }

  // Detect leading row-index column ("#", "Nr.", or blank header + 1/2/3
  // body values). When detected, the row heading is "{n}. {col2}".
  const firstHeader = (t.header[0] ?? '').trim().toLowerCase();
  const firstColIsIndex =
    (firstHeader === '#' || firstHeader === 'nr' || firstHeader === 'nr.' || firstHeader === '') &&
    t.rows.every((r, i) => {
      const v = cell(r, 0);
      return /^\d+$/.test(v) && Number(v) === i + 1;
    });

  const headingCol = firstColIsIndex ? 1 : 0;
  const fieldStartCol = headingCol + 1;

  const blocks: string[] = [];
  for (let rowIdx = 0; rowIdx < t.rows.length; rowIdx++) {
    const row = t.rows[rowIdx];
    const headingValue = cell(row, headingCol) || '—';
    const headingPrefix = firstColIsIndex ? `${String(rowIdx + 1)}. ` : '';
    const fieldLines: string[] = [];
    for (let c = fieldStartCol; c < t.header.length; c++) {
      const name = (t.header[c] ?? '').trim();
      const value = cell(row, c);
      if (!value) continue;
      fieldLines.push(`  ${name}: ${value}`);
    }
    blocks.push(
      `${headingPrefix}${headingValue}${fieldLines.length > 0 ? `\n${fieldLines.join('\n')}` : ''}`,
    );
  }
  return blocks.join('\n\n');
}

function renderChoice(choice: OutgoingChoiceCard, hasLink: boolean): string {
  const lines = [choice.question];
  if (choice.rationale) lines.push(choice.rationale);
  for (const opt of choice.options) lines.push(`• ${opt.label}`);
  if (hasLink) {
    // The URL itself follows as its own bubble (see renderAnswerBubbles).
    lines.push('Antworte mit einer der Optionen — oder wähle hier aus:');
  } else {
    lines.push('Bitte antworte mit einer der Optionen.');
  }
  return lines.join('\n');
}

function renderFollowUps(followUps: FollowUpOption[]): string {
  const lines = ['💡 Du kannst auch fragen:'];
  for (const f of followUps.slice(0, 5)) lines.push(`• ${f.prompt}`);
  return lines.join('\n');
}

function renderAttachments(items: OutgoingAttachment[] | undefined): string | undefined {
  const lines: string[] = [];
  for (const a of items ?? []) {
    const icon = a.kind === 'image' ? '🖼' : '📎';
    lines.push(`${icon} ${a.altText}: ${a.url}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}
