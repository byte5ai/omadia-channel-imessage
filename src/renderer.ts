import {
  InMemorySpeakerHistoryStore,
  admitDecorations,
  renderPlainAnswer,
  type OutgoingAttachment,
  type OutgoingInteractive,
  type SemanticAnswer,
  type SpeakerHistoryStore,
} from '@omadia/channel-sdk';

/** The channel type the decoration registry knows this channel by. */
export const CHANNEL_TYPE = 'imessage';

/** The registry id of the choice affordance the answer link belongs to. */
export const ANSWER_LINK_DECORATION_ID = 'decision_card';

/** Decides which decorations the registry lets this channel render. */
export type DecorationGate = typeof admitDecorations;

export interface RenderOptions {
  /** Absolute answer-link URL for a choice card. Rendered only when the
   *  decoration registry declares the choice affordance for this channel
   *  ({@link ANSWER_LINK_DECORATION_ID}); the numbered text list stays the
   *  way to answer either way. */
  choiceLinkUrl?: string;
  /** Conversation key for the speaker history (name-line decision). */
  conversationKey?: string;
  /** Who spoke in which conversation. Defaults to a fresh, empty store. */
  speakerHistory?: SpeakerHistoryStore;
  /** Decoration gate; defaults to the SDK registry. Injectable for tests. */
  admit?: DecorationGate;
}

export interface RenderedAnswer {
  /** The ordered bubbles to send. */
  readonly bubbles: readonly string[];
  /** Ids of the registry decorations attached on top of the text. */
  readonly decorations: readonly string[];
}

/** True when the registry lets this channel render the answer-link affordance. */
export function isAnswerLinkAdmitted(admit: DecorationGate = admitDecorations): boolean {
  return admit(CHANNEL_TYPE, [{ id: ANSWER_LINK_DECORATION_ID }]).admitted.length > 0;
}

/**
 * Render the orchestrator's channel-agnostic {@link SemanticAnswer} into a
 * single iMessage text message.
 *
 * iMessage (via Sendblue) is PLAIN TEXT, so the answer is rendered by the SDK
 * reference renderer (`renderPlainAnswer`, spec 2042 §5.14): the answer text,
 * a plain name line only where INV-4 asks for one, colleagues' contributions
 * as "Mira: ...", a `system` notice as its own text, a card as numbered text.
 * No chips, footers, follow-up lists or disclaimers: those are not declared
 * decorations for this channel. The AI disclosure line is already part of
 * `answer.text` (the operator's `ai_disclosure_frequency`). Markdown in the
 * model-authored fields is degraded to plain text first.
 */
export function renderAnswer(a: SemanticAnswer, opts?: RenderOptions): string {
  return renderAnswerBubbles(a, opts).join('\n\n');
}

/**
 * Render into the ordered list of iMessage bubbles to send. Normally one
 * bubble; a choice card WITH an admitted answer link yields two: the text,
 * then the bare URL on its own. iMessage only unfurls a link into a preview
 * card when the message consists of nothing but the URL; embedded in text it
 * stays an inline link. The text bubble stays self-sufficient (options
 * listed), so a failed second send still leaves an answerable question.
 */
export function renderAnswerBubbles(a: SemanticAnswer, opts?: RenderOptions): string[] {
  return [...renderAnswerParts(a, opts).bubbles];
}

export function renderAnswerParts(a: SemanticAnswer, opts: RenderOptions = {}): RenderedAnswer {
  const admit = opts.admit ?? admitDecorations;
  const history = opts.speakerHistory ?? new InMemorySpeakerHistoryStore();
  const plain = renderPlainAnswer(plainTextAnswer(a), {
    nativeIdentity: false,
    conversationKey: opts.conversationKey ?? CHANNEL_TYPE,
    speakerHistory: history,
  });

  const isSystem = a.speaker?.kind === 'system';
  const parts: string[] = [];
  if (plain.length > 0) parts.push(plain);

  const links = isSystem ? undefined : renderAttachments(a.attachments);
  if (links) parts.push(links);

  const decorations: string[] = [];
  const hasChoice = !isSystem && a.interactive?.kind === 'choice';
  const linkUrl =
    hasChoice && opts.choiceLinkUrl && isAnswerLinkAdmitted(admit) ? opts.choiceLinkUrl : undefined;
  if (linkUrl) {
    // The URL itself follows as its own bubble.
    parts.push('Oder wähle hier aus:');
    decorations.push(ANSWER_LINK_DECORATION_ID);
  }

  const text = parts.join('\n\n');
  const bubbles = text.trim().length > 0 ? [text] : [];
  if (linkUrl) bubbles.push(linkUrl);
  return { bubbles, decorations };
}

