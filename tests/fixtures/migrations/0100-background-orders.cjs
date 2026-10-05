module.exports = {
  description: 'Move address into shipping',
  requires: ['0001-earlier.cjs'],
  background: {
    collection: 'orders',
    from: 1,
    to: 2,
    migrate: ({ address, ...doc }) => ({ ...doc, shipping: { address } }),
  },
};
