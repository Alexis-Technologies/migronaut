/**
 * A background migration: `up` only registers it, and the background worker
 * rewrites the plans from shape v1 to v2 beside the migration line — in
 * batches, with checkpoints, never holding the migration lock. Every write is
 * guarded by the document's revision, so an API write in between is never
 * lost. Watch it with GET /migrations/background.
 */
module.exports = {
  background: {
    collection: 'plans',
    from: 1,
    to: 2,
    // v2 adds the tier; migronaut stamps __v: 2 and bumps __rev itself.
    migrate: (plan) => ({ ...plan, tier: plan.seats > 1 ? 'paid' : 'free' }),
    // The way back, for `down`: withdraws the forward rewrite and runs this one.
    revert: ({ tier: _tier, ...plan }) => plan,
    // Up to two partitions at once, across every worker of the service.
    maxParallel: 2,
  },
};
