const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const repoRoot = path.join(__dirname, '..', '..');
const read = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8');

/** The event names `MigronautEvents` declares in index.d.ts — what a listener can subscribe to */
function declaredEvents() {
  const types = read('index.d.ts');
  const start = types.indexOf('export interface MigronautEvents {');
  assert.ok(start !== -1, 'index.d.ts declares MigronautEvents');
  const body = types.slice(start, types.indexOf('\n}\n', start));
  const names = new Set();
  for (const match of body.matchAll(/^ {2}'([a-z:]+)':/gm)) names.add(match[1]);
  return names;
}

/**
 * The events are documented by hand: the ordinary ones in the hooks guide's
 * table, the background ones in their own guide. A new event that reaches the
 * types but neither page is one no user hears about.
 */
describe('lifecycle events docs sync', () => {
  const documented =
    read('docs', 'guide', 'hooks.md') + read('docs', 'guide', 'background-migrations.md');

  it('should find the events', () => {
    const names = declaredEvents();
    assert.ok(names.size >= 25, `found ${names.size}`);
    assert.ok(names.has('migration:log'));
  });

  it('should document every event the types declare', () => {
    for (const name of declaredEvents()) {
      assert.ok(
        documented.includes(`\`${name}\``),
        `neither docs/guide/hooks.md nor docs/guide/background-migrations.md mentions ${name}`,
      );
    }
  });
});
