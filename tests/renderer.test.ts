import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { SemanticAnswer } from '@omadia/channel-sdk';

import { mdToPlainText, renderAnswer, renderAnswerBubbles } from '../src/renderer.js';

// Acceptance criterion (#410): headings, tables, bullets, links, code render
// per spec with NO raw markdown leakage in the resulting iMessage text.

describe('mdToPlainText — emphasis and inline markup', () => {
  it('strips bold, italic and strikethrough markers', () => {
    assert.equal(mdToPlainText('**fett** und __auch__ und *kursiv* und _leise_ und ~~weg~~'),
      'fett und auch und kursiv und leise und weg');
  });

  it('keeps prose asterisk math and snake_case untouched', () => {
    assert.equal(mdToPlainText('2 * 3 = 6 bleibt, some_var_name auch'),
      '2 * 3 = 6 bleibt, some_var_name auch');
  });

  it('converts [label](url) links to "label (url)" and preserves url casing', () => {
    assert.equal(
      mdToPlainText('Siehe [Docs](https://example.com/API/CaseSensitive)'),
      'Siehe Docs (https://example.com/API/CaseSensitive)',
    );
  });
});

describe('mdToPlainText — headings, quotes, lists', () => {
  it('uppercases headings and sets them off with blank lines', () => {
    const out = mdToPlainText('# Titel\nBody\n## Unterpunkt\nMehr');
    assert.ok(out.includes('TITEL\n\nBody'));
    assert.ok(out.includes('UNTERPUNKT\n\nMehr'));
    assert.ok(!out.includes('#'));
  });

  it('turns blockquotes into » lines and list markers into bullets', () => {
    const out = mdToPlainText('> Zitat\n\n- eins\n* zwei\n+ drei\n  - eingerückt');
    assert.ok(out.includes('» Zitat'));
    assert.ok(out.includes('• eins'));
    assert.ok(out.includes('• zwei'));
    assert.ok(out.includes('• drei'));
    assert.ok(out.includes('  • eingerückt'));
  });

  it('drops the checkbox of task items but keeps a bare [ ] in prose', () => {
    assert.equal(
      mdToPlainText('- [ ] Test ToDo\n* [ ] zwei\n  - [ ] eingerückt\n1. [ ] nummeriert'),
      '• Test ToDo\n• zwei\n  • eingerückt\n1. nummeriert',
    );
    assert.equal(mdToPlainText('- [x] erledigt\n- [X] auch'), '• ✓ erledigt\n• ✓ auch');
    assert.equal(mdToPlainText('[ ] Test ToDo'), '[ ] Test ToDo');
    assert.equal(mdToPlainText('Siehe [ ] im Text'), 'Siehe [ ] im Text');
  });

  it('treats a code span holding just the checkbox as a task item (observed model output)', () => {
    // Raw answer seen on device: the model wrapped every box in backticks.
    assert.equal(
      mdToPlainText('- `[x]` Umzugsunternehmen buchen\n- `[ ]` Kisten packen\n1. `[ ]` Adresse melden'),
      '• ✓ Umzugsunternehmen buchen\n• Kisten packen\n1. Adresse melden',
    );
    // Not a task item: box in code but no list marker, or code holding more than the box.
    assert.equal(mdToPlainText('`[ ] Test ToDo`'), '[ ] Test ToDo');
    assert.equal(mdToPlainText('- `- [ ]` Syntax-Demo'), '• - [ ] Syntax-Demo');
  });
});

describe('mdToPlainText — code shelter', () => {
  it('keeps fenced code verbatim and drops the fences', () => {
    const out = mdToPlainText('Vorher\n```ts\nconst a = "**nicht fett**" | b;\n```\nNachher');
    assert.ok(out.includes('const a = "**nicht fett**" | b;'));
    assert.ok(!out.includes('```'));
  });

  it('keeps inline code verbatim (markup inside is not transformed)', () => {
    const out = mdToPlainText('Nutze `--flag *glob*` dafür');
    assert.equal(out, 'Nutze --flag *glob* dafür');
  });

  it('handles multi-backtick code spans (CommonMark) and strips the space padding', () => {
    // Observed on device: the model wrote `` `Text` `` to show a backtick
    // literally; the old single-backtick regex left stray ticks behind.
    assert.equal(mdToPlainText('Code: `` `Text` ``'), 'Code: `Text`');
    assert.equal(mdToPlainText('Code: `` ` Text ` ``'), 'Code: ` Text `');
    assert.equal(mdToPlainText('` `'), ' ');
  });

  it('keeps backslash escapes inside code verbatim', () => {
    assert.equal(mdToPlainText('`a\\*b` bleibt'), 'a\\*b bleibt');
  });

  it('leaves markdown syntax that the model shows in inline code literal', () => {
    const out = mdToPlainText('- Fett: `**Text**` oder `__Text__`\n- Kursiv: `*Text*` oder `_Text_`');
    assert.equal(out, '• Fett: **Text** oder __Text__\n• Kursiv: *Text* oder _Text_');
  });
});

