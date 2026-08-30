const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { sanitize, sanitizeTerminal } = require('../../src/utils/sanitize.js');

const chr = (code) => String.fromCharCode(code);
const ESC = chr(0x1b);

describe('sanitize', () => {
  it('should strip C0 controls, DEL and the whole C1 block', () => {
    // The C1 escape introducers are single codepoints on terminals that decode
    // C1: DCS (90), CSI (9B), OSC (9D), PM (9E), APC (9F) — all must go.
    for (const code of [0x00, 0x08, 0x0b, 0x1b, 0x1f, 0x7f, 0x80, 0x90, 0x9b, 0x9d, 0x9e, 0x9f]) {
      assert.strictEqual(
        sanitize(`a${chr(code)}b`),
        'ab',
        `U+${code.toString(16).padStart(4, '0')} must be stripped`,
      );
    }
  });

  it('should keep tab, newline and ordinary text', () => {
    assert.strictEqual(sanitize('a\tb\nc'), 'a\tb\nc');
    assert.strictEqual(sanitize('20240101-add-users.ts'), '20240101-add-users.ts');
  });
});

describe('sanitizeTerminal', () => {
  it('should preserve SGR color sequences while stripping C1 controls', () => {
    const colored = `${ESC}[33mwarn${ESC}[0m`;
    assert.strictEqual(sanitizeTerminal(colored), colored);
    assert.strictEqual(sanitizeTerminal(`x${chr(0x9d)}y`), 'xy');
  });

  it('should strip non-SGR escape sequences', () => {
    // Cursor movement is not SGR — only color styling survives.
    assert.strictEqual(sanitizeTerminal(`a${ESC}[2Jb`), 'a[2Jb');
  });
});
