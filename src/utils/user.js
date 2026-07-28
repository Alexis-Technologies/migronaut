const os = require('node:os');

/**
 * Who to record as having run a migration.
 *
 * Precedence: MIGRONAUT_USER > os.userInfo().username > USER > USERNAME >
 * 'unknown'. MIGRONAUT_USER is an override rather than another fallback,
 * because in CI the OS user is a meaningless `runner`/`root` — the useful
 * identity is the deploy or actor name, and only the caller knows it.
 *
 * `os.userInfo()` throws a SystemError when the running UID has no passwd entry
 * — routine in distroless/scratch containers started with an arbitrary
 * `--user`. Recording who ran a migration must never be the reason a run fails.
 */
function safeUsername() {
  const override = process.env.MIGRONAUT_USER;
  if (override !== undefined && override !== '') return override;
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}

module.exports = { safeUsername };
