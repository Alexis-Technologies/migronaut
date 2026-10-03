const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it, mock } = require('node:test');
const { MongoClient } = require('mongodb');
const {
  ChecksumMismatchError,
  MigrationBlockedError,
  MigrationFileNotFoundError,
  NotAppliedError,
  OutOfOrderMigrationError,
} = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_sequenced_test';
const CHANGELOG = '_migronaut_migrations';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
});

let project;
let migrator;

afterEach(async () => {
  await migrator?.disconnect();
  project?.cleanup();
});

function setup(overrides = {}) {
  project = makeProject();
  migrator = makeMigrator(mongo.uri, DB, project.dir, overrides);
}

function three() {
  project.write('0001-a.js', insertMigration('things', 'a'));
  project.write('0002-b.js', insertMigration('things', 'b'));
  project.write('0003-c.js', insertMigration('things', 'c'));
}

const markers = async () =>
  (await mongo.db.collection('things').find().sort({ _id: 1 }).toArray()).map((doc) => doc.marker);
const batches = async () =>
  (await mongo.db.collection(CHANGELOG).find().sort({ name: 1 }).toArray()).map((record) => [
    record.name,
    record.status,
    record.batch,
  ]);

/**
 * What lets one logical run be split into single-file runs driven from outside
 * (a queue job per migration) without losing what a bulk run guarantees: a
 * shared batch, and the order.
 */
