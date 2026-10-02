// First, before `node:http` and the MongoDB driver are loaded — see tracing.js.
const { shutdownTracing } = require('./tracing.js');
const http = require('node:http');
const { MigronautError } = require('@alexify/migronaut');
const { connection, mq } = require('./mq.js');

const ROLE = process.env.ROLE ?? 'all';
const PORT = Number(process.env.PORT ?? 3000);
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
  CONNECTION_FAILED: 503,
};

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
  const { results } = await waitForGroup({ timeoutMs: WAIT_TIMEOUT_MS });
  return send(res, 200, { ...handle, results });
}

const routes = {
  'GET /healthz': async (_req, res) =>
    send(res, 200, { ok: true, role: ROLE, worker: mq.worker !== undefined }),

  'GET /migrations/status': async (_req, res) =>
    send(res, 200, { migrations: await mq.status(), lock: await mq.lockInfo() }),

  'GET /migrations/pending': async (_req, res) => send(res, 200, { pending: await mq.pending() }),

  // { "to"?: file, "name"?: file, "force"?: boolean, "wait"?: boolean }
  'POST /migrations/up': async (req, res) => {
    const { name, to, force, wait } = await readJson(req);
    const options = {};
    if (to !== undefined) options.to = to;
    if (force !== undefined) options.force = force;
    await respondWithGroup(res, await mq.enqueueUp(name, options), wait === true);
  },

  // { "name"?: file, "steps"?: n, "batch"?: n, "to"?: file, "wait"?: boolean } — default: last batch
  'POST /migrations/down': async (req, res) => {
    const { name, steps, batch, to, wait } = await readJson(req);
    const options = {};
    if (steps !== undefined) options.steps = steps;
    if (batch !== undefined) options.batch = batch;
    if (to !== undefined) options.to = to;
    await respondWithGroup(res, await mq.enqueueDown(name, options), wait === true);
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
    const job = await mq.getJob(decodeURIComponent(jobMatch[1]));
    return job ? send(res, 200, job) : send(res, 404, { error: { message: 'No such job' } });
  }
  const route = routes[`${req.method} ${pathname}`];
  if (!route) return send(res, 404, { error: { message: 'Not found' } });
  return route(req, res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (error instanceof MigronautError) {
      // Messages and context are already redacted by migronaut — safe to return.
      const status = STATUS_BY_CODE[error.code] ?? 500;
      return send(res, status, {
        error: { code: error.code, message: error.message, context: error.context },
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
    await new Promise((resolve) => server.listen(PORT, resolve));
    console.log(`api listening on http://127.0.0.1:${PORT}`);
  }
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down`);
  // Stop accepting requests, let the migration in flight finish, then release
  // everything this process opened — in that order.
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await mq.close();
  await connection.quit();
  // Last: the spans of the migration that just finished are still in the
  // exporter's batch, and process.exit() below would drop them.
  await shutdownTracing();
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