describe('mdToPlainText — escapes, thematic breaks, multi-line emphasis', () => {
  it('resolves backslash escapes to the literal character', () => {
    assert.equal(mdToPlainText('Fett: \\*\\*Text\\*\\*'), 'Fett: **Text**');
    assert.equal(mdToPlainText('Preis \\$5 und \\# kein Heading'), 'Preis $5 und # kein Heading');
    assert.equal(mdToPlainText('\\`kein code\\`'), '`kein code`');
  });

  it('turns thematic breaks into a blank line (before list/emphasis handling)', () => {
    assert.equal(mdToPlainText('Text\n\n---\n\nMehr'), 'Text\n\nMehr');
    assert.equal(mdToPlainText('Text\n\n* * *\n\nMehr'), 'Text\n\nMehr');
    assert.equal(mdToPlainText('Text\n\n___\n\nMehr'), 'Text\n\nMehr');
    assert.ok(!mdToPlainText('- - -\nx').includes('•'));
  });

  it('strips emphasis that wraps across a line break but not across a blank line', () => {
    assert.equal(mdToPlainText('Zeile mit **fett\nüber Zeilen** hinweg'), 'Zeile mit fett\nüber Zeilen hinweg');
    assert.equal(mdToPlainText('Absatz **offen\n\nneu** hier'), 'Absatz **offen\n\nneu** hier');
    assert.equal(mdToPlainText('a ** b ** c'), 'a ** b ** c');
  });
});

describe('mdToPlainText — GFM tables', () => {
  it('renders a 2-column table as key: value lines', () => {
    const md = ['| Feld | Wert |', '| --- | --- |', '| Name | Ada |', '| Rolle | Admin |'].join(
      '\n',
    );
    assert.equal(mdToPlainText(md), 'Name: Ada\nRolle: Admin');
  });

  it('renders a wider table as one block per row with field lines', () => {
    const md = [
      '| Produkt | Preis | Lager |',
      '| --- | --- | --- |',
      '| Stuhl | 49€ | 12 |',
      '| Tisch | 149€ | 3 |',
    ].join('\n');
    const out = mdToPlainText(md);
    assert.ok(out.includes('Stuhl\n  Preis: 49€\n  Lager: 12'));
    assert.ok(out.includes('Tisch\n  Preis: 149€\n  Lager: 3'));
    assert.ok(!out.includes('|'));
  });

  it('detects a leading index column and numbers the row headings', () => {
    const md = [
      '| # | Name | Punkte |',
      '| --- | --- | --- |',
      '| 1 | Ada | 10 |',
      '| 2 | Grace | 9 |',
    ].join('\n');
    const out = mdToPlainText(md);
    assert.ok(out.includes('1. Ada\n  Punkte: 10'));
    assert.ok(out.includes('2. Grace\n  Punkte: 9'));
  });

  it('leaves pipe-looking prose that is not a table alone', () => {
    const line = 'a | b | c ohne Tabellenrahmen';
    assert.equal(mdToPlainText(line), line);
  });
});

const answer = (over: Partial<SemanticAnswer>): SemanticAnswer =>
  ({ text: 'Hallo.', ...over }) as SemanticAnswer;

