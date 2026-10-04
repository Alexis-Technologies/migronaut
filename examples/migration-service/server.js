// First, before `node:http` and the MongoDB driver are loaded — see tracing.js.
const { shutdownTracing } = require('./tracing.js');
const http = require('node:http');
const { MigronautError } = require('@alexify/migronaut');
const { connection, mq } = require('./mq.js');

const ROLE = process.env.ROLE ?? 'all';
const PORT = Number(process.env.PORT ?? 3000);
// Loopback unless told otherwise: these endpoints can roll the database back,
// and the example has no authentication (see the README).
const HOST = process.env.HOST ?? '127.0.0.1';
/** How long in-flight requests get to finish on shutdown before they are cut */
const SHUTDOWN_GRACE_MS = 5000;
const MAX_BODY_BYTES = 16 * 1024;
/** How long a `"wait": true` request may hold the connection */
const WAIT_TIMEOUT_MS = 5 * 60_000;

/** A typed error code is all it takes to pick the status — no message parsing */
const STATUS_BY_CODE = {
  CONFIG_INVALID: 400,
  MIGRATION_INVALID_NAME: 400,
  MIGRATION_FILE_NOT_FOUND: 404,
  NOT_APPLIED: 409,
  MIGRATION_BLOCKED: 409,
  MIGRATION_OUT_OF_ORDER: 409,
  MIGRATION_IRREVERSIBLE: 409,
  CHECKSUM_MISMATCH: 409,
  CONVERGE_FAILED: 409,
  QUEUE_JOB_INVALID: 400,
  QUEUE_JOB_FAILED: 409,
  CONNECTION_FAILED: 503,
};

/**
 * The parts of an error's context fit for an HTTP client. The lock holder
 * (host, pid, OS user of another process) is internal detail.
 */
