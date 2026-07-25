const assert = require('node:assert/strict');
const { afterEach, describe, it, mock } = require('node:test');
const { Command } = require('../../src/cli/args.js');

const parse = (program, args) => program.parseAsync(['node', 'cli', ...args]);

const muteStdout = () => mock.method(process.stdout, 'write', () => true);

afterEach(() => {
  mock.restoreAll();
  process.exitCode = undefined;
});

/** Build a program shaped like the real CLI: global options + subcommands */
function buildFixture(onAction) {
  const program = new Command();
  program
    .name('fixture')
    .description('Fixture CLI')
    .option('--uri <uri>', 'Connection URI')
    .option('--db <name>', 'Database name')
    .version('9.9.9');

  program
    .command('up')
    .description('Run migrations')
    .argument('[file]', 'Specific file')
    .option('--no-lock', 'Skip lock')
    .option('-f, --force', 'Force re-run')
    .option('-y, --yes', 'Skip confirmation')
    .option('--dry-run', 'Preview only')
    .option('--trust-hash', 'Trust stored hash')
    .option('--steps <n>', 'Steps to run')
    .action((file, opts, command) => onAction('up', { file, opts, command }));

  program
    .command('dry-run')
    .description('Preview a direction')
    .argument('<direction>', 'up or down')
    .argument('[file]', 'Specific file')
    .action((direction, file, opts, command) => onAction('dry-run', { direction, file, command }));

  return program;
}

describe('Command routing and options', () => {
  it('should route to the matching subcommand action', async () => {
    const calls = [];
    await parse(
      buildFixture((name) => calls.push(name)),
      ['up'],
    );
    assert.deepStrictEqual(calls, ['up']);
  });

  it('should merge global options given before the command name', async () => {
    let seen;
    const program = buildFixture((_, payload) => {
      seen = payload.command.optsWithGlobals();
    });
    await parse(program, ['--uri', 'mongodb://x', '--db', 'app', 'up']);
    assert.strictEqual(seen.uri, 'mongodb://x');
    assert.strictEqual(seen.db, 'app');
  });

  it('should merge global options given after the command name', async () => {
    let seen;
    const program = buildFixture((_, payload) => {
      seen = payload.command.optsWithGlobals();
    });
    await parse(program, ['up', '--uri', 'mongodb://y', '--force']);
    assert.strictEqual(seen.uri, 'mongodb://y');
    assert.strictEqual(seen.force, true);
  });

  it('should default a negatable option to true and flip it when passed', async () => {
    let seen;
    const program = buildFixture((_, payload) => {
      seen = payload.command.optsWithGlobals();
    });
    await parse(program, ['up']);
    assert.strictEqual(seen.lock, true);
    await parse(program, ['up', '--no-lock']);
    assert.strictEqual(seen.lock, false);
  });

  it('should resolve short aliases', async () => {
    let seen;
    const program = buildFixture((_, payload) => {
      seen = payload.command.optsWithGlobals();
    });
    await parse(program, ['up', '-f', '-y']);
    assert.strictEqual(seen.force, true);
    assert.strictEqual(seen.yes, true);
  });

  it('should accept --option=value syntax', async () => {
    let seen;
    const program = buildFixture((_, payload) => {
      seen = payload.command.optsWithGlobals();
    });
    await parse(program, ['--uri=mongodb://z', 'up', '--steps=3']);
    assert.strictEqual(seen.uri, 'mongodb://z');
    assert.strictEqual(seen.steps, '3');
  });

  it('should camelize kebab-case option names', async () => {
    let seen;
    const program = buildFixture((_, payload) => {
      seen = payload.command.optsWithGlobals();
    });
    await parse(program, ['up', '--dry-run', '--trust-hash']);
    assert.strictEqual(seen.dryRun, true);
    assert.strictEqual(seen.trustHash, true);
  });

  it('should leave unset boolean options undefined', async () => {
    let seen;
    const program = buildFixture((_, payload) => {
      seen = payload.command.optsWithGlobals();
    });
    await parse(program, ['up']);
    assert.strictEqual(seen.force, undefined);
    assert.strictEqual(seen.dryRun, undefined);
  });

  it('should pass local opts as the action opts parameter', async () => {
    let localOpts;
    const program = buildFixture((_, payload) => {
      localOpts = payload.opts;
    });
    await parse(program, ['--uri', 'mongodb://x', 'up', '--force']);
    assert.strictEqual(localOpts.force, true);
    assert.strictEqual(localOpts.uri, undefined);
  });
});

