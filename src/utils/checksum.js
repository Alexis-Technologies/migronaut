const crypto = require('node:crypto');
const fs = require('node:fs/promises');

const UTF8_BOM = 0xfeff;

/**
 * SHA-256 hex digest of a migration file, normalized so the same logical file
 * hashes the same everywhere.
 *
 * Line endings are normalized to LF and a leading UTF-8 BOM is stripped:
 * without that, a Windows checkout (or a `.gitattributes` `text=auto`) produces
 * a different digest for byte-identical content and every applied migration
 * reports a spurious checksum mismatch.
 */
async function computeChecksum(filepath) {
  const buffer = await fs.readFile(filepath);
  let contents = buffer.toString('utf8');
  if (contents.charCodeAt(0) === UTF8_BOM) contents = contents.slice(1);
  contents = contents.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(contents, 'utf8').digest('hex');
}

module.exports = { computeChecksum };
