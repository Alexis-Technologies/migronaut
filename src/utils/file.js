const fs = require('node:fs/promises');

const { ConfigInvalidError } = require('../errors/index.js');
const { contextPath } = require('./error.js');

/** Larger than any sane `.env`, JSON config or template */
const MAX_SMALL_FILE_BYTES = 1024 * 1024;

/**
 * Opened without blocking: opening a FIFO for reading waits for a writer, and
 * the descriptor's own stat is what tells it apart. Windows has no such flag,
 * nor FIFOs to open.
 */
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/**
 * Read a small file migronaut trusts but did not write — a `.env`, a JSON
 * config, a custom template — whole, as text, through one descriptor: a
 * regular file only (`/dev/zero` or a FIFO would hang the read, and a stat of
 * the path before the read lets the path change in between), and no larger
 * than the cap. A missing file is the caller's to answer (ENOENT). `what`
 * names the file in the errors.
 */
const readSmallFile = async (filepath, what) => {
  const handle = await fs.open(filepath, OPEN_FLAGS);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new ConfigInvalidError(`${what} is not a regular file`, {
        context: { path: contextPath(filepath) },
      });
    }
    if (stats.size > MAX_SMALL_FILE_BYTES) {
      throw new ConfigInvalidError(`${what} is too large (max 1 MB)`, {
        context: { path: contextPath(filepath), size: stats.size },
      });
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

module.exports = { MAX_SMALL_FILE_BYTES, readSmallFile };
