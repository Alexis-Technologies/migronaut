const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, it } = require('node:test');
const { computeChecksum } = require('../../src/utils/checksum.js');

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
  it('should produce a deterministic SHA-256 hex digest', async () => {
    const first = await computeChecksum(file);
    const second = await computeChecksum(file);
    assert.strictEqual(first, second);
    assert.match(first, /^[a-f0-9]{64}$/);
  });

  it('should produce a different digest when file contents change', async () => {
    const before = await computeChecksum(file);
    writeFileSync(file, 'export const a = 2;\n');
    const after = await computeChecksum(file);
    assert.notStrictEqual(after, before);
  });
});

describe('computeChecksum normalization', () => {
  // Without normalization a Windows checkout (or `.gitattributes text=auto`)
  // rewrites every line ending and each applied migration reports drift.
  it('should hash CRLF and LF versions of a file identically', async () => {
    writeFileSync(file, 'export const a = 1;\nexport const b = 2;\n');
    const lf = await computeChecksum(file);
    writeFileSync(file, 'export const a = 1;\r\nexport const b = 2;\r\n');
    assert.strictEqual(await computeChecksum(file), lf);
  });

  it('should ignore a leading UTF-8 BOM', async () => {
    writeFileSync(file, 'export const a = 1;\n');
    const plain = await computeChecksum(file);
    writeFileSync(file, '﻿export const a = 1;\n');
    assert.strictEqual(await computeChecksum(file), plain);
  });

  it('should still detect a real content change', async () => {
    writeFileSync(file, 'export const a = 1;\r\n');
    const before = await computeChecksum(file);
    writeFileSync(file, 'export const a = 2;\r\n');
    assert.notStrictEqual(await computeChecksum(file), before);
  });
});
