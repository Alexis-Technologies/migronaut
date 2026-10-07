const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { JOB_REF_LIMITS, jobFields, jobRefIssue } = require('../../src/utils/job-ref.js');

describe('jobRefIssue', () => {
  it('should accept an absent reference, and { id } with or without a group', () => {
    assert.strictEqual(jobRefIssue(undefined), null);
    assert.strictEqual(jobRefIssue({ id: '17' }), null);
    assert.strictEqual(jobRefIssue({ id: '17', groupId: 'g-1' }), null);
    assert.strictEqual(jobRefIssue(Object.assign(Object.create(null), { id: '1' })), null);
  });

  it('should refuse what is not an object', () => {
    for (const value of [null, '17', 17, ['17']]) {
      assert.match(jobRefIssue(value), /job must be an object/);
    }
  });

  it('should require the id and refuse unknown keys', () => {
    assert.strictEqual(jobRefIssue({}), 'job.id is required');
    assert.strictEqual(jobRefIssue({ groupId: 'g' }), 'job.id is required');
    assert.strictEqual(jobRefIssue({ id: '1', queue: 'q' }), 'job.queue is not an option');
  });

  it('should refuse keys the limits only inherit', () => {
    assert.strictEqual(
      jobRefIssue({ id: '1', constructor: 'x' }),
      'job.constructor is not an option',
    );
    assert.strictEqual(jobRefIssue({ id: '1', toString: 5 }), 'job.toString is not an option');
    assert.strictEqual(
      jobRefIssue(JSON.parse('{"id": "1", "__proto__": "x"}')),
      'job.__proto__ is not an option',
    );
  });

  it('should refuse a group where none is allowed', () => {
    assert.strictEqual(
      jobRefIssue({ id: '1', groupId: 'g' }, { groupId: false }),
      'job.groupId is not an option',
    );
  });

  it('should bound both values', () => {
    assert.match(jobRefIssue({ id: '' }), /job\.id must be a non-empty string/);
    assert.match(jobRefIssue({ id: 7 }), /job\.id must be a non-empty string/);
    assert.match(jobRefIssue({ id: 'x'.repeat(JOB_REF_LIMITS.id + 1) }), /at most 1024 characters/);
    assert.strictEqual(jobRefIssue({ id: 'x'.repeat(JOB_REF_LIMITS.id) }), null);
    assert.match(
      jobRefIssue({ id: '1', groupId: 'g'.repeat(JOB_REF_LIMITS.groupId + 1) }),
      /job\.groupId must be a non-empty string of at most 128 characters/,
    );
  });
});

describe('jobFields', () => {
  it('should map a reference onto correlation fields', () => {
    assert.deepStrictEqual(jobFields(undefined), {});
    assert.deepStrictEqual(jobFields({ id: '17' }), { jobId: '17' });
    assert.deepStrictEqual(jobFields({ id: '17', groupId: 'g' }), { jobId: '17', groupId: 'g' });
  });
});
