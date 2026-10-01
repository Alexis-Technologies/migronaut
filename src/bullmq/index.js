const {
  DEFAULT_QUEUE_NAME,
  DEFAULT_SCHEDULER_ID,
  JOB_DATA_VERSION,
  JOB_NAMES,
  dedupId,
  parseJobData,
} = require('./jobs.js');
const { RETRYABLE_CODES, createMigrationProcessor, isRetryableError } = require('./processor.js');
const { enqueueDown, enqueueUp, planDownJobs, planUpJobs } = require('./producer.js');
const { MigrationQueue, createMigrationQueue } = require('./service.js');
const { waitForGroup } = require('./wait.js');

/**
 * `@alexify/migronaut/bullmq` — migrations as a queue, one migration per job.
 *
 * BullMQ is never required from here: the classes are injected by the caller
 * (`createMigrationQueue({ bullmq: { Queue, Worker } })`), so this entry point
 * costs nothing to anyone who does not use it and pins no BullMQ version.
 */
module.exports = {
  // The service facade — queue, worker, scheduling and status in one object
  createMigrationQueue,
  MigrationQueue,

  // Building blocks, for a Queue/Worker the application already owns
  // (NestJS processors, BullMQ Pro, a shared worker process)
  createMigrationProcessor,
  enqueueUp,
  enqueueDown,
  planUpJobs,
  planDownJobs,
  waitForGroup,

  // The job contract
  JOB_NAMES,
  JOB_DATA_VERSION,
  DEFAULT_QUEUE_NAME,
  DEFAULT_SCHEDULER_ID,
  RETRYABLE_CODES,
  dedupId,
  isRetryableError,
  parseJobData,
};