/**
 * A copy of the answer whose model-authored text fields are plain text. The
 * SDK renderer lays the answer out; it does not know iMessage shows no markup.
 */
function plainTextAnswer(a: SemanticAnswer): SemanticAnswer {
  return {
    ...a,
    text: mdBlock(a.text),
    ...(a.contributions
      ? { contributions: a.contributions.map((c) => ({ ...c, text: mdBlock(c.text) })) }
      : {}),
    ...(a.systemNotice ? { systemNotice: { ...a.systemNotice, text: mdBlock(a.systemNotice.text) } } : {}),
    ...(a.interactive ? { interactive: plainInteractive(a.interactive) } : {}),
  };
}

function plainInteractive(interactive: OutgoingInteractive): OutgoingInteractive {
  switch (interactive.kind) {
    case 'choice':
      return {
        ...interactive,
        question: mdBlock(interactive.question),
        options: interactive.options.map((o) => ({ ...o, label: mdInline(o.label) })),
      };
    case 'topic':
      return {
        ...interactive,
        question: mdBlock(interactive.question),
        topics: interactive.topics.map((t) => ({ ...t, label: mdInline(t.label) })),
      };
    case 'slots':
      return { ...interactive, question: mdBlock(interactive.question) };
    default:
      return interactive;
  }
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

  // NUL is the shelter delimiter, so it must not occur in the input — a stray
  // one would make user text look like a placeholder to the restore pass.
  // CRLF is normalised here so every line-anchored rule below (fences,
  // headings, list markers) sees a bare \n; a trailing \r used to defeat the
  // closing-fence match and send the block back through the prose pipeline.
  let text = shelterFences(md.replace(/\x00/g, '').replace(/\r\n?/g, '\n'), stash)
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
    // [label](url) → label (url), ![alt](url) → alt (url); the url is
    // sheltered so the heading uppercasing below can never mangle a
    // case-sensitive path. Any target is accepted, not just http(s): a
    // `mailto:` or relative link that keeps its brackets is the raw syntax
    // leaking into the bubble, which is exactly what this pass exists to stop.
    .replace(/!?\[([^\]]*)\]\(([^\s)]+)\)/g, (_m, label: string, url: string) =>
      label.trim().length > 0 ? `${label} (${stash(url)})` : stash(url))
    // autolinks <https://…> / <mailto:…> → the bare target
    .replace(/<((?:[a-z][a-z0-9+.-]*):[^>\s]+)>/gi, (_m, url: string) => stash(url))
    // headings → UPPERCASE line set off by blank lines
    .replace(/^#{1,6}[ \t]+(.+)$/gm, (_m, h: string) => `\n${h.trim().toUpperCase()}\n`)
    // blockquotes (incl. nested) → » line. The separator is [ \t], never \s:
    // \s matches the newline, so a bare `>` line used to swallow the line
    // after it and silently merge two quoted paragraphs into one.
    .replace(/^(?:>[ \t]?)+/gm, '» ')
    // unordered list markers → •
    .replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ')
    // collapse the blank-line padding introduced above
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '');

  // Restore repeatedly: shelters nest (an escaped backtick is stashed BEFORE
  // the code-span rule, so its placeholder ends up inside the span's stashed
  // content). A single pass does not rescan the text it just inserted, which
  // used to leak the raw NUL delimiters of the inner placeholder into the
  // outgoing message. Depth is bounded by construction; the cap is a guard
  // against a pathological input rather than an expected case.
  let out = text;
  for (let pass = 0; pass < 10 && out.includes('\x00'); pass += 1) {
    out = out.replace(/\x00(\d+)\x00/g, (_m, i: string) => sheltered[Number(i)] ?? '');
  }
  // Any delimiter still standing belongs to no known shelter — drop it rather
  // than ship a control character.
  return out.replace(/\x00/g, '');
}

/**
 * Fenced code blocks per CommonMark, line-based: the opening fence is a line
 * of >=3 backticks OR >=3 tildes plus an optional info string; the closing
 * fence is a line holding ONLY >= that many of the SAME character. Anything
 * else is content — a ```lang line inside an open block (models nest fences
 * when they "show markdown"), or ``` inline in prose ("Code-Blöcke (```)").
 * The body is sheltered verbatim, both fence lines are dropped.
 *
 * Container awareness, without a container parser: a fence may be introduced
 * by a blockquote prefix (`> `) and/or arbitrary indentation (a fence nested
 * in a list item sits well past the 3-space limit a top-level fence has). The
 * opener's prefix is recorded and stripped from the body and the closer, so a
 * quoted or list-nested block is sheltered instead of being run through the
 * prose pipeline — which used to silently rewrite the code it contained.
 * Indentation is therefore NOT treated as an indented code block here; in a
 * bubble the two degrade to the same thing (verbatim text) anyway.
 *
 * An unclosed fence is deliberately NOT CommonMark (which would swallow the
 * rest of the document as code): the fence line is dropped and the rest stays
 * prose. A bubble is not a document, and models regularly leave one open. If
 * the info string is separated from the marker by a space it is kept as prose
 * — that shape is a sentence continuing after an inline ``` mention, not a
 * language tag, and dropping the whole line used to eat the sentence.
 */