describe('sequenced single-file runs (integration)', () => {
  describe('nextBatch()', () => {
    it('should be 1 on an empty changelog, connecting on its own', async () => {
      setup();
      assert.strictEqual(await migrator.nextBatch(), 1);
    });

    it('should follow the highest batch ever used — reverted ones included', async () => {
      setup();
      three();
      await migrator.up();
      assert.strictEqual(await migrator.nextBatch(), 2);
      await migrator.down();
      // The rolled-back number is never handed out again.
      assert.strictEqual(await migrator.nextBatch(), 2);
      await migrator.up();
      assert.strictEqual(await migrator.nextBatch(), 3);
    });

    it('should be a peek: asking does not consume the number', async () => {
      setup();
      assert.strictEqual(await migrator.nextBatch(), 1);
      assert.strictEqual(await migrator.nextBatch(), 1);
    });
  });

  describe('up({ batch })', () => {
    it('should stamp the given batch on a bulk run', async () => {
      setup();
      three();
      const results = await migrator.up(undefined, { batch: 42 });
      assert.deepStrictEqual(
        results.map((row) => row.batch),
        [42, 42, 42],
      );
      assert.strictEqual(await migrator.nextBatch(), 43);
    });

    it('should let several single-file runs share one batch — one rollback unit', async () => {
      setup();
      three();
      const batch = await migrator.nextBatch();
      for (const name of ['0001-a.js', '0002-b.js', '0003-c.js']) {
        await migrator.up(name, { batch });
      }
      assert.deepStrictEqual(await batches(), [
        ['0001-a.js', 'applied', 1],
        ['0002-b.js', 'applied', 1],
        ['0003-c.js', 'applied', 1],
      ]);
      // The point of sharing it: a plain `down` reverts all three together.
      const reverted = await migrator.down();
      assert.strictEqual(reverted.length, 3);
      assert.deepStrictEqual(await markers(), []);
    });

    it('should accept a batch at or below the current maximum — it is a label', async () => {
      setup();
      three();
      await migrator.up('0001-a.js');
      await migrator.up('0002-b.js');
      assert.strictEqual(await migrator.nextBatch(), 3);
      await migrator.up('0003-c.js', { batch: 1 });
      assert.deepStrictEqual((await batches())[2], ['0003-c.js', 'applied', 1]);
    });

    it('should combine with `to`', async () => {
      setup();
      three();
      const results = await migrator.up(undefined, { to: '0002-b.js', batch: 9 });
      assert.deepStrictEqual(
        results.map((row) => [row.file, row.batch]),
        [
          ['0001-a.js', 9],
          ['0002-b.js', 9],
        ],
      );
    });

    it('should re-stamp a forced re-run', async () => {
      setup();
      three();
      await migrator.up();
      await migrator.up('0001-a.js', { force: true, batch: 7 });
      assert.deepStrictEqual((await batches())[0], ['0001-a.js', 'applied', 7]);
    });
  });

  describe('up({ ordered })', () => {
    it('should refuse a file while an earlier one is pending — and touch nothing', async () => {
      const hooks = [];
      setup({ hooks: { beforeAll: () => hooks.push('beforeAll') } });
      three();
      await assert.rejects(migrator.up('0003-c.js', { ordered: true }), (error) => {
        assert.ok(error instanceof MigrationBlockedError);
        assert.strictEqual(error.code, 'MIGRATION_BLOCKED');
        assert.deepStrictEqual(error.context, {
          name: '0003-c.js',
          direction: 'up',
          blockedBy: ['0001-a.js', '0002-b.js'],
          // None of them failed: they may simply be in flight elsewhere.
          failed: [],
        });
        return true;
      });
      assert.deepStrictEqual(await markers(), []);
      assert.deepStrictEqual(await batches(), []);
      assert.deepStrictEqual(hooks, [], 'a blocked run fires no hooks');
      // The lock was taken for the check and released again.
      assert.strictEqual(await migrator.lockInfo(), null);
    });

    it('should apply the files one by one when they come in order', async () => {
      setup();
      three();
      for (const name of ['0001-a.js', '0002-b.js', '0003-c.js']) {
        const [row] = await migrator.up(name, { ordered: true });
        assert.strictEqual(row.status, 'applied');
      }
      assert.deepStrictEqual(await markers(), ['a', 'b', 'c']);
    });

    it('should count a failed earlier migration as still pending', async () => {
      setup();
      project.write(
        '0001-a.js',
        'export async function up() { throw new Error("nope"); }\nexport async function down() {}\n',
      );
      project.write('0002-b.js', insertMigration('things', 'b'));
      await assert.rejects(migrator.up('0001-a.js'));
      await assert.rejects(migrator.up('0002-b.js', { ordered: true }), (error) => {
        assert.ok(error instanceof MigrationBlockedError);
        assert.deepStrictEqual(error.context.blockedBy, ['0001-a.js']);
        // The failed trace is what tells a stopped line from one in flight.
        assert.deepStrictEqual(error.context.failed, ['0001-a.js']);
        return true;
      });
    });

    it('should skip an already-applied file as usual instead of calling it blocked', async () => {
      setup();
      three();
      await migrator.up('0002-b.js');
      // 0001 is pending, but 0002 is done: a duplicate request is a no-op.
      const [row] = await migrator.up('0002-b.js', { ordered: true });
      assert.strictEqual(row.status, 'skipped');
    });

    it('should still block a forced re-run that is out of sequence', async () => {
      setup();
      three();
      await migrator.up('0002-b.js');
      await assert.rejects(
        migrator.up('0002-b.js', { ordered: true, force: true }),
        MigrationBlockedError,
      );
      assert.deepStrictEqual(await markers(), ['b']);
    });

    it('should refuse a target outside the sequence before importing it', async () => {
      setup();
      three();
      // Files that sit next to the migrations without being any: importing
      // one would run its top-level code.
      const sideEffect = (marker) =>
        `require('node:fs').writeFileSync(${JSON.stringify(`${project.dir}/ran-`)} + ${JSON.stringify(marker)}, '');\n` +
        'module.exports = { up() {}, down() {} };\n';
      project.write('.hidden.js', sideEffect('hidden'));
      project.write('helpers.cjs', sideEffect('helpers'));
      project.write('types.d.ts', 'export {};\n');
      for (const name of ['.hidden.js', 'helpers.cjs', 'types.d.ts']) {
        await assert.rejects(migrator.up(name, { ordered: true }), (error) => {
          assert.ok(error instanceof MigrationFileNotFoundError, name);
          assert.match(error.message, /Not a migration of the sequence/);
          return true;
        });
      }
      assert.deepStrictEqual(
        require('node:fs')
          .readdirSync(project.dir)
          .filter((file) => file.startsWith('ran-')),
        [],
        'nothing outside the sequence was imported',
      );
      assert.deepStrictEqual(await batches(), []);
    });

    it('should apply a file only in the version it was planned with', async () => {
      setup();
      three();
      const [planned] = await migrator.dryRun('up', '0001-a.js');
      assert.match(planned.checksum, /^[0-9a-f]{64}$/);
      project.write('0001-a.js', insertMigration('things', 'a-edited'));
      await assert.rejects(
        migrator.up('0001-a.js', { ordered: true, checksum: planned.checksum }),
        (error) => {
          assert.ok(error instanceof ChecksumMismatchError);
          assert.strictEqual(error.context.planned, true);
          assert.strictEqual(error.context.expected, planned.checksum);
          return true;
        },
      );
      assert.deepStrictEqual(await batches(), [], 'nothing applied, nothing recorded');
      const [current] = await migrator.dryRun('up', '0001-a.js');
      const [row] = await migrator.up('0001-a.js', { ordered: true, checksum: current.checksum });
      assert.strictEqual(row.status, 'applied');
      // Already applied: a duplicate job is skipped whatever it planned with.
      const [again] = await migrator.up('0001-a.js', { checksum: planned.checksum });
      assert.strictEqual(again.status, 'skipped');
      await assert.rejects(migrator.up(undefined, { checksum: current.checksum }), /filename/);
      await assert.rejects(migrator.up('0002-b.js', { checksum: 'nope' }), /SHA-256/);
    });

    it('should leave an unordered single-file run exactly as it was', async () => {
      setup();
      three();
      const [row] = await migrator.up('0003-c.js');
      assert.strictEqual(row.status, 'applied');
      const [explicit] = await migrator.up('0002-b.js', { ordered: false });
      assert.strictEqual(explicit.status, 'applied');
    });

    it('should apply the strict drift check a bulk run would', async () => {
      setup({ strict: true });
      three();
      await migrator.up('0001-a.js', { ordered: true });
      project.tamper('0001-a.js');
      // Without `ordered`, a single-file run never looks at other files.
      await assert.rejects(
        migrator.up('0002-b.js', { ordered: true }),
        (error) => error instanceof ChecksumMismatchError && error.context.name === '0001-a.js',
      );
      assert.deepStrictEqual(await markers(), ['a']);
    });

    describe('with a file merged late', () => {
      /** 0002 applied first; 0001 then arrives from a parallel branch */
      async function lateArrival(overrides) {
        setup(overrides);
        project.write('0002-b.js', insertMigration('things', 'b'));
        await migrator.up();
        project.write('0001-a.js', insertMigration('things', 'a'));
        project.write('0003-c.js', insertMigration('things', 'c'));
      }

      it('should block later files until the late one is applied', async () => {
        await lateArrival();
        await assert.rejects(migrator.up('0003-c.js', { ordered: true }), (error) => {
          assert.deepStrictEqual(error.context.blockedBy, ['0001-a.js']);
          return true;
        });
        await migrator.up('0001-a.js', { ordered: true });
        await migrator.up('0003-c.js', { ordered: true });
        assert.deepStrictEqual(await markers(), ['b', 'a', 'c']);
      });

      it("should honour onOutOfOrder: 'error' for the late file itself", async () => {
        await lateArrival({ onOutOfOrder: 'error' });
        await assert.rejects(migrator.up('0001-a.js', { ordered: true }), (error) => {
          assert.ok(error instanceof OutOfOrderMigrationError);
          assert.deepStrictEqual(error.context.names, ['0001-a.js']);
          return true;
        });
        // The plain single-file run stays the deliberate, exempt path.
        const [row] = await migrator.up('0001-a.js');
        assert.strictEqual(row.status, 'applied');
      });
    });
  });

  describe('down({ ordered })', () => {
    it('should refuse to revert under migrations applied later', async () => {
      setup();
      three();
      await migrator.up();
      await assert.rejects(migrator.down('0001-a.js', { ordered: true }), (error) => {
        assert.ok(error instanceof MigrationBlockedError);
        assert.deepStrictEqual(error.context, {
          name: '0001-a.js',
          direction: 'down',
          blockedBy: ['0003-c.js', '0002-b.js'],
          failed: [],
        });
        return true;
      });
      assert.deepStrictEqual(await markers(), ['a', 'b', 'c']);
    });

    it('should revert newest-first, one file at a time', async () => {
      setup();
      three();
      await migrator.up();
      for (const name of ['0003-c.js', '0002-b.js', '0001-a.js']) {
        const [row] = await migrator.down(name, { ordered: true });
        assert.strictEqual(row.status, 'reverted');
      }
      assert.deepStrictEqual(await markers(), []);
    });

    it('should judge "later" by when it was applied, not by name', async () => {
      setup();
      project.write('0002-b.js', insertMigration('things', 'b'));
      await migrator.up();
      project.write('0001-a.js', insertMigration('things', 'a'));
      await migrator.up();
      // 0001 sorts first but was applied last: it is the top of the stack.
      await assert.rejects(migrator.down('0002-b.js', { ordered: true }), (error) => {
        assert.deepStrictEqual(error.context.blockedBy, ['0001-a.js']);
        return true;
      });
      const [row] = await migrator.down('0001-a.js', { ordered: true });
      assert.strictEqual(row.status, 'reverted');
    });

    it('should report a file that is not applied before any ordering verdict', async () => {
      setup();
      three();
      await migrator.up();
      await migrator.down('0003-c.js');
      await assert.rejects(migrator.down('0003-c.js', { ordered: true }), NotAppliedError);
    });

    it('should treat a record with no appliedAt as blocked by everything else', async () => {
      setup();
      three();
      await migrator.up();
      await mongo.db
        .collection(CHANGELOG)
        .updateOne({ name: '0003-c.js' }, { $unset: { appliedAt: '' } });
      await assert.rejects(migrator.down('0003-c.js', { ordered: true }), (error) => {
        assert.deepStrictEqual([...error.context.blockedBy].sort(), ['0001-a.js', '0002-b.js']);
        return true;
      });
    });

    it('should leave an unordered rollback exactly as it was', async () => {
      setup();
      three();
      await migrator.up();
      const [row] = await migrator.down('0001-a.js');
      assert.strictEqual(row.status, 'reverted');
    });
  });

  describe("dryRun('up') and the order policy", () => {
    async function lateArrival(overrides) {
      setup(overrides);
      project.write('0002-b.js', insertMigration('things', 'b'));
      await migrator.up();
      project.write('0001-a.js', insertMigration('things', 'a'));
    }

    it("should refuse under onOutOfOrder: 'error', exactly as the run would", async () => {
      await lateArrival({ onOutOfOrder: 'error' });
      await assert.rejects(migrator.dryRun('up'), OutOfOrderMigrationError);
      await assert.rejects(migrator.up(), OutOfOrderMigrationError);
    });

    it('should still preview — with the warning — under the default policy', async () => {
      const warns = [];
      await lateArrival({
        logger: { debug() {}, info() {}, error() {}, warn: (msg) => warns.push(msg) },
      });
      const rows = await migrator.dryRun('up');
      assert.deepStrictEqual(
        rows.map((row) => row.file),
        ['0001-a.js'],
      );
      assert.ok(warns.some((msg) => msg.includes('Out-of-order')));
    });

    it('should leave a single-file preview exempt, like the single-file run', async () => {
      await lateArrival({ onOutOfOrder: 'error' });
      const rows = await migrator.dryRun('up', '0001-a.js');
      assert.strictEqual(rows.length, 1);
    });
  });

  describe('overlapping connects', () => {
    it('should open one client when several calls connect at once', async () => {
      setup();
      three();
      const connect = mock.method(MongoClient.prototype, 'connect');
      try {
        // A long-lived kit in a service: a status probe, a pending check and a
        // run all arriving before the first connection exists.
        const [status, pending, batch] = await Promise.all([
          migrator.status(),
          migrator.list('pending'),
          migrator.nextBatch(),
          migrator.connect(),
        ]);
        assert.strictEqual(connect.mock.callCount(), 1);
        assert.strictEqual(status.length, 3);
        assert.strictEqual(pending.length, 3);
        assert.strictEqual(batch, 1);
      } finally {
        connect.mock.restore();
      }
    });

    it('should connect afresh after a disconnect', async () => {
      setup();
      await migrator.connect();
      await migrator.disconnect();
      assert.strictEqual(await migrator.nextBatch(), 1);
    });
  });
});
