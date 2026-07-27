const fs = require('node:fs/promises');
const util = require('node:util');

/**
 * Load `filePath` (.env format) into `env`, never overriding keys that are
 * already set (dotenv's `override: false` semantics). A missing file is a
 * silent no-op. Parsing is `util.parseEnv` — always present on the supported
 * Node range (added in 20.12; engines require ≥22.18).
 */
async function applyEnvFile(filePath, env = process.env) {
  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const parsed = util.parseEnv(content);
  for (const key of Object.keys(parsed)) {
    if (env[key] === undefined) env[key] = parsed[key];
  }
}

module.exports = { applyEnvFile };
