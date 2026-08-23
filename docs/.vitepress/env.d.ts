// Vite's client types (`/// <reference types="vite/client" />`) are not resolvable
// here — vite is only a transitive dependency of vitepress, so pnpm does not hoist
// it. Declare the one `import.meta.env` flag the theme uses instead.
interface ImportMetaEnv {
  /** `true` in `vitepress build`, `false` in `vitepress dev`. */
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
