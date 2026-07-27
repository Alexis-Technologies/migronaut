const { createColors, stripAnsi } = require('../utils/colors.js');
const { formatDateTime } = require('../utils/date.js');

/**
 * Resolved per render rather than once at import: color depends on NO_COLOR /
 * FORCE_COLOR / TTY, and `--no-color` is applied after this module is loaded.
 */
const palette = () => createColors(process.stdout);

/**
 * Control characters stripped from data cells. Cell values come from the
 * changelog and from migration files — sources anyone with write access to the
 * database can influence — so ESC and friends must never reach the terminal,
 * where they could move the cursor or restyle everything after the table.
 * Migronaut's own colors are applied after sanitizing, so they survive.
 */
// oxlint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g;

/** Strip terminal control characters from an untrusted cell value */
function sanitize(text) {
  return String(text).replace(CONTROL_CHARS, '');
}

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
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/** Terminal columns a single codepoint occupies (0 for combining marks) */
function charWidth(codepoint) {
  // Combining marks attach to the previous glyph and take no width of their own.
  if (codepoint >= 0x0300 && codepoint <= 0x036f) return 0;
  // Variation selectors (VS15/VS16 among them) modify the preceding glyph.
  if (codepoint >= 0xfe00 && codepoint <= 0xfe0f) return 0;
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

/**
 * Shorten `text` to at most `max` visible columns, ending with an ellipsis.
 * Operates on the ANSI-stripped text: slicing raw characters could cut an
 * escape sequence in half and leave the terminal restyled past the cell.
 */
function truncate(text, max) {
  const plain = stripAnsi(text);
  if (visibleWidth(plain) <= max) return text;
  let out = '';
  let width = 0;
  for (const char of plain) {
    const next = width + charWidth(char.codePointAt(0));
    if (next > max - 1) break;
    out += char;
    width = next;
  }
  return `${out}…`;
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
 * from width so colored cells never skew the alignment. Widths are measured
 * once per cell and reused for padding — stripAnsi is not free at 5k rows.
 */
function renderTable(head, rows) {
  const headWidths = head.map(visibleWidth);
  const cellWidths = rows.map((row) => row.map(visibleWidth));
  const widths = [];
  for (let index = 0; index < head.length; index++) {
    let width = headWidths[index];
    for (const rowWidths of cellWidths) {
      if (rowWidths[index] > width) width = rowWidths[index];
    }
    widths.push(width);
  }
  const renderRow = (cells, measured) => {
    const padded = [];
    for (let index = 0; index < cells.length; index++) {
      padded.push(cells[index] + ' '.repeat(Math.max(0, widths[index] - measured[index])));
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
    renderRow(coloredHead, headWidths),
    borderLine(widths, '├', '┼', '┤'),
  ];
  for (let index = 0; index < rows.length; index++) {
    lines.push(renderRow(rows[index], cellWidths[index]));
  }
  lines.push(borderLine(widths, '└', '┴', '┘'));
  return lines.join('\n');
}

/** Render a checksum indicator cell */
function checksumCell(colors, value) {
  if (value === null) return colors.dim('—');
  return value ? colors.green('ok') : colors.red('MISMATCH');
}

/** Render a status cell */
function statusCell(colors, status) {
  return status === 'applied' ? colors.green('applied') : colors.yellow('pending');
}

/** Longest description rendered before it is ellipsized */
const MAX_DESCRIPTION_WIDTH = 40;

/** Longest migration filename rendered before it is ellipsized */
const MAX_MIGRATION_WIDTH = 60;

/**
 * Render status rows as a human-readable table string. The Description column
 * appears only when at least one row has one, so the common case stays narrow.
 */
function renderStatusTable(rows) {
  const colors = palette();
  const hasDescription = rows.some((row) => row.description);
  const head = ['Migration', 'Status', 'Batch', 'Applied At', 'Duration', 'Checksum'];
  if (hasDescription) head.push('Description');
  const cells = [];
  for (const row of rows) {
    const cell = [
      truncate(sanitize(row.file), MAX_MIGRATION_WIDTH),
      statusCell(colors, row.status),
      row.batch === null ? '' : String(row.batch),
      row.appliedAt ? formatDateTime(row.appliedAt) : '',
      row.duration === null ? '' : `${row.duration}ms`,
      checksumCell(colors, row.checksumOk),
    ];
    if (hasDescription) {
      cell.push(truncate(sanitize(row.description ?? ''), MAX_DESCRIPTION_WIDTH));
    }
    cells.push(cell);
  }
  return renderTable(head, cells);
}

/** Render the checksum-source cell for an import row */
function checksumSourceCell(colors, source) {
  if (source === 'recomputed') return colors.green('recomputed');
  if (source === 'reused') return colors.cyan('reused');
  return colors.red('missing');
}

/** Render mapped import rows as a human-readable table string */
function renderImportTable(rows) {
  const colors = palette();
  const head = ['Migration', 'Batch', 'Applied At', 'Checksum'];
  const cells = [];
  for (const row of rows) {
    cells.push([
      truncate(sanitize(row.file), MAX_MIGRATION_WIDTH),
      String(row.batch),
      formatDateTime(row.appliedAt),
      checksumSourceCell(colors, row.checksumSource),
    ]);
  }
  return renderTable(head, cells);
}

module.exports = {
  charWidth,
  sanitize,
  visibleWidth,
  truncate,
  renderTable,
  renderStatusTable,
  renderImportTable,
};
