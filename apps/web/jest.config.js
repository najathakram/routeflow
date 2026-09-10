// next/jest auto-patches package-lock.json when a platform @next/swc
// optionalDependency entry is missing, which requires a live call to the npm
// registry. That network call is unavailable in this environment and throws
// (TypeError: Cannot read properties of undefined (reading 'os')), aborting
// the whole config load. Opt out — the lockfile is pD1's (see the wave
// README: pD1 owns package.json/package-lock.json) and not touched here.
process.env.NEXT_IGNORE_INCORRECT_LOCKFILE = process.env.NEXT_IGNORE_INCORRECT_LOCKFILE ?? "1";

const nextJest = require("next/jest");

const createJestConfig = nextJest({ dir: "./" });

/** @type {import('jest').Config} */
const customJestConfig = {
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  testEnvironment: "jsdom",
  // Campaign gate artifact — see scripts/jest-campaign-reporter.cjs. Writes
  // .campaign/runs/web.json so scripts/campaign-check.mjs can discharge REG-B###
  // T1 claims proven by apps/web jest specs, alongside api/mobile/pricing.
  reporters: [
    "default",
    ["<rootDir>/../../scripts/jest-campaign-reporter.cjs", { artifact: "web" }],
  ],
  // RTL suites mount the real Auth/BuyerAuth/i18n providers and pay a cold SWC compile on
  // the first test of each file; under CI/pre-push load on slow hosts that exceeds Jest's
  // 5 s default and fails as a timeout rather than an assertion. 30 s is a ceiling, not a wait.
  testTimeout: 30_000,
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  // Deliberately NOT `<rootDir>/**/*.test.{ts,tsx}` (the brief's literal suggestion).
  // jest-config's replacePathSepForGlob() converts `\` -> `/` in a rootDir-substituted
  // pattern EXCEPT when the backslash precedes one of `$()+.?^{}` (it assumes that's an
  // escaped glob special char). Every worktree in this repo lives under
  // `.claude/worktrees/<name>`, so `<rootDir>` always contains a `\.claude` segment on
  // Windows; that one separator survives as a literal backslash, and picomatch then
  // compiles the pattern's `\.` as an escaped-dot (consuming the backslash) while the
  // matched file path still has both characters — so it matches nothing. Confirmed via
  // `npx jest --listTests` returning empty with the rootDir-anchored form. `roots` below
  // already scopes discovery to app/components/lib/hooks, so a plain relative glob works
  // and needs no rootDir anchor.
  testMatch: ["**/*.test.{ts,tsx}"],
  testPathIgnorePatterns: ["/node_modules/", "/.next/", "/e2e/"],
  roots: ["<rootDir>/app", "<rootDir>/components", "<rootDir>/lib", "<rootDir>/hooks"],
};

// createJestConfig is exported this way to ensure next/jest can load the Next.js config,
// which is async.
module.exports = createJestConfig(customJestConfig);
