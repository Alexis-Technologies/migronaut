const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { ATTRIBUTES, METRICS, SPANS } = require('../../src/utils/telemetry.js');

const repoRoot = path.join(__dirname, '..', '..');
const guide = readFileSync(path.join(repoRoot, 'docs', 'guide', 'opentelemetry.md'), 'utf8');

/**
 * The OpenTelemetry guide's tables are a hand-kept copy of the names in
 * src/utils/telemetry.js — what dashboards are built on. Both directions are
 * pinned: every name emitted is documented, and every name documented is
 * emitted (a rename that updated only one side breaks someone's alert).
 */
describe('OpenTelemetry guide sync', () => {
  const emitted = new Set([
    ...Object.values(SPANS),
    ...Object.values(METRICS),
    ...Object.values(ATTRIBUTES),
  ]);

  it('should document every span, metric and attribute name', () => {
    for (const name of emitted) {
      assert.ok(
        guide.includes(`\`${name}\``),
        `docs/guide/opentelemetry.md does not mention ${name}`,
      );
    }
  });

  it('should document no migronaut name that is not emitted', () => {
    const documented = new Set(
      guide
        .match(/`migronaut\.[a-z_.]+`/g)
        ?.map((name) => name.slice(1, -1))
        // File names (migronaut.config.js, migronaut.schema.json) are not telemetry.
        .filter((name) => !/^migronaut\.(config|schema)\./.test(name)),
    );
    for (const name of documented) {
      assert.ok(
        emitted.has(name),
        `docs/guide/opentelemetry.md mentions ${name}, which is not emitted`,
      );
    }
  });
});
