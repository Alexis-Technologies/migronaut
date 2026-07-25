const fs = require('node:fs/promises');
const util = require('node:util');

const QUOTES = ["'", '"', '`'];
const KEY_PATTERN = /^[\w.-]+$/;

/** Cut an unquoted value at the first `#` that starts it or follows whitespace */
function stripInlineComment(value) {
  for (let i = 0; i < value.length; i++) {
    const isComment =
      value[i] === '#' && (i === 0 || value[i - 1] === ' ' || value[i - 1] === '\t');
    if (isComment) return value.slice(0, i);
  }
  return value;
}

/**
 * Parse `.env` file contents into a plain map — the fallback used when the
 * running Node has no `util.parseEnv` (added in 20.12).
 *
 * One `KEY=VALUE` per line; blank lines, `#` comment lines and an `export `
 * prefix are ignored; matching single/double/back quotes are stripped (a `#`
 * inside quotes is kept); unquoted values lose ` # inline comments`.
 * Multiline values, `\n` expansion and `${VAR}` interpolation are not
 * supported — both parse paths agree on plain single-line files.
 */
function parseEnvContent(content) {
  const result = Object.create(null);
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const entry = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) continue;
    let value = entry.slice(separator + 1).trim();
    const quote = value[0];
    if (QUOTES.includes(quote) && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = stripInlineComment(value).trim();
    }
    result[key] = value;
  }
  return result;
}

/**
 * Load `filePath` (.env format) into `env`, never overriding keys that are
 * already set (dotenv's `override: false` semantics). A missing file is a
 * silent no-op.
 */
async function applyEnvFile(filePath, env = process.env) {
  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const hasNativeParser = typeof util.parseEnv === 'function';
  const parsed = hasNativeParser ? util.parseEnv(content) : parseEnvContent(content);
  for (const key of Object.keys(parsed)) {
    if (env[key] === undefined) env[key] = parsed[key];
  }
}

module.exports = { parseEnvContent, applyEnvFile };
