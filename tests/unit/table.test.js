const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  charWidth,
  renderImportTable,
  renderStatusTable,
  renderTable,
  sanitize,
  truncate,
  visibleWidth,
} = require('../../src/cli/table.js');
const { stripAnsi } = require('../../src/utils/colors.js');

const lineWidths = (table) => table.split('\n').map((line) => stripAnsi(line).length);

describe('renderTable', () => {
  it('should size columns to the widest cell and align every line', () => {
    const table = renderTable(
      ['A', 'Long header'],
      [
        ['short', 'x'],
        ['a-much-longer-cell', 'y'],
      ],
    );
    const widths = lineWidths(table);
    assert.strictEqual(new Set(widths).size, 1);
    assert.ok(table.includes('a-much-longer-cell'));
    assert.ok(table.includes('Long header'));
  });

  it('should draw box borders around head and rows', () => {
    const table = renderTable(['H'], [['v']]);
    const lines = table.split('\n');
    assert.strictEqual(lines.length, 5);
    assert.ok(lines[0].startsWith('┌') && lines[0].endsWith('┐'));
    assert.ok(lines[2].startsWith('├') && lines[2].endsWith('┤'));
    assert.ok(lines[4].startsWith('└') && lines[4].endsWith('┘'));
    assert.ok(lines[1].includes('H') && lines[3].includes('v'));
  });

  it('should not let ANSI codes in a cell inflate its column', () => {
    const colored = '\x1b[32mok\x1b[39m';
    const table = renderTable(['A', 'B'], [[colored, 'plain']]);
    const widths = lineWidths(table);
    assert.strictEqual(new Set(widths).size, 1);
  });

  it('should render empty cells', () => {
    const table = renderTable(['A', 'B'], [['', 'x']]);
    const widths = lineWidths(table);
    assert.strictEqual(new Set(widths).size, 1);
  });
});

describe('renderStatusTable', () => {
  it('should render one aligned row per migration', () => {
    const table = renderStatusTable([
      {
        file: '20240101120000_init.js',
        status: 'applied',
        batch: 1,
        appliedAt: new Date('2024-01-01T12:00:00Z'),
        duration: 12,
        checksumOk: true,
      },
      {
        file: '20240102120000_seed.js',
        status: 'pending',
        batch: null,
        appliedAt: null,
        duration: null,
        checksumOk: null,
      },
    ]);
    const plain = stripAnsi(table);
    assert.ok(plain.includes('Migration'));
    assert.ok(plain.includes('applied'));
    assert.ok(plain.includes('pending'));
    assert.ok(plain.includes('12ms'));
    assert.ok(plain.includes('—'));
    assert.strictEqual(new Set(lineWidths(table)).size, 1);
  });
});

describe('renderImportTable', () => {
  it('should render checksum sources', () => {
    const table = renderImportTable([
      {
        file: 'a.js',
        batch: 1,
        appliedAt: new Date('2024-01-01T12:00:00Z'),
        checksumSource: 'recomputed',
      },
      {
        file: 'b.js',
        batch: 2,
        appliedAt: new Date('2024-01-01T13:00:00Z'),
        checksumSource: 'reused',
      },
      { file: 'c.js', batch: 3, appliedAt: new Date('2024-01-01T14:00:00Z'), checksumSource: null },
    ]);
    const plain = stripAnsi(table);
    assert.ok(plain.includes('recomputed'));
    assert.ok(plain.includes('reused'));
    assert.ok(plain.includes('missing'));
    assert.strictEqual(new Set(lineWidths(table)).size, 1);
  });
});

