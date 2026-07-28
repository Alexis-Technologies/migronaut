const { defineCommand } = require('../shared.js');

/** Register the `redo` command */
function registerRedo(program) {
  defineCommand(program, {
    name: 'redo',
    description: 'Rollback then re-apply the last applied migration, or a specific file',
    args: [['[file]', 'Specific migration file to redo']],
    lockable: true,
    mutating: true,
    run: (migrator, opts, [file]) => migrator.redo(file, { noLock: opts.noLock }),
    // No render: core logs the ↩/✔ lines itself.
  });
}

module.exports = { registerRedo };
