const { defineCommand } = require('../shared.js');

/** Register the `down` command */
function registerDown(program) {
  defineCommand(program, {
    name: 'down',
    description:
      'Rollback the last batch, a specific batch, the last N steps, or a single named file',
    args: [['[file]', 'Specific migration file to revert']],
    options: [
      ['--no-lock', 'Skip the concurrency lock (dev only)'],
      ['--batch <n>', 'Revert a specific batch number'],
      ['--steps <n>', 'Revert the last N migrations, regardless of batch'],
      ['--to <file>', 'Revert everything applied after this file (it stays applied)'],
      ['--json', 'Output machine-readable JSON of the run results'],
    ],
    mutating: true,
    run: (migrator, opts, [file]) =>
      migrator.down(file, {
        noLock: opts.lock === false,
        // `!== undefined`, not truthiness: `--batch 0` is a mistake worth
        // reporting, not one to silently drop. Core validates the value.
        ...(opts.batch !== undefined ? { batch: Number(opts.batch) } : {}),
        ...(opts.steps !== undefined ? { steps: Number(opts.steps) } : {}),
        ...(opts.to ? { to: opts.to } : {}),
      }),
    // Human mode: core logs every ↩ Reverted line — nothing extra to render.
    render: () => undefined,
  });
}

module.exports = { registerDown };
