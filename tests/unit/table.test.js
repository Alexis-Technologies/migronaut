const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { renderImportTable, renderStatusTable, renderTable } = require('../../src/cli/table.js');
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
