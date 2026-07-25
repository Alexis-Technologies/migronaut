const { Command } = require('commander');
const { registerCreate } = require('./commands/create.js');
const { registerDown } = require('./commands/down.js');
const { registerDryRun } = require('./commands/dry-run.js');
const { registerImport } = require('./commands/import.js');
const { registerInit } = require('./commands/init.js');
const { registerList } = require('./commands/list.js');
const { registerRedo } = require('./commands/redo.js');
const { registerStatus } = require('./commands/status.js');
const { registerUnlock } = require('./commands/unlock.js');
const { registerUp } = require('./commands/up.js');

/** Build the root commander program with all commands and global flags */
function buildProgram() {
  const program = new Command();

  program
    .name('migronaut')
    .description('Elegant, fast, TypeScript-first MongoDB migrations for Node.js')
    .option('--uri <uri>', 'MongoDB connection URI (overrides MIGRONAUT_URI)')
    .option('--db <name>', 'Database name (overrides MIGRONAUT_DB)')
    .option('--dir <path>', 'Migrations directory (overrides MIGRONAUT_MIGRATIONS_DIR)')
    .option('--config <path>', 'Path to a config file (overrides auto-discovery)')
    // Read straight from package.json at runtime — no build-time injection needed.
    .version(require('../../package.json').version);

  registerInit(program);
  registerImport(program);
  registerUp(program);
  registerDown(program);
  registerRedo(program);
  registerStatus(program);
  registerList(program);
  registerDryRun(program);
  registerCreate(program);
  registerUnlock(program);

  return program;
}

/** Parse argv and execute the matching command */
async function run(argv) {
  await buildProgram().parseAsync(argv);
}

module.exports = { buildProgram, run };
