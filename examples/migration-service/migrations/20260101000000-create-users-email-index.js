/** A schema change: idempotent in both directions, so a re-run after a crash is harmless */
module.exports = {
  description: 'Unique index on users.email',

  async up({ db }) {
    await db.collection('users').createIndex({ email: 1 }, { unique: true, name: 'email_unique' });
  },

  async down({ db }) {
    await db
      .collection('users')
      .dropIndex('email_unique')
      .catch((error) => {
        // Already gone (a re-run after a crash) — nothing left to undo.
        if (error.codeName !== 'IndexNotFound' && error.codeName !== 'NamespaceNotFound') {
          throw error;
        }
      });
  },
};
