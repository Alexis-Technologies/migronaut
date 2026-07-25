const crypto = require('node:crypto');
const fs = require('node:fs/promises');

/** Returns SHA-256 hex digest of a file's contents */
async function computeChecksum(filepath) {
  const contents = await fs.readFile(filepath, 'utf8');
  return crypto.createHash('sha256').update(contents).digest('hex');
}

/** Returns true if file checksum matches the stored checksum */
async function verifyChecksum(filepath, stored) {
  return (await computeChecksum(filepath)) === stored;
}

module.exports = { computeChecksum, verifyChecksum };
