const { defineCommand } = require('../shared.js');

const registerDown = (program) => {
  defineCommand(program, {
    name: 'down',
    description:
      'Rollback the last batch, a specific batch, the last N steps, or a single named file',
    args: [['[file]', 'Specific migration file to revert']],
    options: [
      ['--batch <n>', 'Revert a specific batch number'],
      ['--steps <n>', 'Revert the last N migrations, regardless of batch'],
      ['--to <file>', 'Revert everything applied after this file (it stays applied)'],
      ['--reason <text>', 'Why — recorded on the changelog with the run (who: the OS user)'],
    ],
    lockable: true,
    mutating: true,
    run: (migrator, flags, positionals) => {
      return migrator.down(positionals[0], {
        noLock: flags.noLock,
        // `!== undefined`, not truthiness: `--batch 0` is a mistake worth
        // reporting, not one to silently drop. Core validates the value.
        ...(flags.batch !== undefined ? { batch: Number(flags.batch) } : {}),
        ...(flags.steps !== undefined ? { steps: Number(flags.steps) } : {}),
        ...(flags.to ? { to: flags.to } : {}),
        ...(flags.reason !== undefined ? { reason: flags.reason } : {}),
      });
    },
    // No render: core logs every ↩ Reverted line itself.
  });
};

module.exports = { registerDown };
