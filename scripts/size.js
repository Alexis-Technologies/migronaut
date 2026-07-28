/**
 * Honest bundle-size measurement, run with `pnpm size`.
 *
 * Bundles each shipped entry point with esbuild exactly the way a consumer's
 * bundler/installer would end up shipping it, then reports:
 *   - raw:      bundled, un-minified
 *   - min:      fully minified (whitespace + identifier mangling + syntax,
 *               comments stripped)
 *   - min+gzip: the number that matters for install/cold-start size budgets
 *
 * Peer dependencies (mongodb, mongoose) are external — every consumer already
 * installs them separately, so bundling them in would double-count size that
 * isn't migronaut's own.
 */

const { gzipSync } = require('node:zlib');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const PEER_DEPS = ['mongodb', 'mongoose'];

const ENTRIES = [
  { label: 'library entry (@alexify/migronaut)', entry: 'index.js' },
  { label: 'CLI (bin/migronaut)', entry: 'bin/migronaut.js' },
];

async function bundle(entry, minify) {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    minify,
    platform: 'node',
    external: PEER_DEPS,
    write: false,
    logLevel: 'silent',
  });
  return Buffer.from(result.outputFiles[0].contents);
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  const rows = [];
  for (const { label, entry } of ENTRIES) {
    const raw = await bundle(entry, false);
    const min = await bundle(entry, true);
    rows.push({
      label,
      raw: kb(raw.length),
      min: kb(min.length),
      gzip: kb(gzipSync(min, { level: 9 }).length),
    });
  }

  console.log('| Entry | raw | min | min+gzip |');
  console.log('| ----- | ---:| ---:| --------:|');
  for (const row of rows) {
    console.log(`| ${row.label} | ${row.raw} | ${row.min} | ${row.gzip} |`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
