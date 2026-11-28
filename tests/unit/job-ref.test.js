const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { JOB_REF_LIMITS, toJobFields, checkJobRef } = require('../../src/utils/job-ref.js');

describe('checkJobRef', () => {
  it('should accept an absent reference, and { id } with or without a group', () => {
    assert.strictEqual(checkJobRef(undefined), null);
    assert.strictEqual(checkJobRef({ id: '17' }), null);
    assert.strictEqual(checkJobRef({ id: '17', groupId: 'g-1' }), null);
    assert.strictEqual(checkJobRef(Object.assign(Object.create(null), { id: '1' })), null);
  });

  it('should refuse what is not an object', () => {
    for (const value of [null, '17', 17, ['17']]) {
      assert.match(checkJobRef(value), /job must be an object/);
    }
  });

  it('should require the id and refuse unknown keys', () => {
    assert.strictEqual(checkJobRef({}), 'job.id is required');
    assert.strictEqual(checkJobRef({ groupId: 'g' }), 'job.id is required');
    assert.strictEqual(checkJobRef({ id: '1', queue: 'q' }), 'job.queue is not an option');
  });

  it('should refuse keys the limits only inherit', () => {
    assert.strictEqual(
      checkJobRef({ id: '1', constructor: 'x' }),
      'job.constructor is not an option',
    );
    assert.strictEqual(checkJobRef({ id: '1', toString: 5 }), 'job.toString is not an option');
    assert.strictEqual(
      checkJobRef(JSON.parse('{"id": "1", "__proto__": "x"}')),
      'job.__proto__ is not an option',
    );
  });

  it('should refuse a group where none is allowed', () => {
    assert.strictEqual(
      checkJobRef({ id: '1', groupId: 'g' }, { groupId: false }),
      'job.groupId is not an option',
    );
  });

  it('should bound both values', () => {
    assert.match(checkJobRef({ id: '' }), /job\.id must be a non-empty string/);
    assert.match(checkJobRef({ id: 7 }), /job\.id must be a non-empty string/);
    assert.match(checkJobRef({ id: 'x'.repeat(JOB_REF_LIMITS.id + 1) }), /at most 1024 characters/);
    assert.strictEqual(checkJobRef({ id: 'x'.repeat(JOB_REF_LIMITS.id) }), null);
    assert.match(
      checkJobRef({ id: '1', groupId: 'g'.repeat(JOB_REF_LIMITS.groupId + 1) }),
      /job\.groupId must be a non-empty string of at most 128 characters/,
    );
  });
});

describe('toJobFields', () => {
  it('should map a reference onto correlation fields', () => {
    assert.deepStrictEqual(toJobFields(undefined), {});
    assert.deepStrictEqual(toJobFields({ id: '17' }), { jobId: '17' });
    assert.deepStrictEqual(toJobFields({ id: '17', groupId: 'g' }), { jobId: '17', groupId: 'g' });
  });
});