describe('renderAnswer — SemanticAnswer degradation', () => {
  it('renders a choice card as an option list with the reply invitation', () => {
    const out = renderAnswer(
      answer({
        interactive: {
          kind: 'choice',
          question: 'Welcher Slot?',
          rationale: 'Beide sind frei.',
          options: [
            { label: 'Di 10:00', value: 'a' },
            { label: 'Mi 14:30', value: 'b' },
          ],
        },
      }),
    );
    assert.ok(out.includes('Welcher Slot?'));
    assert.ok(out.includes('Beide sind frei.'));
    assert.ok(out.includes('• Di 10:00'));
    assert.ok(out.includes('• Mi 14:30'));
    assert.ok(out.includes('Bitte antworte mit einer der Optionen.'));
  });

  it('appends the answer link when choiceLinkUrl is set', () => {
    const url = 'https://omadia.example.com/api/imessage/a/tok123';
    const out = renderAnswer(
      answer({
        interactive: {
          kind: 'choice',
          question: 'Welcher Slot?',
          options: [{ label: 'Di', value: 'a' }],
        },
      }),
      { choiceLinkUrl: url },
    );
    assert.ok(out.includes('oder wähle hier aus:'));
    assert.ok(out.includes(url));
    assert.ok(!out.includes('Bitte antworte mit einer der Optionen.'));
  });

  it('splits a linked choice into a text bubble and a bare-URL bubble', () => {
    const url = 'https://omadia.example.com/api/imessage/a/tok123';
    const bubbles = renderAnswerBubbles(
      answer({
        interactive: {
          kind: 'choice',
          question: 'Welcher Slot?',
          options: [{ label: 'Di', value: 'a' }],
        },
      }),
      { choiceLinkUrl: url },
    );
    assert.equal(bubbles.length, 2);
    // Text bubble is self-sufficient and carries no URL — the preview card
    // only renders when the URL is the whole message.
    assert.ok(bubbles[0]!.includes('• Di'));
    assert.ok(bubbles[0]!.includes('oder wähle hier aus:'));
    assert.ok(!bubbles[0]!.includes('http'));
    assert.equal(bubbles[1], url);
  });

  it('yields a single bubble without a link, and none for an empty answer', () => {
    const one = renderAnswerBubbles(
      answer({
        interactive: { kind: 'choice', question: 'Q?', options: [{ label: 'A', value: 'a' }] },
      }),
    );
    assert.equal(one.length, 1);
    assert.ok(one[0]!.includes('Bitte antworte mit einer der Optionen.'));
    // choiceLinkUrl without a choice card is ignored — no stray URL bubble.
    assert.deepEqual(renderAnswerBubbles(answer({ text: 'Nur Text.' }), { choiceLinkUrl: 'https://x' }), [
      'Nur Text.',
    ]);
    assert.deepEqual(renderAnswerBubbles(answer({ text: '   ' })), []);
  });

  it('renders follow-ups (max 5) and the disclaimer', () => {
    const out = renderAnswer(
      answer({
        followUps: Array.from({ length: 7 }, (_, i) => ({ prompt: `Frage ${i + 1}` })),
        disclaimer: 'Keine Rechtsberatung.',
      }),
    );
    assert.ok(out.includes('💡 Du kannst auch fragen:'));
    assert.ok(out.includes('• Frage 5'));
    assert.ok(!out.includes('• Frage 6'));
    assert.ok(out.endsWith('Keine Rechtsberatung.'));
  });

  it('renders attachments as icon link lines', () => {
    const out = renderAnswer(
      answer({
        attachments: [
          { kind: 'image', url: 'https://x/img.png', altText: 'Diagramm' },
          { kind: 'file', url: 'https://x/report.pdf', altText: 'Report' },
        ],
      }),
    );
    assert.ok(out.includes('🖼 Diagramm: https://x/img.png'));
    assert.ok(out.includes('📎 Report: https://x/report.pdf'));
  });

  it('produces no raw markdown for a markdown-heavy answer', () => {
    const out = renderAnswer(
      answer({
        text: [
          '# Ergebnis',
          'Das ist **wichtig** — siehe [Link](https://example.com/a).',
          '',
          '| Feld | Wert |',
          '| --- | --- |',
          '| A | 1 |',
          '',
          '> Merke dir das.',
          '- Punkt eins',
        ].join('\n'),
      }),
    );
    for (const leak of ['**', '](', '# ', '| ---']) {
      assert.ok(!out.includes(leak), `raw markdown leaked: ${leak}`);
    }
    assert.ok(out.includes('ERGEBNIS'));
    assert.ok(out.includes('A: 1'));
    assert.ok(out.includes('» Merke dir das.'));
    assert.ok(out.includes('• Punkt eins'));
  });
});
