const { createColors, stripAnsi } = require('../utils/colors.js');
const { formatDateTime } = require('../utils/date.js');

/**
 * Resolved per call rather than once at import: color depends on NO_COLOR /
 * FORCE_COLOR / TTY, and `--no-color` is applied after this module is loaded.
 */
const palette = () => createColors(process.stdout);

/**
 * Codepoint ranges the terminal renders two columns wide (East Asian Wide and
 * Fullwidth). Counting them as one — which `String.length` does — misaligns
 * every column to the right of a CJK filename.
 */
const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/** Terminal columns a single codepoint occupies (0 for combining marks) */
function charWidth(codepoint) {
  // Combining marks attach to the previous glyph and take no width of their own.
  if (codepoint >= 0x0300 && codepoint <= 0x036f) return 0;
  for (const [start, end] of WIDE_RANGES) {
    if (codepoint >= start && codepoint <= end) return 2;
  }
  return 1;
}

/** Number of terminal columns a cell occupies, ignoring ANSI color codes */
function visibleWidth(text) {
  let width = 0;
  for (const char of stripAnsi(text)) {
    width += charWidth(char.codePointAt(0));
  }
  return width;
}

/** Shorten `text` to at most `max` visible columns, ending with an ellipsis */
function truncate(text, max) {
  if (visibleWidth(text) <= max) return text;
  let out = '';
  let width = 0;
  for (const char of text) {
    const next = width + charWidth(char.codePointAt(0));
    if (next > max - 1) break;
    out += char;
    width = next;
  }
  return `${out}…`;
}

/** Pad a cell with trailing spaces up to `width` visible columns */
function padCell(text, width) {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}

/** Build a horizontal border line for the given column widths */
function borderLine(widths, left, mid, right) {
  const segments = [];
  for (const width of widths) segments.push('─'.repeat(width + 2));
  return left + segments.join(mid) + right;
}

/**
 * Render `head` + `rows` (arrays of string cells) as a box-drawing table.
 * Column widths come from the widest cell; ANSI color codes are excluded
 * from width so colored cells never skew the alignment.
 */
function renderTable(head, rows) {
  const widths = [];
  for (let index = 0; index < head.length; index++) {
    let width = visibleWidth(head[index]);
    for (const row of rows) {
      const cellWidth = visibleWidth(row[index]);
      if (cellWidth > width) width = cellWidth;
    }
    widths.push(width);
  }
  const renderRow = (cells) => {
    const padded = [];
    for (let index = 0; index < cells.length; index++) {
      padded.push(padCell(cells[index], widths[index]));
    }
    return `│ ${padded.join(' │ ')} │`;
  };
  const colors = palette();
  const coloredHead = [];
  for (const title of head) {
    coloredHead.push(colors.cyan(title));
  }
  const lines = [
    borderLine(widths, '┌', '┬', '┐'),
    renderRow(coloredHead),
    borderLine(widths, '├', '┼', '┤'),
  ];
  for (const row of rows) lines.push(renderRow(row));
  lines.push(borderLine(widths, '└', '┴', '┘'));
  return lines.join('\n');
}

/** Render a checksum indicator cell */
function checksumCell(value) {
  const colors = palette();
  if (value === null) return colors.dim('—');
  return value ? colors.green('ok') : colors.red('MISMATCH');
}

/** Render a status cell */
function statusCell(status) {
  const colors = palette();
  return status === 'applied' ? colors.green('applied') : colors.yellow('pending');
}

/** Longest description rendered before it is ellipsized */
const MAX_DESCRIPTION_WIDTH = 40;

/**
 * Render status rows as a human-readable table string. The Description column
 * appears only when at least one row has one, so the common case stays narrow.
 */
function renderStatusTable(rows) {
  const hasDescription = rows.some((row) => row.description);
  const head = ['Migration', 'Status', 'Batch', 'Applied At', 'Duration', 'Checksum'];
  if (hasDescription) head.push('Description');
  const cells = [];
  for (const row of rows) {
    const cell = [
      row.file,
      statusCell(row.status),
      row.batch === null ? '' : String(row.batch),
      row.appliedAt ? formatDateTime(row.appliedAt) : '',
      row.duration === null ? '' : `${row.duration}ms`,
      checksumCell(row.checksumOk),
    ];
    if (hasDescription) cell.push(truncate(row.description ?? '', MAX_DESCRIPTION_WIDTH));
    cells.push(cell);
  }
  return renderTable(head, cells);
}

/** Render the checksum-source cell for an import row */
function checksumSourceCell(source) {
  const colors = palette();
  if (source === 'recomputed') return colors.green('recomputed');
  if (source === 'reused') return colors.cyan('reused');
  return colors.red('missing');
}

/** Render mapped import rows as a human-readable table string */
function renderImportTable(rows) {
  const head = ['Migration', 'Batch', 'Applied At', 'Checksum'];
  const cells = [];
  for (const row of rows) {
    cells.push([
      row.file,
      String(row.batch),
      formatDateTime(row.appliedAt),
      checksumSourceCell(row.checksumSource),
    ]);
  }
  return renderTable(head, cells);
}

module.exports = {
  charWidth,
  visibleWidth,
  truncate,
  renderTable,
  renderStatusTable,
  renderImportTable,
};
