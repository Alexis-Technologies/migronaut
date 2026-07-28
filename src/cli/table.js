const { createColors, stripAnsi } = require('../utils/colors.js');
const { formatDateTime } = require('../utils/date.js');
// Shared with the logger and spinner — cell values come from the changelog and
// from migration files, and every sink that prints them sanitizes the same way.
// Migronaut's own colors are applied after sanitizing, so they survive.
const { sanitize } = require('../utils/sanitize.js');

/**
 * Resolved per render rather than once at import: color depends on NO_COLOR /
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

/** Terminal columns of already-ANSI-free text — the shared codepoint walk */
function widthOfPlain(plain) {
  let width = 0;
  for (const char of plain) {
    width += charWidth(char.codePointAt(0));
  }
  return width;
}

/** Number of terminal columns a cell occupies, ignoring ANSI color codes */
function visibleWidth(text) {
  return widthOfPlain(stripAnsi(text));
}

/**
 * Shorten `text` to at most `max` visible columns, ending with an ellipsis.
 * Operates on the ANSI-stripped text: slicing raw characters could cut an
 * escape sequence in half and leave the terminal restyled past the cell.
 * One stripAnsi + one width walk per call — not one of each per check.
 */
function truncate(text, max) {
  const plain = stripAnsi(text);
  if (widthOfPlain(plain) <= max) return text;
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
 * from width so colored cells never skew the alignment. Within this function
 * each cell is measured exactly once and the width reused for padding
 * (truncate() above accounts for one more scan) — stripAnsi is not free at
 * 5k rows.
 */
function renderTable(head, rows) {
  // Measure every cell once and settle the column widths in the same pass.
  const headWidths = new Array(head.length);
  const widths = new Array(head.length);
  for (let index = 0; index < head.length; index++) {
    headWidths[index] = visibleWidth(head[index]);
    widths[index] = headWidths[index];
  }
  const cellWidths = new Array(rows.length);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const measured = new Array(row.length);
    for (let index = 0; index < row.length; index++) {
      measured[index] = visibleWidth(row[index]);
      if (measured[index] > widths[index]) widths[index] = measured[index];
    }
    cellWidths[rowIndex] = measured;
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
 * Width budgets for the two truncatable columns, shrunk to fit the terminal.
 *
 * `fixedWidth` is the room the non-truncatable columns and the box-drawing
 * frame take. Off-TTY (pipes, CI logs, tests) the static caps apply — output
 * stays byte-stable regardless of the invoking terminal's size. On a narrow
 * TTY the truncatable columns give way instead of every row wrapping into
 * box-drawing noise — the common case over SSH at 80 columns.
 */
function truncationBudgets(hasDescription, fixedWidth) {
  const columns = process.stdout.isTTY ? process.stdout.columns : undefined;
  if (!columns) {
    return { migration: MAX_MIGRATION_WIDTH, description: MAX_DESCRIPTION_WIDTH };
  }
  const available = Math.max(0, columns - fixedWidth);
  if (!hasDescription) {
    return {
      migration: Math.max(12, Math.min(MAX_MIGRATION_WIDTH, available)),
      description: MAX_DESCRIPTION_WIDTH,
    };
  }
  const migration = Math.max(12, Math.min(MAX_MIGRATION_WIDTH, Math.ceil(available * 0.6)));
  const description = Math.max(8, Math.min(MAX_DESCRIPTION_WIDTH, available - migration));
  return { migration, description };
}

/**
 * Render status rows as a human-readable table string. The Description column
 * appears only when at least one row has one, so the common case stays narrow.
 */
function renderStatusTable(rows) {
  const colors = palette();
  let hasDescription = false;
  for (const row of rows) {
    if (row.description) {
      hasDescription = true;
      break;
    }
  }
  // Status(7) + Batch(5) + Applied At(19) + Duration(8) + Checksum(8) plus
  // `│ … │ ` framing: 3 columns of overhead per column and one closing bar.
  const budgets = truncationBudgets(hasDescription, 47 + (hasDescription ? 7 : 6) * 3 + 1);
  const head = ['Migration', 'Status', 'Batch', 'Applied At', 'Duration', 'Checksum'];
  if (hasDescription) head.push('Description');
  const cells = [];
  for (const row of rows) {
    const cell = [
      truncate(sanitize(row.file), budgets.migration),
      statusCell(colors, row.status),
      row.batch === null ? '' : String(row.batch),
      row.appliedAt ? formatDateTime(row.appliedAt) : '',
      row.duration === null ? '' : `${row.duration}ms`,
      checksumCell(colors, row.checksumOk),
    ];
    if (hasDescription) {
      cell.push(truncate(sanitize(row.description ?? ''), budgets.description));
    }
    cells.push(cell);
  }
  return renderTable(head, cells);
}

/** Shared render for row-listing commands: the table, or a friendly empty line */
function renderRowsOrEmpty(rows, { logger }) {
  if (rows.length === 0) logger.info('No migrations found');
  else logger.info(renderStatusTable(rows));
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
  // Batch(5) + Applied At(19) + Checksum(10) plus the 4-column frame.
  const budgets = truncationBudgets(false, 34 + 4 * 3 + 1);
  const head = ['Migration', 'Batch', 'Applied At', 'Checksum'];
  const cells = [];
  for (const row of rows) {
    cells.push([
      truncate(sanitize(row.file), budgets.migration),
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
  renderRowsOrEmpty,
};
