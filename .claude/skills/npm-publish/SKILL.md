---
name: npm-publish
description: Prepare an @alexify package for publishing with pnpm. Handles version bump, CHANGELOG update, typings check, quality gates, README and docs refresh, package.json audit, and pnpm pack verification. Use when the user asks to prepare a release, bump version, publish a package, or do release prep.
---

<!-- Adapted from metaskills v1.0.5 (skills/npm-publish) for migronaut: pnpm instead of npm, the
     `prepublishOnly` gate plus size and docs:build, the CHANGELOG's own format
     (`## vX.Y.Z — YYYY-MM-DD`, no Unreleased section, no link block), the hand-synced version
     spots, and the manual release of ARCHITECTURE.md §10, which wins if the two ever disagree. -->

# npm Publish Preparation

Systematic workflow for preparing `@alexify/migronaut` for a new release. Every step must pass
before proceeding to the next. The package manager is pnpm (pinned in `packageManager`); never
create `package-lock.json`. Releases are run by hand on purpose — `pnpm run release` from a laptop,
no release workflow, no provenance, no publish automation — and this skill never publishes. Do not
propose release automation, size budgets, `pnpm audit` in CI, dependabot or other governance
ceremony; the user has declined all of it.

Releases so far: 1.0.0, 2.0.0 – 2.4.0 (tags `vX.Y.Z`). A feature lands on its own branch, carries a
`## vX.Y.Z — unreleased` CHANGELOG section while it is built, and ends in a release commit on that
branch; the branch is squash-merged into `main`.

## Step 0: Gather Release Intent

Ask the user (use AskUserQuestion if available):

1. **Version bump type**: patch / minor / major / explicit version / prerelease tag
2. **Prerelease label** (if any): e.g. `alpha`, `beta`, `rc`
3. **Confirm changelog entries**: ask if the `## vX.Y.Z — unreleased` section in CHANGELOG is
   complete, or if the user wants to draft entries from the branch's commits

If the user already specified intent (e.g. "prepare the 2.5.0 release"), skip the question and
proceed.

Precedent for the bump: additive features are minors even when they add `MigronautErrorCode`
members (2.1 – 2.4); 2.0.0 was a major for three narrow contract changes, one of them a new error
code. When the release changes a public type, an event payload, an exit code or a default, say so
and let the user choose.

## Step 1: Pre-flight Checks

Run:

```bash
pnpm install --frozen-lockfile   # install deps exactly as locked
pnpm run lint                    # oxlint
pnpm run format:check            # oxfmt
pnpm run test:coverage           # unit + integration under c8, gated at 90 lines / 90 branches / 90 functions
pnpm run test:types              # tsd against index.d.ts, bullmq.d.ts, versioning.d.ts
pnpm run check:dts               # tsc --strict over the three .d.ts files together
pnpm run size                    # esbuild bundle report — informational, there is no budget
pnpm run docs:build              # the VitePress site; a dead link fails it
```

The first five are `prepublishOnly`, which `pnpm publish` re-runs; `size` and `docs:build` complete
the gate the release commits record. Do not lower a coverage threshold to get green. `size` is a
tripwire, not a budget: the adapter's or the versioning runtime's number jumping by an order of
magnitude means something required the engine or `bullmq` — find out why.

Then run the opt-in suites the release touches (CLAUDE.md "Commands" has the containers):

- **Real BullMQ** (`MIGRONAUT_TEST_REDIS_URL`, `tests/integration/bullmq-redis.test.js`) — CI runs
  it; run it locally whenever the queue adapter or the background queue changed
- **Atlas Search** (`MIGRONAUT_TEST_ATLAS_URI`, `tests/integration/search-atlas.test.js`) — manual
  only; after changes to `search-index-spec.js`, `converge-search.js` or the search planner
- **Sharded cluster** (`MIGRONAUT_TEST_SHARDED_URI`, `tests/integration/sharded.test.js`) — manual
  only; after shard-aware changes

