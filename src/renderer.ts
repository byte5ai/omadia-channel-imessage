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
  const parts: string[] = [];

  const body = mdToPlainText(a.text).trim();
  if (body) parts.push(body);

  if (a.interactive?.kind === 'choice') {
    parts.push(renderChoice(a.interactive, opts?.choiceLinkUrl));
  }

  const links = renderAttachments(a.attachments);
  if (links) parts.push(links);

  if (a.followUps && a.followUps.length > 0) {
    parts.push(renderFollowUps(a.followUps));
  }

  if (a.disclaimer) parts.push(a.disclaimer);

  return parts.join('\n\n');
}

/**
 * Best-effort Markdown → plain text. iMessage renders no markup at all, so
 * every construct degrades to its best plain-text shape instead of leaking
 * raw markdown syntax: emphasis/code markers are stripped (not converted),
 * links become `label (url)`, headings become UPPERCASE lines set off by
 * blank lines (whitespace is the only layout tool a bubble has), blockquotes
 * become `» ` lines, list markers become `•`, and GFM tables are flipped to
 * per-row key/value stacks (the mobile-friendly pattern the Telegram channel
 * uses — a monospace grid is impossible without monospace).
 */
export function mdToPlainText(md: string): string {
  // Shelter code from every transform below: fenced blocks and inline code
  // keep their content VERBATIM (fences/backticks dropped), so an asterisk
  // or pipe inside code is never mistaken for markup.
  const sheltered: string[] = [];
  const stash = (content: string): string => `\x00${sheltered.push(content) - 1}\x00`;

  let text = md
    // fenced code blocks: keep the body, drop the fences (incl. language tag)
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => stash(code.replace(/\n$/, '')))
    // unmatched leftover fence line (truncated block): drop the fence line
    .replace(/^```[^\n]*\n?/gm, '')
    // `inline code` → inline code
    .replace(/`([^`\n]+)`/g, (_m, code: string) => stash(code));

  // GFM tables → per-row key/value stacks (before emphasis stripping, so
  // cell contents get the same cleanup afterwards).
  text = renderTables(text);

  text = text
    // **bold** / __bold__ / ~~strike~~ → bare text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    // *italic* — asterisks must hug non-space so prose math (`2 * 3`) survives
    .replace(/\*(\S(?:[^*\n]*\S)?)\*/g, '$1')
    // _italic_ — word-internal underscores (snake_case) survive
    .replace(/(?<![\w_])_(\S(?:[^_\n]*\S)?)_(?![\w_])/g, '$1')
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

function renderChoice(choice: OutgoingChoiceCard, linkUrl?: string): string {
  const lines = [choice.question];
  if (choice.rationale) lines.push(choice.rationale);
  for (const opt of choice.options) lines.push(`• ${opt.label}`);
  if (linkUrl) {
    lines.push('Antworte mit einer der Optionen — oder wähle hier aus:');
    lines.push(linkUrl);
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
