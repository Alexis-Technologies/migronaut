const { defineCommand } = require('../shared.js');

/** Register the `redo` command */
function registerRedo(program) {
  defineCommand(program, {
    name: 'redo',
    description: 'Rollback then re-apply the last applied migration, or a specific file',
    args: [['[file]', 'Specific migration file to redo']],
    options: [
      ['--no-lock', 'Skip the concurrency lock (dev only)'],
      ['--json', 'Output machine-readable JSON of the run results'],
    ],
    mutating: true,
    run: (migrator, opts, [file]) => migrator.redo(file, { noLock: opts.lock === false }),
    // Human mode: core logs the ↩/✔ lines itself — nothing extra to render.
    render: () => undefined,
  });
}

module.exports = { registerRedo };