Then in parallel: `pnpm outdated` and `pnpm audit` (report to the user; devDependencies only, the
package has no runtime dependencies). The peer floors `mongodb >=5.0.0` / `mongoose >=7.0.0` stay
as they are — do not propose raising them.

If any gate fails, stop and fix issues before continuing.

## Step 2: Version Bump

### Read current version from `package.json`

Compute the new version based on user intent and semver rules:

- **patch**: `1.2.3` → `1.2.4`
- **minor**: `1.2.3` → `1.3.0`
- **major**: `1.2.3` → `2.0.0`
- **prerelease**: `1.2.3` → `1.2.4-<label>.0`, or `1.2.4-beta.0` → `1.2.4-beta.1`
- **Removing prerelease tag**: `4.0.3-prerelease` → `4.0.3` (just strip the suffix)

Update `"version"` in `package.json` with the Edit tool, not `pnpm version`: the bump is a plain
edit, and the commit, tag and changelog are handled by hand.

The version lives in four hand-synced places, and no test checks them — change all four in the
release commit:

1. `package.json` — `"version"` (the CLI reads it at runtime: `migronaut --version`)
2. `CHANGELOG.md` — `## vX.Y.Z — unreleased` becomes `## vX.Y.Z — YYYY-MM-DD`
3. `ARCHITECTURE.md` — the snapshot line near the top: `v<X.Y.Z> (unreleased)` becomes `v<X.Y.Z>`
4. `docs/.vitepress/config.mts` — the nav label `text: 'v<X.Y.Z>'` (commented as hand-synced)

Then confirm nothing stale is left:

```bash
grep -n "unreleased" CHANGELOG.md ARCHITECTURE.md
grep -n "v<OLD_VERSION>'" docs/.vitepress/config.mts
```

`examples/migration-service` depends on `"@alexify/migronaut": "file:../.."` — nothing to bump.

## Step 3: Update CHANGELOG.md

The changelog has its own format — follow it, do not convert it to Keep a Changelog:

- **Headings**: `## vX.Y.Z — YYYY-MM-DD` (a `v`, an em dash, the publish date in ISO 8601); newest
  first; no `[Unreleased]` section and no reference-link block at the bottom — do not add either
- **Lead paragraph**: one short paragraph under the heading — what the release is about, whether it
  is additive ("a migration that never touches X behaves as before"), and which parts are
  experimental (their shape may still change in a minor release)
- **Subsections**, in this order, empty ones omitted: `### Breaking changes` (a major only, first),
  `### Added`, `### Changed`, `### Fixed`, `### Documentation`, `### Tooling`, `### Notes`
- **Entries**: bullets with a **bold lead-in**, an em dash, then the explanation — what the user
  can now do, the names they will type (`ctx.logger`, `--check`, an option, an event), and any
  limit; human-readable and curated (no raw git log); a breaking change names what to change

### 3a: Detect changelog structure

Read `CHANGELOG.md` to the previous release. Identify:

- The `## vX.Y.Z — unreleased` section, if the branch already wrote one (it usually has)
- The previous release heading — the comparison base for the drafting below

### 3b: Draft or complete the entry

Draft from the commits since the previous release tag:

```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```

Tags are lightweight, on the squash-merge commit on `main`; on a feature branch the range is the
branch's own commits. Commits follow Conventional Commits: map `feat` → Added, `fix` → Fixed,
`perf`/`refactor` → Changed when a user can notice it, `docs` → Documentation,
`test`/`ci`/`chore`/`build` → Tooling only when it matters to a contributor, `!` or a
`BREAKING CHANGE` footer → Breaking changes. Merge with the existing section — it is usually
already written, and review commits ("fix(review): …") fold into the entry they fix rather than
becoming entries of their own.

Then date the heading (Step 2).

## Step 4: TypeScript Declarations

