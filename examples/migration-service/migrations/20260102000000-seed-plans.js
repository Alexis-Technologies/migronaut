const PLANS = [
  { _id: 'free', seats: 1 },
  { _id: 'team', seats: 10 },
];

/** A data change: upserts, so applying it twice leaves the same documents */
module.exports = {
  description: 'Seed the pricing plans',

  async up({ db, signal }) {
    for (const plan of PLANS) {
      // Long migrations should watch the signal: it fires when the worker is
      // shutting down or the job was cancelled.
      signal?.throwIfAborted();
      await db.collection('plans').updateOne({ _id: plan._id }, { $set: plan }, { upsert: true });
    }
  },

  async down({ db }) {
    await db.collection('plans').deleteMany({ _id: { $in: PLANS.map((plan) => plan._id) } });
  },
};
