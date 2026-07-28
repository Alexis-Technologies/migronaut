const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const repoRoot = path.join(__dirname, '..', '..');
const readRepoFile = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');

/**
 * migronaut.schema.json is a hand-maintained copy of the config surface,
 * alongside CONFIG_KEYS in src/core/config.js and index.d.ts. Nothing else
 * pins it, so it silently drifts — the same job package-surface.test.js and
 * readme-sync.test.js already do for the other two copies.
 */
describe('config schema sync', () => {
  const schema = JSON.parse(readRepoFile('migronaut.schema.json'));

  // The JSON-expressible config keys: everything validateConfig checks, minus
  // nothing (all CONFIG_KEYS values are JSON-expressible), plus $schema
  // itself. Live instances (hooks, logger, mongoose, client) are .ts/.js-only
  // and deliberately absent; clientOptions IS a plain object, so it stays.
  it('should describe every validated config key, and nothing else', () => {
    // Reach the internal table through the module — the test breaks loudly if
    // the export shape changes, which is the point.
    const configSource = readRepoFile('src/core/config.js');
    const keyMatches = [...configSource.matchAll(/^\s*(?:{ )?path: '([a-zA-Z]+)'/gm)];
    const validated = new Set(keyMatches.map((match) => match[1]));
    assert.ok(validated.size >= 15, 'expected to find the CONFIG_KEYS table');

    const properties = new Set(Object.keys(schema.properties));
    for (const key of validated) {
      // clientOptions holds MongoClientOptions and cannot be described fully;
      // it must still be *present* so a JSON config using it validates.
      assert.ok(properties.has(key), `schema is missing the '${key}' config key`);
    }
    const knownExtra = new Set(['$schema']);
    for (const key of properties) {
      assert.ok(
        validated.has(key) || knownExtra.has(key),
        `schema describes '${key}', which CONFIG_KEYS does not validate`,
      );
    }
  });

  it('should allow unknown keys, matching the runtime validator', () => {
    // validateConfig documents non-strict behavior; a schema that rejects
    // unknown keys red-squiggles configs that run fine.
    assert.notStrictEqual(schema.additionalProperties, false);
  });

  it('should keep the served copy byte-identical to the canonical one', () => {
    // The $schema URL written by `init --format json` points at the docs
    // site; VitePress serves docs/public/ verbatim, so the two files must
    // never diverge.
    assert.strictEqual(
      readRepoFile('docs/public/migronaut.schema.json'),
      readRepoFile('migronaut.schema.json'),
    );
  });

  it('should default createExtension to js, matching DEFAULT_CONFIG', () => {
    const { DEFAULT_CONFIG } = require(path.join(repoRoot, 'src', 'core', 'config.js'));
    assert.strictEqual(schema.properties.createExtension.default, DEFAULT_CONFIG.createExtension);
    assert.strictEqual(schema.properties.lockTTLSeconds.default, DEFAULT_CONFIG.lockTTLSeconds);
  });
});
