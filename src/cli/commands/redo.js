const { defineCommand } = require('../shared.js');

/** Register the `redo` command */
function registerRedo(program) {
  defineCommand(program, {
    name: 'redo',
    description: 'Rollback then re-apply the last applied migration, or a specific file',
    args: [['[file]', 'Specific migration file to redo']],
    options: [
      ['--reason <text>', 'Why — recorded on the changelog with the run (who: the OS user)'],
    ],
    lockable: true,
    mutating: true,
    run: (migrator, opts, [file]) =>
      migrator.redo(file, {
        noLock: opts.noLock,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      }),
    // No render: core logs the ↩/✔ lines itself.
  });
}

module.exports = { registerRedo };
