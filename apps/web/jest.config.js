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
  // RTL suites mount the real Auth/BuyerAuth/i18n providers and pay a cold SWC compile on
  // the first test of each file; under CI/pre-push load on slow hosts that exceeds Jest's
  // 5 s default and fails as a timeout rather than an assertion. 30 s is a ceiling, not a wait.
  testTimeout: 30_000,
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
    // Force a SINGLE `react` instance for the whole test run. apps/web's OWN
    // package.json still pins "react"/"react-dom" to "^18" (a stale range — its
    // @types/react is ~19.2.2 and every other workspace/hoisted consumer is on
    // React 19), so npm installs a nested apps/web/node_modules/react@18.3.1
    // ALONGSIDE root's hoisted react@19.2.5 (there is only ONE react-dom in the
    // tree, root's 18.3.1 — apps/web has no nested copy, so it already resolves
    // there consistently and needs no mapping). @routeflow/ui's Modal/Toast
    // (Radix Dialog/Toast, resolved from root or packages/ui's nested
    // node_modules) pick up the HOISTED react@19 while apps/web's own component
    // files pick up the NESTED react@18 — two different `react` module instances
    // paired with the ONE react-dom@18 in one process, which crashes any
    // Radix-based render with "Cannot read properties of undefined (reading
    // 'ReactCurrentDispatcher')" (confirmed via a Modal render smoke test).
    // Pinning `react` to apps/web's local copy (which matches react-dom's 18.3.1)
    // for every consumer fixes the pairing. Test-infra-only (no package.json/
    // lockfile change); the underlying "^18" vs "~19.2.2" range drift in
    // apps/web/package.json is a real dependency bug — flagged separately, not
    // fixed here (package.json/lockfile is pD1's). react-dom itself has NO nested
    // copy under apps/web/node_modules (only root's hoisted 18.3.1 exists, two
    // levels up) — it's pinned here too, to that same root copy, alongside the
    // jsx-runtime entries below, so every require of react/react-dom in a test
    // process resolves to the exact SAME module instances apps/web's own
    // component files use, not just version-compatible ones; two different
    // instances of the same version still fail Radix's/React's internal identity
    // checks (e.g. dispatcher context).
    "^react$": "<rootDir>/node_modules/react",
    "^react-dom$": "<rootDir>/../../node_modules/react-dom",
    "^react-dom/(.*)$": "<rootDir>/../../node_modules/react-dom/$1",
    "^react/jsx-runtime$": "<rootDir>/node_modules/react/jsx-runtime",
    "^react/jsx-dev-runtime$": "<rootDir>/node_modules/react/jsx-dev-runtime",
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
