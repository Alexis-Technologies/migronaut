/**
 * Collection names we accept for the changelog/lock collections,
 * `import --from/--to` and declared collections: non-empty, no `$` or NUL
 * (invalid server-side), and outside the reserved `system.` namespace — so no
 * config value can ever point a read or write at a system collection.
 *
 * Lives here rather than in config.js because the collection-definition
 * validator (core/collections.js) needs it too, and config.js requires that
 * validator — keeping the predicate in config.js would make the two a cycle.
 */
function isCollectionName(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('$') &&
    !value.includes('\0') &&
    !value.startsWith('system.')
  );
}

module.exports = { isCollectionName };
