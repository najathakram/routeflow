/**
 * Jest config for @routeflow/control (was the `"jest"` block of package.json, same options).
 *
 * `maxWorkers`: this package spawns real git, a server and the CLI in most specs, so its workers are
 * CPU- and process-heavy. Jest's default (cores - 1) over-subscribes a shared runner: on the 10-core
 * measurement it burned MORE total CPU than two workers. CI therefore gets 2; elsewhere half the
 * cores. An explicit `--maxWorkers=N` (scripts/verify-turbo.mjs JEST_MAX_WORKERS) still wins.
 *
 * `globalSetup` compiles the server once per run (see test/global-setup.ts).
 */
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  cacheDirectory: "<rootDir>/.jest-cache",
  testEnvironment: "node",
  testRegex: "test/.*\\.spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": "ts-jest",
  },
  maxWorkers: process.env.CI ? 2 : "50%",
  globalSetup: "<rootDir>/test/global-setup.ts",
  globalTeardown: "<rootDir>/test/global-teardown.ts",
};
