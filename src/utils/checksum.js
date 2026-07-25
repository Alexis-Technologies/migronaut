const crypto = require('node:crypto');
const fs = require('node:fs');

/** Returns SHA-256 hex digest of a file's contents */
function computeChecksum(filepath) {
  const contents = fs.readFileSync(filepath, 'utf8');
  return crypto.createHash('sha256').update(contents).digest('hex');
}

/** Returns true if file checksum matches the stored checksum */
function verifyChecksum(filepath, stored) {
  return computeChecksum(filepath) === stored;
}

module.exports = { computeChecksum, verifyChecksum };