function shelterFences(md: string, stash: (content: string) => string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const open = /^([ \t]*(?:>[ \t]?)*[ \t]*)((`{3,})|(~{3,}))(.*)$/.exec(line);
    const marker = open?.[2] ?? '';
    const info = open?.[5] ?? '';
    // A backtick fence's info string may not contain a backtick (CommonMark);
    // without that rule `` ``` `x` `` `` in prose would open a block.
    if (!open || (marker.startsWith('`') && info.includes('`'))) {
      out.push(line);
      i += 1;
      continue;
    }
    const prefix = open[1] ?? '';
    const quoteDepth = (prefix.match(/>/g) ?? []).length;
    const indent = prefix.replace(/>[ \t]?/g, '').length;
    const strip = (l: string): string => stripContainerPrefix(l, quoteDepth, indent);
    const closer = new RegExp(`^${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \t]*$`);

    let j = i + 1;
    while (j < lines.length && !closer.test(strip(lines[j] ?? ''))) j += 1;
    if (j >= lines.length) {
      // unclosed: drop the fence marker; keep a space-separated info string,
      // which is prose rather than a language tag
      if (/^[ \t]/.test(info) && info.trim().length > 0) out.push(info.trim());
      i += 1;
      continue;
    }
    out.push(stash(lines.slice(i + 1, j).map(strip).join('\n')));
    i = j + 1;
  }
  return out.join('\n');
}

/** Remove up to `quoteDepth` blockquote markers and then up to `indent`
 *  columns of leading whitespace — the opener's container prefix. */
function stripContainerPrefix(line: string, quoteDepth: number, indent: number): string {
  let rest = line;
  for (let q = 0; q < quoteDepth; q += 1) {
    const m = /^[ \t]*>[ \t]?/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  let removed = 0;
  while (removed < indent && (rest.startsWith(' ') || rest.startsWith('\t'))) {
    rest = rest.slice(1);
    removed += 1;
  }
  return rest;
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
  // GFM requires only ONE dash per delimiter cell (optionally colon-anchored).
  // Demanding three rejected `| - | - |` and `| :- | -: |`, and a rejected
  // delimiter row means the whole table leaks into the bubble as raw pipes.
  return cells.every((c) => /^:?-+:?$/.test(c.trim()));
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
    return t.rows
      .map((r) => {
        const key = cell(r, 0);
        const value = cell(r, 1);
        return value ? `${key}: ${value}` : key;
      })
      .join('\n');
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
    // Bound by colCount, not header.length: a ragged row with more cells than
    // the header declares used to have its surplus cells silently dropped.
    // Such a cell has no column name, so it is emitted as a bare value.
    for (let c = fieldStartCol; c < colCount; c++) {
      const name = (t.header[c] ?? '').trim();
      const value = cell(row, c);
      if (!value) continue;
      fieldLines.push(name ? `  ${name}: ${value}` : `  ${value}`);
    }
    blocks.push(
      `${headingPrefix}${headingValue}${fieldLines.length > 0 ? `\n${fieldLines.join('\n')}` : ''}`,
    );
  }
  return blocks.join('\n\n');
}

/**
 * Degrade a value that has to stay on ONE line (an option label, an
 * attachment's alt text, a follow-up prompt). The full pipeline can introduce
 * line breaks — a heading is set off by blank lines, a list marker becomes its
 * own `•` line — which would break the caller's own bullet layout, so the
 * result is flattened back to a single line.
 */
function mdInline(value: string): string {
  return mdBlock(value).replace(/\s+/g, ' ').trim();
}

/**
 * Degrade a multi-line prose field (question, rationale, disclaimer).
 *
 * Non-string input is tolerated rather than thrown on: these fields cross the
 * plugin boundary from model output, and a renderer that throws aborts the
 * whole turn and sends the user a generic error instead of the answer.
 */
function mdBlock(value: string | undefined | null): string {
  return typeof value === 'string' ? mdToPlainText(value).trim() : '';
}

function renderAttachments(items: OutgoingAttachment[] | undefined): string | undefined {
  const lines: string[] = [];
  for (const a of items ?? []) {
    const icon = a.kind === 'image' ? '🖼' : '📎';
    lines.push(`${icon} ${mdInline(a.altText)}: ${a.url}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}
