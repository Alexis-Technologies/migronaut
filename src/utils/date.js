/** Zero-pad a number to two digits */
const pad = (n) => {
  return String(n).padStart(2, '0');
};

/**
 * Local-time compact timestamp, e.g. `20240526143021`.
 * Used as the leading prefix for timestamped migration filenames.
 */
const formatStamp = (date) => {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
};

/**
 * Human-readable local-time timestamp, e.g. `2024-05-26 14:30:21`.
 * Used in the status/list/import tables.
 */
const formatDateTime = (date) => {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
};

module.exports = { formatStamp, formatDateTime };