function publicContext(context) {
  if (!context || typeof context !== 'object') return undefined;
  const { holder: _holder, ...rest } = context;
  return rest;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Who asked, and why — recorded on the changelog by the worker. In a real
 * service `requestedBy` comes from the authenticated caller, not the body.
 */
function who({ requestedBy, reason }) {
  return {
    ...(requestedBy !== undefined ? { requestedBy } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body;
}

/** 202 with the group handle, or — with `"wait": true` — 200 once every job has finished */
async function respondWithGroup(res, group, wait) {
  const { wait: waitForGroup, ...handle } = group;
  if (!wait) return send(res, group.upToDate ? 200 : 202, handle);
  const { results, converge } = await waitForGroup({ timeoutMs: WAIT_TIMEOUT_MS });
  return send(res, 200, { ...handle, results, ...(converge ? { converge } : {}) });
}

const routes = {
  'GET /healthz': async (_req, res) =>
    send(res, 200, { ok: true, role: ROLE, worker: mq.worker !== undefined }),

  'GET /migrations/status': async (_req, res) =>
    send(res, 200, { migrations: await mq.status(), lock: await mq.lockInfo() }),

  'GET /migrations/pending': async (_req, res) => send(res, 200, { pending: await mq.pending() }),

  // { "to"?: file, "name"?: file, "force"?: boolean, "wait"?: boolean, "requestedBy"?, "reason"? }
  'POST /migrations/up': async (req, res) => {
    const { name, to, force, wait, ...actor } = await readJson(req);
    const options = who(actor);
    if (to !== undefined) options.to = to;
    if (force !== undefined) options.force = force;
    await respondWithGroup(res, await mq.enqueueUp(name, options), wait === true);
  },

  // { "name"?: file, "steps"?: n, "batch"?: n, "to"?: file, "wait"?: boolean, "requestedBy"?, "reason"? }
  // — default: last batch
  'POST /migrations/down': async (req, res) => {
    const { name, steps, batch, to, wait, ...actor } = await readJson(req);
    const options = who(actor);
    if (steps !== undefined) options.steps = steps;
    if (batch !== undefined) options.batch = batch;
    if (to !== undefined) options.to = to;
    await respondWithGroup(res, await mq.enqueueDown(name, options), wait === true);
  },

  // { "ordered"?: boolean, "wait"?: boolean, "requestedBy"?, "reason"? } — the declared
  // collections, as a job of its own
  'POST /migrations/converge': async (req, res) => {
    const { ordered, wait, ...actor } = await readJson(req);
    const { wait: waitForJob, ...handle } = await mq.enqueueConverge({
      ...who(actor),
      ...(ordered !== undefined ? { ordered } : {}),
    });
    if (wait !== true) return send(res, 202, handle);
    return send(res, 200, { ...handle, result: await waitForJob({ timeoutMs: WAIT_TIMEOUT_MS }) });
  },

  'POST /migrations/pause': async (_req, res) => {
    await mq.pause();
    send(res, 200, { paused: true });
  },

  'POST /migrations/resume': async (_req, res) => {
    await mq.resume();
    send(res, 200, { paused: false });
  },

  // { "every": ms } or { "pattern": cron, "tz"?: zone } — keep the database migrated on a schedule
  'PUT /migrations/schedule': async (req, res) => {
    const { every, pattern, tz } = await readJson(req);
    const options = {};
    if (every !== undefined) options.every = every;
    if (pattern !== undefined) options.pattern = pattern;
    if (tz !== undefined) options.tz = tz;
    await mq.schedule(options);
    send(res, 200, { scheduled: true });
  },

  'DELETE /migrations/schedule': async (_req, res) =>
    send(res, 200, { removed: await mq.unschedule() }),
};

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const jobMatch = req.method === 'GET' && /^\/migrations\/jobs\/([^/]+)$/.exec(pathname);
  if (jobMatch) {
    let id;
    try {
      id = decodeURIComponent(jobMatch[1]);
    } catch {
      throw new HttpError(400, 'Malformed job id');
    }
    const job = await mq.getJob(id);
    return job ? send(res, 200, job) : send(res, 404, { error: { message: 'No such job' } });
  }
  const route = routes[`${req.method} ${pathname}`];
  if (!route) return send(res, 404, { error: { message: 'Not found' } });
  return route(req, res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (error instanceof MigronautError) {
      // Messages and context are already redacted by migronaut. A failed wait
      // carries the job's own code (MIGRATION_BLOCKED, …), which picks the
      // status better than QUEUE_JOB_FAILED alone.
      const status = STATUS_BY_CODE[error.context?.code] ?? STATUS_BY_CODE[error.code] ?? 500;
      return send(res, status, {
        error: { code: error.code, message: error.message, context: publicContext(error.context) },
      });
    }
    if (error instanceof HttpError) {
      return send(res, error.status, { error: { message: error.message } });
    }
    console.error(error);
    return send(res, 500, { error: { message: 'Internal error' } });
  });
});

async function main() {
  if (ROLE === 'worker' || ROLE === 'all') {
    // Connects to MongoDB first: a worker that cannot reach it fails here.
    await mq.startWorker();
    console.log(`worker started on queue "${mq.queueName}"`);
  }
  if (ROLE === 'api' || ROLE === 'all') {
    await new Promise((resolve) => server.listen(PORT, HOST, resolve));
    console.log(`api listening on http://${HOST}:${PORT}`);
  }
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down`);
  // Stop accepting requests and stop the worker at the same time: a pending
  // `"wait": true` request must not keep the worker taking new jobs. A job
  // that had not started its migration goes back to the queue; one that had
  // finishes. Requests still open after the grace period are cut.
  const grace = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
  try {
    await Promise.all([
      server.listening ? new Promise((resolve) => server.close(resolve)) : undefined,
      mq.close(),
    ]);
  } finally {
    clearTimeout(grace);
    // Whatever closing the queue did, release the rest — and last the spans of
    // the migration that just finished, still in the exporter's batch, which
    // process.exit() below would drop.
    await connection.quit().catch(() => undefined);
    await shutdownTracing();
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    shutdown(signal).then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