describe('character widths', () => {
  it('should count CJK and fullwidth characters as two columns', () => {
    assert.strictEqual(charWidth('日'.codePointAt(0)), 2);
    assert.strictEqual(charWidth('한'.codePointAt(0)), 2);
    assert.strictEqual(charWidth('Ａ'.codePointAt(0)), 2);
    assert.strictEqual(charWidth('a'.codePointAt(0)), 1);
    assert.strictEqual(charWidth('ї'.codePointAt(0)), 1);
  });

  it('should measure a mixed string in terminal columns, not codepoints', () => {
    // 12 ASCII columns + 3 wide chars at 2 each = 18; String.length says 15.
    assert.strictEqual('20240101-日本語.js'.length, 15);
    assert.strictEqual(visibleWidth('20240101-日本語.js'), 18);
  });

  it('should keep a table with CJK filenames aligned', () => {
    const table = renderStatusTable([
      {
        file: '20240101-ascii.js',
        status: 'applied',
        batch: 1,
        appliedAt: new Date('2024-01-01T12:00:00Z'),
        duration: 5,
        checksumOk: true,
      },
      {
        file: '20240101-日本語.js',
        status: 'applied',
        batch: 1,
        appliedAt: new Date('2024-01-01T12:00:00Z'),
        duration: 5,
        checksumOk: true,
      },
    ]);
    // Every rendered line occupies the same number of terminal columns.
    const widths = table.split('\n').map((line) => visibleWidth(line));
    assert.strictEqual(new Set(widths).size, 1);
  });

  it('should truncate with an ellipsis only past the limit', () => {
    assert.strictEqual(truncate('short', 10), 'short');
    assert.strictEqual(truncate('abcdefghij', 5), 'abcd…');
    assert.strictEqual(visibleWidth(truncate('日本語日本語', 5)), 5);
  });
});

describe('renderStatusTable description column', () => {
  const row = (extra) => ({
    file: 'a.js',
    status: 'applied',
    batch: 1,
    appliedAt: new Date('2024-01-01T12:00:00Z'),
    duration: 5,
    checksumOk: true,
    ...extra,
  });

  it('should omit the column when no row has a description', () => {
    assert.ok(!stripAnsi(renderStatusTable([row({})])).includes('Description'));
  });

  it('should render descriptions when present', () => {
    const plain = stripAnsi(renderStatusTable([row({ description: 'Add users index' })]));
    assert.ok(plain.includes('Description'));
    assert.ok(plain.includes('Add users index'));
  });

  it('should ellipsize a long description and stay aligned', () => {
    const table = renderStatusTable([row({ description: 'x'.repeat(120) })]);
    assert.ok(stripAnsi(table).includes('…'));
    assert.strictEqual(new Set(table.split('\n').map((l) => visibleWidth(l))).size, 1);
  });

  it('should cap the Migration column for an absurdly long filename', () => {
    const table = renderStatusTable([row({ file: `${'m'.repeat(200)}.js` })]);
    assert.ok(stripAnsi(table).includes('…'));
    // The 200-char filename is capped at MAX_MIGRATION_WIDTH, so the full
    // table stays far narrower than the raw name would have forced it.
    assert.ok(visibleWidth(table.split('\n')[0]) < 150);
  });
});

describe('control-character sanitization', () => {
  it('should strip terminal escapes from a cell value', () => {
    assert.strictEqual(sanitize('safe\x1b[2Jname'), 'safe[2Jname');
    assert.strictEqual(sanitize('a\x00b\x07c'), 'abc');
  });

  it('should neutralize ANSI injected via a changelog description', () => {
    // A description is DB-sourced: an injected escape must not survive into
    // the rendered table, where it would restyle everything after the cell.
    const table = renderStatusTable([
      {
        file: 'a.js',
        status: 'applied',
        batch: 1,
        appliedAt: new Date('2024-01-01T12:00:00Z'),
        duration: 5,
        checksumOk: true,
        description: 'evil \x1b[32mgreen\x1b[0m \x1b]0;title\x07 text',
      },
    ]);
    // The only ESC bytes left are migronaut's own colors, which stripAnsi
    // removes cleanly — nothing untrusted remains.
    assert.ok(!stripAnsi(table).includes('\x1b'));
    assert.ok(stripAnsi(table).includes('green'));
  });

  it('should truncate without cutting an escape sequence in half', () => {
    const cut = truncate('\x1b[32mgreenish text\x1b[39m', 8);
    // Truncation happens on the stripped text, so no dangling color state.
    assert.ok(!cut.includes('\x1b'));
    assert.ok(visibleWidth(cut) <= 8);
  });
});
