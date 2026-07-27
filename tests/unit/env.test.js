const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, it } = require('node:test');
const { applyEnvFile } = require('../../src/utils/env.js');

describe('applyEnvFile', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'migronaut-env-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('should load keys into the target env object', async () => {
    const file = path.join(tmp, '.env');
    writeFileSync(file, 'FOO=bar\nBAZ=qux\n');
    const env = {};
    await applyEnvFile(file, env);
    assert.strictEqual(env.FOO, 'bar');
    assert.strictEqual(env.BAZ, 'qux');
  });

  it('should parse comments, export prefixes, and quoted values', async () => {
    const file = path.join(tmp, '.env');
    writeFileSync(file, '# comment\nexport FOO=bar\nPASS="a#b"\nURI=mongodb://u:p@host/?a=1\n');
    const env = {};
    await applyEnvFile(file, env);
    assert.strictEqual(env.FOO, 'bar');
    assert.strictEqual(env.PASS, 'a#b');
    assert.strictEqual(env.URI, 'mongodb://u:p@host/?a=1');
  });

  it('should support double-quoted multiline values', async () => {
    const file = path.join(tmp, '.env');
    writeFileSync(file, 'MULTI="line1\nline2"\nAFTER=ok\n');
    const env = {};
    await applyEnvFile(file, env);
    assert.strictEqual(env.MULTI, 'line1\nline2');
    assert.strictEqual(env.AFTER, 'ok');
  });

  it('should never override keys that are already set', async () => {
    const file = path.join(tmp, '.env');
    writeFileSync(file, 'FOO=from-file\nBAZ=from-file\n');
    const env = { FOO: 'from-process' };
    await applyEnvFile(file, env);
    assert.strictEqual(env.FOO, 'from-process');
    assert.strictEqual(env.BAZ, 'from-file');
  });

  it('should be a no-op when the file does not exist', async () => {
    const env = {};
    await applyEnvFile(path.join(tmp, 'missing.env'), env);
    assert.deepStrictEqual(env, {});
  });

  it('should default to process.env as the target', async () => {
    const key = 'MIGRONAUT_ENV_TEST_UNIQUE_KEY';
    const file = path.join(tmp, '.env');
    writeFileSync(file, `${key}=loaded\n`);
    delete process.env[key];
    try {
      await applyEnvFile(file);
      assert.strictEqual(process.env[key], 'loaded');
    } finally {
      delete process.env[key];
    }
  });
});
