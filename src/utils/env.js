const util = require('node:util');

const { readSmallFile } = require('./file.js');

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
const applyEnvFile = async (filePath, env = process.env) => {
  // `--env-file /dev/zero`, a FIFO or a runaway file must fail with a typed
  // error, not hang the process reading forever (readSmallFile).
  let content = '';
  try {
    content = await readSmallFile(filePath, 'env file');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const parsed = util.parseEnv(content);
  for (const key of Object.keys(parsed)) {
    if (UNSAFE_ENV_KEYS.has(key)) continue;
    if (env[key] === undefined) env[key] = parsed[key];
  }
};

module.exports = { applyEnvFile };