The types are hand-written, one file per entry point: `index.d.ts` (package root), `bullmq.d.ts`
(`./bullmq`), `versioning.d.ts` (`./versioning`, needs TypeScript ≥ 5.0; the others ≥ 4.8):

1. `pnpm run test:types` (tsd, `tests/types/*.test-d.ts`) and `pnpm run check:dts` must pass
2. `tests/unit/package-surface.test.js` pins the root and `./bullmq` barrels against their
   `.d.ts` (`./versioning` only against a list of names), the error classes against
   `MigronautErrorCode`, and every code against `EXIT_CODES`; still read
   `src/index.js`, `src/bullmq/index.js` and `src/versioning/index.js` against their declarations
   for the shapes a name test cannot see — option fields, result fields, event payloads
3. The docs-sync tests pin the rest: `events-docs-sync` (every event the types declare is
   documented), `telemetry-docs-sync` (every span, metric and attribute name), `schema-sync`
   (`migronaut.schema.json` vs the validator and its copy in `docs/public/`), `readme-sync`
   (commands and `MIGRONAUT_*` variables in the README and `docs/reference/cli.md`)
4. No `.d.ts` imports `mongoose`, `bullmq` or `@opentelemetry/*`; private (`#`) and internal
   fields stay out
5. If the release includes API changes, the typings and `tests/types/*.test-d.ts` land together

## Step 5: README, Docs & License Review

**Update the year** in `LICENSE` if the release is in a later year than its copyright lines carry.
Only the year — the two copyright holders (the original author and Alexis Technologies) stay as
they are, and no attribution notes are added.

Scan for staleness:

1. **README.md** — usage examples match the current API (run one if in doubt); the comparison
   tables; the Commands and configuration/env tables (`readme-sync` checks names, not prose)
2. **README.md Benchmarks** — re-run `pnpm run bench` when the release touched a benchmarked path
   (`computeChecksum`, `loadMigrationFile`, `Changelog`, `MigrationLock`, `MigratorKit.up()`) and
   hand-copy the table and the machine/Node line
