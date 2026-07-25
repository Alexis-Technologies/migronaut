const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, it } = require('node:test');
const { computeChecksum, verifyChecksum } = require('../../src/utils/checksum.js');

let tmp;
let file;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'migronaut-checksum-'));
  file = path.join(tmp, 'migration.ts');
  writeFileSync(file, 'export const a = 1;\n');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('computeChecksum', () => {
  it('should produce a deterministic SHA-256 hex digest', () => {
    const first = computeChecksum(file);
    const second = computeChecksum(file);
    assert.strictEqual(first, second);
    assert.match(first, /^[a-f0-9]{64}$/);
  });

  it('should produce a different digest when file contents change', () => {
    const before = computeChecksum(file);
    writeFileSync(file, 'export const a = 2;\n');
    const after = computeChecksum(file);
    assert.notStrictEqual(after, before);
  });
});

describe('verifyChecksum', () => {
  it('should return true when the stored checksum matches', () => {
    const stored = computeChecksum(file);
    assert.strictEqual(verifyChecksum(file, stored), true);
  });

  it('should return false when the file has been tampered with', () => {
    const stored = computeChecksum(file);
    writeFileSync(file, 'export const a = 999;\n');
    assert.strictEqual(verifyChecksum(file, stored), false);
  });
});
