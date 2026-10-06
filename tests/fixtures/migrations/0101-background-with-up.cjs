module.exports = {
  up: async () => {},
  background: { collection: 'orders', from: 1, to: 2, migrate: (doc) => doc },
};