3. **docs/** — the guide and command pages for anything the release changed
   (`docs/guide/*.md`, `docs/commands/*.md`, `docs/reference/cli.md`,
   `docs/reference/error-codes.md`), the home page (`docs/index.md`) when the release adds a
   headline feature, and the sidebar in `docs/.vitepress/config.mts` for a new page.
   `pnpm run docs:build` must pass
4. **docs/public/llms.txt** — hand-written: the key-facts list names every entry point and every
   headline feature; add the release's, keep Node ≥ 22.18 and the zero-dependency claim true
5. **ARCHITECTURE.md** — the snapshot line (Step 2), the module reference for new modules, §8 for
   a new nuance, §10's "Published artifact" list against `package.json#files`; **CLAUDE.md** — the
   layout, the "names already taken" list and the commands, when the release changed them
6. **SECURITY.md** — the supported-versions table names the current minor line (`X.Y.x`) as
   supported and everything older as not; update it on every minor and major

Only edit if something is factually wrong or outdated. Don't rewrite style or add unsolicited
content.

## Step 6: Package Audit

### 6a: Verify `package.json` fields

Check these fields are correct (and change none of them unless the user asked — packaging and
`exports` changes are the user's call):

- `"main"` → `index.js`, `"types"` → `index.d.ts`, `"bin"` → `{ "migronaut": "./bin/migronaut.js" }`
- `"exports"` — exactly `.`, `./bullmq`, `./versioning`, each with `types` first, then `default`;
  nothing else is reachable
- `"files"` — `index.js`, `index.d.ts`, `bullmq.js`, `bullmq.d.ts`, `versioning.js`,
  `versioning.d.ts`, `migronaut.schema.json`, `bin`, `src`, `README.md`, `CHANGELOG.md` (npm adds
  `LICENSE` and `package.json` itself)
- `"engines"` — `node >=22.18.0`; CI's test matrix is Node 22 and 24 on Ubuntu and Windows
- `"dependencies"` — absent; `mongodb` is a peer, `mongoose` an optional peer, and `bullmq`,
  `ioredis` and `@opentelemetry/*` stay devDependencies
- `"keywords"` — no typos, relevant terms
- `"license"`, `"repository"`, `"homepage"` (`https://migronaut.vercel.app/`), `"bugs"`,
  `"publishConfig"` (`access: public`), `"packageManager"` — valid

### 6b: Dry-run pack

```bash
pnpm pack --dry-run
pnpm run size
```

Review the file list:

- `src/`, `bin/`, the three root shims, the three `.d.ts`, `migronaut.schema.json`, README,
  CHANGELOG, LICENSE are included
- Tests, docs, blog, examples, bench, scripts, assets, coverage, `migronaut.config.ts`, `ARCHITECTURE.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `.claude/` and
  `.github/` are excluded
- No unexpected large files

Then pack for real into a scratch directory and smoke the tarball there:

```bash
pnpm pack --pack-destination <scratch>
cd <scratch> && npm init -y && npm install ./alexify-migronaut-<X.Y.Z>.tgz mongodb
node -e "require('@alexify/migronaut'); require('@alexify/migronaut/bullmq'); require('@alexify/migronaut/versioning')"
npx migronaut --version   # prints X.Y.Z
node -e "require('@alexify/migronaut/src/index.js')"   # must fail: ERR_PACKAGE_PATH_NOT_EXPORTED
```

and typecheck an `import` of each entry with `npx -p typescript tsc --module nodenext
--moduleResolution nodenext --strict --noEmit`.

Report the file count and the bundle sizes from `pnpm run size` to the user.

## Step 7: Final Verification

Run the gates one more time after all edits:

```bash
pnpm run lint && pnpm run format:check && pnpm run test:coverage && pnpm run test:types && pnpm run check:dts && pnpm run size && pnpm run docs:build
```

Must exit 0. If it fails, fix and re-run. Note the test count and the coverage numbers — the release
commit records them.

## Step 8: Summary & Next Steps

Present a summary to the user:

```
Release preparation complete:
  Package:  @alexify/migronaut
  Version:  <old> → <new>
  Tests:    ✓ <N> passing (<lines>% lines, <branches>% branches, <functions>% functions)
  Types:    ✓ tsd + check:dts
  Opt-in:   <the suites run, e.g. real-Redis BullMQ 75/75>
  Packed:   <N> files, <min+gzip sizes>
```

Then the release commit, on the feature branch — ask the user before committing:

```
chore(release): X.Y.Z

<One paragraph: what the release brings, in the user's terms. See the CHANGELOG.>

Gate: lint, format:check, test:coverage (<N> tests; <l>% lines, <b>% branches, <f>% functions),
test:types, check:dts, size, docs:build — and <the opt-in suites run>.
```

Then list the remaining manual steps, all the user's:

1. Push the branch and open the PR; squash-merge it into `main` as
   `Migronaut vX.Y: <headline> (#N)`
2. `git tag vX.Y.Z <squash-merge commit>` on `main` (lightweight), then `git push origin vX.Y.Z`
3. `pnpm run release` (= `pnpm publish`; `prepublishOnly` re-runs the gate) from that commit, with
   npm 2FA; for a prerelease `pnpm publish --tag <label>`
4. Write the GitHub release notes from the changelog section
5. Verify the docs deploy: `curl -o /dev/null -sw '%{http_code}' https://migronaut.vercel.app/` and
   that the nav label shows the new version

Do NOT run `pnpm publish`, `npm publish`, `git push` or `git tag` automatically — always let the
user do it or explicitly confirm.

## Step 9: Lockfile

Run `pnpm install` only if dependencies changed during the release; commit the updated
`pnpm-lock.yaml` with the release. Never generate or commit `package-lock.json`.
