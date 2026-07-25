const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, it } = require('node:test');
const { applyEnvFile, parseEnvContent } = require('../../src/utils/env.js');

describe('parseEnvContent', () => {
  it('should parse plain KEY=VALUE lines and trim whitespace', () => {
    const parsed = parseEnvContent('FOO=bar\n  BAZ =  qux  \n');
    assert.strictEqual(parsed.FOO, 'bar');
    assert.strictEqual(parsed.BAZ, 'qux');
  });

  it('should skip blank lines and comment lines', () => {
    const parsed = parseEnvContent('\n# comment\n   \nFOO=bar\n#ANOTHER=nope\n');
    assert.deepStrictEqual({ ...parsed }, { FOO: 'bar' });
  });

  it('should strip an export prefix', () => {
    const parsed = parseEnvContent('export FOO=bar\n');
    assert.strictEqual(parsed.FOO, 'bar');
  });

  it('should split at the first = only', () => {
    const parsed = parseEnvContent('URI=mongodb://user:pass@host/?a=1&b=2\n');
    assert.strictEqual(parsed.URI, 'mongodb://user:pass@host/?a=1&b=2');
  });

  it('should strip matching single, double, and back quotes', () => {
    const parsed = parseEnvContent('A="double"\nB=\'single\'\nC=`back`\n');
    assert.strictEqual(parsed.A, 'double');
    assert.strictEqual(parsed.B, 'single');
    assert.strictEqual(parsed.C, 'back');
  });

  it('should keep a # inside a quoted value', () => {
    const parsed = parseEnvContent('PASS="a#b"\n');
    assert.strictEqual(parsed.PASS, 'a#b');
  });

  it('should strip an inline comment after an unquoted value', () => {
    const parsed = parseEnvContent('PORT=3000 # production port\n');
    assert.strictEqual(parsed.PORT, '3000');
  });

  it('should treat a whole-value comment as an empty value', () => {
    const parsed = parseEnvContent('EMPTY=# nothing here\n');
    assert.strictEqual(parsed.EMPTY, '');
  });

  it('should keep a # not preceded by whitespace as part of the value', () => {
    const parsed = parseEnvContent('COLOR=abc#def\n');
    assert.strictEqual(parsed.COLOR, 'abc#def');
  });

  it('should skip lines without = and keys with invalid characters', () => {
    const parsed = parseEnvContent('JUSTAWORD\nMY KEY=1\n=novalue\nOK=1\n');
    assert.deepStrictEqual({ ...parsed }, { OK: '1' });
  });

  it('should handle CRLF line endings', () => {
    const parsed = parseEnvContent('FOO=bar\r\nBAZ=qux\r\n');
    assert.strictEqual(parsed.FOO, 'bar');
    assert.strictEqual(parsed.BAZ, 'qux');
  });

  it('should keep a mismatched quote literal', () => {
    const parsed = parseEnvContent('A="unterminated\n');
    assert.strictEqual(parsed.A, '"unterminated');
  });
});

describe('applyEnvFile', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'migronaut-env-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('should load keys into the target env object', () => {
    const file = path.join(tmp, '.env');
    writeFileSync(file, 'FOO=bar\nBAZ=qux\n');
    const env = {};
    applyEnvFile(file, env);
    assert.strictEqual(env.FOO, 'bar');
    assert.strictEqual(env.BAZ, 'qux');
  });

  it('should never override keys that are already set', () => {
    const file = path.join(tmp, '.env');
    writeFileSync(file, 'FOO=from-file\nBAZ=from-file\n');
    const env = { FOO: 'from-process' };
    applyEnvFile(file, env);
    assert.strictEqual(env.FOO, 'from-process');
    assert.strictEqual(env.BAZ, 'from-file');
  });

  it('should be a no-op when the file does not exist', () => {
    const env = {};
    applyEnvFile(path.join(tmp, 'missing.env'), env);
    assert.deepStrictEqual(env, {});
  });

  it('should default to process.env as the target', () => {
    const key = 'MIGRONAUT_ENV_TEST_UNIQUE_KEY';
    const file = path.join(tmp, '.env');
    writeFileSync(file, `${key}=loaded\n`);
    delete process.env[key];
    try {
      applyEnvFile(file);
      assert.strictEqual(process.env[key], 'loaded');
    } finally {
      delete process.env[key];
    }
  });
});