describe('Command positional arguments', () => {
  it('should pass an optional positional as undefined when omitted', async () => {
    let seen;
    await parse(
      buildFixture((_, payload) => (seen = payload)),
      ['up'],
    );
    assert.strictEqual(seen.file, undefined);
  });

  it('should bind two positionals in order', async () => {
    let seen;
    const program = buildFixture((name, payload) => {
      if (name === 'dry-run') seen = payload;
    });
    await parse(program, ['dry-run', 'down', '0001-a.js']);
    assert.strictEqual(seen.direction, 'down');
    assert.strictEqual(seen.file, '0001-a.js');
  });

  it('should mix positionals with options in any order', async () => {
    let seen;
    const program = buildFixture((_, payload) => (seen = payload));
    await parse(program, ['up', '0001-a.js', '--force']);
    assert.strictEqual(seen.file, '0001-a.js');
    assert.strictEqual(seen.opts.force, true);
  });

  it('should fail on a missing required argument without calling the action', async () => {
    const errors = [];
    mock.method(process.stderr, 'write', (chunk) => {
      errors.push(chunk);
      return true;
    });
    let called = false;
    const program = buildFixture(() => (called = true));
    await parse(program, ['dry-run']);
    assert.strictEqual(called, false);
    assert.strictEqual(process.exitCode, 1);
    assert.ok(errors.join('').includes("missing required argument 'direction'"));
  });
});

describe('Command error handling', () => {
  it('should reject an unknown option', async () => {
    const errors = [];
    mock.method(process.stderr, 'write', (chunk) => {
      errors.push(chunk);
      return true;
    });
    let called = false;
    await parse(
      buildFixture(() => (called = true)),
      ['up', '--bogus'],
    );
    assert.strictEqual(called, false);
    assert.strictEqual(process.exitCode, 1);
    assert.ok(errors.join('').includes("unknown option '--bogus'"));
  });

  it('should reject an unknown command', async () => {
    const errors = [];
    mock.method(process.stderr, 'write', (chunk) => {
      errors.push(chunk);
      return true;
    });
    await parse(
      buildFixture(() => {}),
      ['sideways'],
    );
    assert.strictEqual(process.exitCode, 1);
    assert.ok(errors.join('').includes("unknown command 'sideways'"));
  });

  it('should reject a value option with a missing value', async () => {
    const errors = [];
    mock.method(process.stderr, 'write', (chunk) => {
      errors.push(chunk);
      return true;
    });
    await parse(
      buildFixture(() => {}),
      ['up', '--steps'],
    );
    assert.strictEqual(process.exitCode, 1);
    assert.ok(errors.join('').includes("option '--steps <n>' argument missing"));
  });

  it('should throw on an unsupported option spec at registration time', () => {
    const program = new Command();
    assert.throws(() => program.option('!!bad!!'), TypeError);
  });
});

describe('Command help and version', () => {
  it('should print root help listing commands on --help', async () => {
    const out = [];
    mock.method(process.stdout, 'write', (chunk) => {
      out.push(chunk);
      return true;
    });
    await parse(
      buildFixture(() => {}),
      ['--help'],
    );
    const help = out.join('');
    assert.ok(help.includes('Usage: fixture [options] [command]'));
    assert.ok(help.includes('up [options] [file]'));
    assert.ok(help.includes('dry-run <direction> [file]'));
    assert.ok(help.includes('-V, --version'));
    assert.strictEqual(process.exitCode, undefined);
  });

  it('should print command help with its arguments and options', async () => {
    const out = [];
    mock.method(process.stdout, 'write', (chunk) => {
      out.push(chunk);
      return true;
    });
    await parse(
      buildFixture(() => {}),
      ['up', '--help'],
    );
    const help = out.join('');
    assert.ok(help.includes('Usage: fixture up [options] [file]'));
    assert.ok(help.includes('--no-lock'));
    assert.ok(help.includes('-f, --force'));
  });

  it('should print the version on --version and -V', async () => {
    const out = [];
    mock.method(process.stdout, 'write', (chunk) => {
      out.push(chunk);
      return true;
    });
    await parse(
      buildFixture(() => {}),
      ['--version'],
    );
    await parse(
      buildFixture(() => {}),
      ['-V'],
    );
    assert.deepStrictEqual(out, ['9.9.9\n', '9.9.9\n']);
  });

  it('should print help to stderr with exit code 1 when no command is given', async () => {
    muteStdout();
    const errors = [];
    mock.method(process.stderr, 'write', (chunk) => {
      errors.push(chunk);
      return true;
    });
    await parse(
      buildFixture(() => {}),
      [],
    );
    assert.strictEqual(process.exitCode, 1);
    assert.ok(errors.join('').includes('Usage: fixture [options] [command]'));
  });
});
