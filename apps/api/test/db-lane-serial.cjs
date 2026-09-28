// #2183 / B592: the DB lane is serial by construction. Every spec in it shares ONE database and
// three of them act on the WHOLE database (publish-and-repin, the two backfills), so parallel
// workers make them red about one run in three. jest.db.config.js says `maxWorkers: 1`, but a
// CLI `--maxWorkers=N` / `-w N` overrides a config value — which is how prover runs that passed
// `--maxWorkers=4` (the fleet's JEST_MAX_WORKERS habit) went parallel. `npm run test:db`
// (scripts/run-db-tests.mjs) strips those overrides with a warning; this globalSetup is the
// backstop for a direct `jest -c jest.db.config.js --maxWorkers=4`: it refuses the run before any
// spec touches the DB.

/** Throws when the resolved jest run would use more than one worker. */
function assertSerialDbLane(globalConfig) {
  const workers = Number(globalConfig && globalConfig.maxWorkers);
  if (Number.isFinite(workers) && workers > 1) {
    throw new Error(
      `The DB lane must run serially (it resolved to maxWorkers=${workers}). Every DB spec shares ` +
        `one database, and parallel workers break the whole-database specs (B592). Run it with ` +
        `\`npm run test:db -w apps/api\` (or \`npm run local:test:db\`), which ignores worker overrides.`,
    );
  }
}

module.exports = async function dbLaneGlobalSetup(globalConfig) {
  assertSerialDbLane(globalConfig);
};
module.exports.assertSerialDbLane = assertSerialDbLane;
