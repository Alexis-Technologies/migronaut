const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const repoRoot = path.join(__dirname, '..', '..');

/** Command names as registered in src/cli/commands/ (the source of truth) */
function registeredCommandNames() {
  const dir = path.join(repoRoot, 'src', 'cli', 'commands');
  const names = [];
  for (const file of readdirSync(dir)) {
    const source = readFileSync(path.join(dir, file), 'utf8');
    const match = /name: '([a-z-]+)'/.exec(source);
    if (match) names.push(match[1]);
  }
  return names.sort();
}

// The README's command table has drifted behind the registered commands twice
// (audit and lock were missing). This pins the two surfaces together: a new
// command must show up in both the README and the CLI reference doc.
describe('README / docs stay in sync with the registered CLI commands', () => {
  const names = registeredCommandNames();

  it('should find every registered command (sanity: 13 commands)', () => {
    assert.strictEqual(names.length, 13);
  });

  it('should mention every command in the README Commands table', () => {
    const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    for (const name of names) {
      assert.ok(
        readme.includes(`migronaut ${name}`),
        `README.md does not mention "migronaut ${name}" — update the Commands table`,
      );
    }
  });

  it('should mention every command in docs/reference/cli.md', () => {
    const reference = readFileSync(path.join(repoRoot, 'docs', 'reference', 'cli.md'), 'utf8');
    for (const name of names) {
      assert.ok(
        reference.includes(`migronaut ${name}`),
        `docs/reference/cli.md does not mention "migronaut ${name}"`,
      );
    }
  });

  it('should pair every ENV_KEYS variable with its config key in the README table', () => {
    // The env-var table has the same drift profile that created this file:
    // ENV_KEYS grows with every new scalar config key, and the README copy is
    // hand-written. Derived from the exported table, like config.test.js.
    const { ENV_KEYS } = require(path.join(repoRoot, 'src', 'core', 'config.js'));
    const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    for (const spec of ENV_KEYS) {
      assert.ok(
        readme.includes(`| \`${spec.env}\` | \`${spec.path}\` |`),
        `README env table is missing the ${spec.env} → ${spec.path} row`,
      );
    }
    // The one env var deliberately outside the table (it selects the .env file
    // the table's values are read from).
    assert.ok(readme.includes('| `MIGRONAUT_ENV_FILE` | `envFile` |'));
  });
});
