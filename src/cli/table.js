const chalk = require('chalk');
const Table = require('cli-table3');
const { formatDateTime } = require('../utils/date.js');

/** Render a checksum indicator cell */
function checksumCell(value) {
  if (value === null) return chalk.dim('—');
  return value ? chalk.green('ok') : chalk.red('MISMATCH');
}

/** Render a status cell */
function statusCell(status) {
  return status === 'applied' ? chalk.green('applied') : chalk.yellow('pending');
}

/** Render status rows as a human-readable table string */
function renderStatusTable(rows) {
  const table = new Table({
    head: ['Migration', 'Status', 'Batch', 'Applied At', 'Duration', 'Checksum'],
    style: { head: ['cyan'] },
  });

  for (const row of rows) {
    table.push([
      row.file,
      statusCell(row.status),
      row.batch === null ? '' : String(row.batch),
      row.appliedAt ? formatDateTime(row.appliedAt) : '',
      row.duration === null ? '' : `${row.duration}ms`,
      checksumCell(row.checksumOk),
    ]);
  }

  return table.toString();
}

/** Render the checksum-source cell for an import row */
function checksumSourceCell(source) {
  if (source === 'recomputed') return chalk.green('recomputed');
  if (source === 'reused') return chalk.cyan('reused');
  return chalk.red('missing');
}

/** Render mapped import rows as a human-readable table string */
function renderImportTable(rows) {
  const table = new Table({
    head: ['Migration', 'Batch', 'Applied At', 'Checksum'],
    style: { head: ['cyan'] },
  });

  for (const row of rows) {
    table.push([
      row.file,
      String(row.batch),
      formatDateTime(row.appliedAt),
      checksumSourceCell(row.checksumSource),
    ]);
  }

  return table.toString();
}

module.exports = { renderStatusTable, renderImportTable };
