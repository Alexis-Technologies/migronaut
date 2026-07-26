const os = require('node:os');

/**
 * The current OS username, or a best-effort fallback.
 *
 * `os.userInfo()` throws a SystemError when the running UID has no passwd entry
 * — routine in distroless/scratch containers started with an arbitrary
 * `--user`. Recording who ran a migration must never be the reason a run fails.
 */
function safeUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}

module.exports = { safeUsername };
