const fs = require('node:fs/promises');
const util = require('node:util');
const { ConfigInvalidError } = require('../errors/index.js');

/** Larger than any sane .env — the same ceiling custom templates get */
const MAX_ENV_FILE_BYTES = 1024 * 1024;

/**
 * Keys never copied into the target: with a plain-object `env`, assigning
 * `__proto__` writes through to the prototype. `process.env` coerces these
 * harmlessly today, but that is an implementation detail of process.env —
 * the guard makes the intent explicit instead of leaning on it.
 */
const UNSAFE_ENV_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Load `filePath` (.env format) into `env`, never overriding keys that are
 * already set (dotenv's `override: false` semantics). A missing file is a
 * silent no-op. Parsing is `util.parseEnv` — always present on the supported
 * Node range (added in 20.12; engines require ≥22.18).
 */
async function applyEnvFile(filePath, env = process.env) {
  // stat before read: `--env-file /dev/zero` (or a runaway file) must fail
  // with a typed error, not hang the process reading forever.
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  // A device file (/dev/zero reports size 0), FIFO or directory would hang or
  // garble the read — only regular files are .env candidates.
  if (!stats.isFile()) {
    throw new ConfigInvalidError('env file is not a regular file', { path: filePath });
  }
  if (stats.size > MAX_ENV_FILE_BYTES) {
    throw new ConfigInvalidError('env file is too large (max 1 MB)', {
      path: filePath,
      size: stats.size,
    });
  }
  const content = await fs.readFile(filePath, 'utf8');
  const parsed = util.parseEnv(content);
  for (const key of Object.keys(parsed)) {
    if (UNSAFE_ENV_KEYS.has(key)) continue;
    if (env[key] === undefined) env[key] = parsed[key];
  }
}

module.exports = { applyEnvFile };
