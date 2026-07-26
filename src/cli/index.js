const { Command } = require('./args.js');
const { registerAudit } = require('./commands/audit.js');
const { registerCreate } = require('./commands/create.js');
const { registerDown } = require('./commands/down.js');
const { registerDryRun } = require('./commands/dry-run.js');
const { registerImport } = require('./commands/import.js');
const { registerInit } = require('./commands/init.js');
const { registerList } = require('./commands/list.js');
const { registerLock } = require('./commands/lock.js');
const { registerRedo } = require('./commands/redo.js');
const { registerStatus } = require('./commands/status.js');
const { registerUnlock } = require('./commands/unlock.js');
const { registerUp } = require('./commands/up.js');

/** Build the root commander program with all commands and global flags */
function buildProgram() {
  const program = new Command();

  program
    .name('migronaut')
    .description('Elegant, fast, fully-typed MongoDB migrations for Node.js')
    .option('--uri <uri>', 'MongoDB connection URI (overrides MIGRONAUT_URI)')
    .option('--db <name>', 'Database name (overrides MIGRONAUT_DB)')
    .option('--dir <path>', 'Migrations directory (overrides MIGRONAUT_MIGRATIONS_DIR)')
    .option('--config <path>', 'Path to a config file (overrides auto-discovery)')
    .option('--env-file <path>', 'Path to the .env file to load (default: ./.env)')
    .option('--no-env', 'Do not load a .env file at all')
    .option('--verbose', 'Show debug output, including error causes')
    .option('--quiet', 'Suppress everything but errors')
    .option('--no-color', 'Disable colored output')
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
  registerLock(program);
  registerAudit(program);
  registerUnlock(program);

  return program;
}

/** Parse argv and execute the matching command */
async function run(argv) {
  // Checked before parsing: color is decided the first time anything renders,
  // which can precede the command action that would otherwise read the flag.
  if (argv.includes('--no-color')) process.env.NO_COLOR = '1';
  await buildProgram().parseAsync(argv);
}

module.exports = { buildProgram, run };
