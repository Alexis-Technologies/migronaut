const os = require('node:os');

const { resolveUsername } = require('../../utils/user.js');
const { assertHistoryLimit } = require('../options.js');
const { readShardKey } = require('../shard-info.js');
const { ConvergeLog } = require('./log.js');

/**
 * The declared collections' side of one MigratorKit: what a converge run
 * works with (`deps`), how it treats search indexes, and the converge
 * history. The run itself — under the migration lock, after `up` or on its
 * own — is the kit's. It reaches the kit through the adapter the kit builds
 * for its hosts (see background/host.js).
 */
class ConvergeHost {
  #kit;
  /** The converge history store, created on first use */
  #logStore = null;

  constructor(kit) {
    this.#kit = kit;
  }

  /** How converge treats search indexes: the config, and a call's own `waitForSearchIndexes` */
  searchOptions(options = {}) {
    const config = this.#kit.config;
    return {
      onUnavailable: config.onSearchUnavailable,
      wait: options.waitForSearchIndexes ?? config.waitForSearchIndexes,
      waitTimeoutMs: config.searchIndexWaitTimeoutMs,
    };
  }

  /** What runConverge works with; `lock` (a run's) lets it give the lock up before waiting */
  deps(lock) {
    const kit = this.#kit;
    const db = kit.requireDb();
    return {
      db,
      ...(lock ? { releaseLock: () => lock.release() } : {}),
      recordSearchWait: (waitedMs, outcome) => kit.telemetry.searchWaited({ waitedMs, outcome }),
      logger: kit.logger,
      fields: (extra) => kit.fields(extra),
      emit: (event, payload) => kit.emit(event, payload),
      assertNotAborted: (abortSignal) => kit.assertNotAborted(abortSignal),
      // The history entry's who-and-where, like a changelog record's.
      audit: () => {
        return {
          ...(kit.runId ? { runId: kit.runId } : {}),
          executedBy: resolveUsername(),
          host: os.hostname(),
          environment: kit.environment(),
        };
      },
      record: (entry) => this.#log().append(db, entry, { ensureIndex: kit.config.ensureIndexes }),
      // Behind a mongos only: the shard key — so prune never drops its index,
      // and the version index takes it as a prefix. An 8.0 `unsplittable`
      // collection is not sharded; `undefined` when config may not be read.
      shardKeyOf: async (name) => {
        const sharding = await readShardKey(kit.client, db.databaseName, name);
        return sharding === undefined ? undefined : (sharding?.key ?? null);
      },
    };
  }

  #log() {
    this.#logStore ??= new ConvergeLog(this.#kit.config.convergeLogCollection);
    return this.#logStore;
  }

  /**
   * The converge history, newest first: one entry per converge that changed
   * something or failed — when, triggered how, by whom and why, and every
   * index or validator it touched, with its before and after. Read-only.
   */
  async history(options = {}) {
    const { limit = 20 } = options;
    assertHistoryLimit(limit);
    await this.#kit.ensureConfig();
    await this.#kit.connect();
    return this.#log().list(this.#kit.requireDb(), limit);
  }
}

module.exports = { ConvergeHost };
