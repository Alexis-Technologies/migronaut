const { createColors, stripAnsi } = require('../utils/colors.js');
const { formatDateTime } = require('../utils/date.js');

const colors = createColors(process.stdout);

/** Number of terminal columns a cell occupies, ignoring ANSI color codes */
function visibleWidth(text) {
  return stripAnsi(text).length;
}

/** Pad a cell with trailing spaces up to `width` visible columns */
function padCell(text, width) {
  return text + ' '.repeat(width - visibleWidth(text));
}

/** Build a horizontal border line for the given column widths */
function borderLine(widths, left, mid, right) {
  const segments = widths.map((width) => '─'.repeat(width + 2));
  return left + segments.join(mid) + right;
}

/**
 * Render `head` + `rows` (arrays of string cells) as a box-drawing table.
 * Column widths come from the widest cell; ANSI color codes are excluded
 * from width so colored cells never skew the alignment.
 */
function renderTable(head, rows) {
  const widths = head.map((title, index) => {
    let width = visibleWidth(title);
    for (const row of rows) {
      const cellWidth = visibleWidth(row[index]);
      if (cellWidth > width) width = cellWidth;
    }
    return width;
  });
  const renderRow = (cells) =>
    `│ ${cells.map((cell, index) => padCell(cell, widths[index])).join(' │ ')} │`;
  const lines = [
    borderLine(widths, '┌', '┬', '┐'),
    renderRow(head.map((title) => colors.cyan(title))),
    borderLine(widths, '├', '┼', '┤'),
    ...rows.map(renderRow),
    borderLine(widths, '└', '┴', '┘'),
  ];
  return lines.join('\n');
}

/** Render a checksum indicator cell */
function checksumCell(value) {
  if (value === null) return colors.dim('—');
  return value ? colors.green('ok') : colors.red('MISMATCH');
}

/** Render a status cell */
function statusCell(status) {
  return status === 'applied' ? colors.green('applied') : colors.yellow('pending');
}

/** Render status rows as a human-readable table string */
function renderStatusTable(rows) {
  const head = ['Migration', 'Status', 'Batch', 'Applied At', 'Duration', 'Checksum'];
  const cells = rows.map((row) => [
    row.file,
    statusCell(row.status),
    row.batch === null ? '' : String(row.batch),
    row.appliedAt ? formatDateTime(row.appliedAt) : '',
    row.duration === null ? '' : `${row.duration}ms`,
    checksumCell(row.checksumOk),
  ]);
  return renderTable(head, cells);
}

/** Render the checksum-source cell for an import row */
function checksumSourceCell(source) {
  if (source === 'recomputed') return colors.green('recomputed');
  if (source === 'reused') return colors.cyan('reused');
  return colors.red('missing');
}

/** Render mapped import rows as a human-readable table string */
function renderImportTable(rows) {
  const head = ['Migration', 'Batch', 'Applied At', 'Checksum'];
  const cells = rows.map((row) => [
    row.file,
    String(row.batch),
    formatDateTime(row.appliedAt),
    checksumSourceCell(row.checksumSource),
  ]);
  return renderTable(head, cells);
}

module.exports = { renderTable, renderStatusTable, renderImportTable };
