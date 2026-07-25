/** Build the MigrationContext passed into every migration function */
function buildContext(client, db, mongoose) {
  const context = { client, db };
  if (mongoose) context.mongoose = mongoose;
  return context;
}

module.exports = { buildContext };
