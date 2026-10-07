const { isPlainObject } = require('./canonical.js');
const { MAX_ID_LENGTH } = require('./id.js');

/**
 * The queue job a run works for: `job: { id, groupId? }` on `up`, `down` and
 * `redo` (a background lane's slice takes `{ id }`). It is bound into
 * `ctx.run`, the run's log lines and every `migration:log` event, so what a
 * migration logs can be joined to the job a dashboard shows — nothing is
 * stored. The one definition of its limits, shared by the kit's options and
 * the queue adapter, which must never pass what the kit refuses.
 *
 * `id` allows a custom BullMQ job id (they can be long); `groupId` is minted
 * by the kit's own id generator, so it has that generator's bound.
 */
const JOB_REF_LIMITS = Object.freeze({ id: 1024, groupId: MAX_ID_LENGTH });

/**
 * The problem with a job reference, or null when it is absent or valid.
 * `groupId: false` refuses that key (a lane has no group).
 */
function jobRefIssue(job, { groupId = true } = {}) {
  if (job === undefined) return null;
  if (!isPlainObject(job)) return 'job must be an object: { id, groupId? }';
  for (const key of Object.keys(job)) {
    const max = JOB_REF_LIMITS[key];
    if (max === undefined || (key === 'groupId' && !groupId)) return `job.${key} is not an option`;
    const value = job[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > max) {
      return `job.${key} must be a non-empty string of at most ${max} characters`;
    }
  }
  return job.id === undefined ? 'job.id is required' : null;
}

/** What a valid job reference adds to a run's correlation: `{ jobId, groupId? }` */
function jobFields(job) {
  if (job === undefined) return {};
  return { jobId: job.id, ...(job.groupId !== undefined ? { groupId: job.groupId } : {}) };
}

module.exports = { JOB_REF_LIMITS, jobFields, jobRefIssue };
