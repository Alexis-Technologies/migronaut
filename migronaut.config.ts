import type { MigronautConfig } from '@alexify/migronaut';

/**
 * migronaut configuration.
 * Precedence (highest first): CLI flags > MIGRONAUT_* env vars > this file > defaults.
 * Every field is optional; the values below are the built-in defaults.
 */
const config: Partial<MigronautConfig> = {
  // ── Connection ──────────────────────────────────────────────
  // To load these from a secret manager instead, run: migronaut init --secret-provider
  uri: 'mongodb://localhost:27017',
  dbName: 'myapp',

  // ── Migration files ─────────────────────────────────────────
  migrationsDir: './migrations',
  // Extensions scanned when discovering migrations.
  fileExtensions: ['.ts', '.js'],
  // File type `migronaut create` generates by default ('ts' | 'js').
  // Override for a single run with --js / --ts.
  createExtension: 'ts',
  // Use 0001-style sequential numbering instead of timestamps.
  sequential: false,
  // Path to a custom template used by `migronaut create`.
  // templatePath: './migration.template.ts',

  // ── Bookkeeping collections ─────────────────────────────────
  migrationsCollection: '_migronaut_migrations',
  lockCollection: '_migronaut_locks',
  // Seconds before a held lock is considered stale and reclaimable.
  lockTTLSeconds: 60,

  // ── Behavior ────────────────────────────────────────────────
  // Abort (instead of warn) when a file's checksum no longer matches.
  strict: false,
  // Wrap every migration in a transaction. Override per file with
  // `export const useTransaction = true`.
  useTransaction: false,

  // ── Lifecycle hooks (code only — not available in JSON config) ──
  // hooks: {
  //   beforeAll: async (ctx) => {},
  //   afterAll: async (ctx) => {},
  //   beforeEach: async (name, ctx) => {},
  //   afterEach: async (name, duration, ctx) => {},
  //   onError: async (name, error, ctx) => {},
  // },
};

export default config;
