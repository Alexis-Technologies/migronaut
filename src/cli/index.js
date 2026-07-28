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
    // Global like --verbose/--quiet: `migronaut --json status` and
    // `migronaut status --json` must both work. `init` has no JSON output and
    // rejects the flag with a pointer to `--format json`.
    .option('--json', 'Output machine-readable JSON instead of human text')
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
  // Tokens after a `--` terminator are positionals, never flags.
  const boundary = argv.indexOf('--');
  const flagTokens = boundary === -1 ? argv : argv.slice(0, boundary);
  const noColor = flagTokens.includes('--no-color');
  const saved = noColor
    ? { FORCE_COLOR: process.env.FORCE_COLOR, NO_COLOR: process.env.NO_COLOR }
    : undefined;
  if (noColor) {
    // FORCE_COLOR outranks NO_COLOR among *environment* signals, which is the
    // right precedence between two ambient settings — but an explicit flag on
    // this invocation outranks both. Without clearing it, `--no-color` is a
    // silent no-op wherever FORCE_COLOR happens to be exported (CI runners and
    // many local shells set it).
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = '1';
  }
  try {
    await buildProgram().parseAsync(argv);
  } finally {
    // A programmatic embedder calling run() twice must not inherit this
    // invocation's flag as ambient state.
    if (saved) {
      if (saved.FORCE_COLOR === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = saved.FORCE_COLOR;
      if (saved.NO_COLOR === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = saved.NO_COLOR;
    }
  }
}

module.exports = { run };
