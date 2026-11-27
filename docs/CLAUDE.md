# docs — the VitePress site

User-facing, never published to npm. `pnpm run docs:dev` serves it, `pnpm run docs:build` is a
release gate.

- `docs/public/llms.txt` is hand-written: it names every entry point and headline feature,
  Node ≥ 22.18 and the zero-dependency claim. Update it with a headline feature.
- `docs/public/migronaut.schema.json` is a byte-identical copy of the root's (`schema-sync`).
- The docs-sync tests hold pages to the code: `events-docs-sync`, `telemetry-docs-sync`,
  `schema-sync`, `readme-sync`, and `package-surface` for the tables of
  `reference/error-codes.md` and the exit codes of `reference/cli.md` — a new error code adds a
  row to both.
- The nav label of `.vitepress/config.mts` carries the version, hand-synced at release.
- Diagrams are `mermaid` code fences, drawn in the browser by `.vitepress/theme/mermaid.ts`;
  `mermaid` and the Vercel packages are devDependencies only.
- A guide page sets per-environment behaviour through `MIGRONAUT_*`, never a branch on `NODE_ENV`.
- A new page goes into the sidebar; a headline feature onto the home page.
- This file is no page: `srcExclude` in `.vitepress/config.mts` keeps it off the site.
