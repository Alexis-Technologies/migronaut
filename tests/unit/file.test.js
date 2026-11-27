const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const { MAX_SMALL_FILE_BYTES, readSmallFile } = require('../../src/utils/file.js');

const dir = mkdtempSync(path.join(tmpdir(), 'migronaut-file-'));

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readSmallFile', () => {
  it('should read a regular file whole, as text', async () => {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, '{"dbName":"shop"}');
    assert.strictEqual(await readSmallFile(file, 'Config file'), '{"dbName":"shop"}');
  });

  it('should leave a missing file to the caller, as ENOENT', async () => {
    await assert.rejects(readSmallFile(path.join(dir, 'nope'), 'env file'), { code: 'ENOENT' });
  });

  it('should refuse a directory and a file past the cap, naming the file', async () => {
    await assert.rejects(readSmallFile(dir, 'env file'), {
      code: 'ALX_ERR_CONFIG_INVALID',
      message: 'env file is not a regular file',
    });
    const big = path.join(dir, 'big.env');
    writeFileSync(big, Buffer.alloc(MAX_SMALL_FILE_BYTES + 1, 'a'));
    await assert.rejects(readSmallFile(big, 'Template file'), {
      code: 'ALX_ERR_CONFIG_INVALID',
      message: 'Template file is too large (max 1 MB)',
    });
  });

  it(
    'should refuse a FIFO at once instead of waiting for a writer',
    { skip: process.platform === 'win32' && 'no FIFOs on Windows' },
    async () => {
      const fifo = path.join(dir, 'pipe.env');
      execFileSync('mkfifo', [fifo]);
      const started = Date.now();
      await assert.rejects(readSmallFile(fifo, 'env file'), {
        message: 'env file is not a regular file',
      });
      assert.ok(Date.now() - started < 1000, 'the open did not block');
    },
  );
});
