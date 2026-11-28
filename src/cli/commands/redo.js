const { defineCommand } = require('../shared.js');

const registerRedo = (program) => {
  defineCommand(program, {
    name: 'redo',
    description: 'Rollback then re-apply the last applied migration, or a specific file',
    args: [['[file]', 'Specific migration file to redo']],
    options: [
      ['--reason <text>', 'Why — recorded on the changelog with the run (who: the OS user)'],
    ],
    lockable: true,
    mutating: true,
    run: (migrator, flags, positionals) => {
      return migrator.redo(positionals[0], {
        noLock: flags.noLock,
        ...(flags.reason !== undefined ? { reason: flags.reason } : {}),
      });
    },
    // No render: core logs the ↩/✔ lines itself.
  });
};

module.exports = { registerRedo };
