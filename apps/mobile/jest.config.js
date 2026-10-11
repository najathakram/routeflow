/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  // #2671: a per-worktree cache (dies with the worktree), never the shared OS-temp jest cache.
  cacheDirectory: "<rootDir>/.jest-cache",
  testEnvironment: "node",
  // Campaign gate artifact — see scripts/jest-campaign-reporter.cjs.
  reporters: [
    "default",
    ["<rootDir>/../../scripts/jest-campaign-reporter.cjs", { artifact: "mobile" }],
  ],
  // Only run the pure-logic unit tests — not the Expo/RN component files
  testMatch: ["**/__tests__/**/*.test.ts"],
  // ts-jest config (new flat style, also supported via globals for compat)
  transform: {
    // react-navigation ships ESM only; the remove-guard test drives its real core/routers.
    "node_modules[\\\\/](@react-navigation|use-latest-callback|nanoid)[\\\\/].+\\.js$": [
      "ts-jest",
      {
        tsconfig: { allowJs: true, esModuleInterop: true, module: "commonjs", target: "es2020" },
        diagnostics: false,
      },
    ],
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          strict: false,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          moduleResolution: "node",
        },
        diagnostics: false,
      },
    ],
  },
  // Look for modules in the monorepo root node_modules as well
  moduleDirectories: ["node_modules", "../../node_modules"],
  // Map packages that can't run in a plain Node environment
  moduleNameMapper: {
    // Resolve the shared money-math package to its SOURCE (outside node_modules,
    // so transformIgnorePatterns does not apply) — tests must not depend on
    // whether `dist/` has been built.
    "^@routeflow/pricing$": "<rootDir>/../../packages/pricing/src/index.ts",
    // Same reason for the scan engine: resolve to SOURCE, no build step to depend on.
    "^@routeflow/scanning$": "<rootDir>/../../packages/scanning/src/index.ts",
    // Same reason for the shared return-state helpers: resolve to SOURCE, no build step to depend on.
    "^@routeflow/returns$": "<rootDir>/../../packages/returns/src/index.ts",
    // B910: the sentinel-email helpers live in the shared types package, but the
    // PACKAGE ROOT is stubbed below (its index pulls the whole DTO surface), so
    // lib/internal-email.ts re-exports the SUBPATH module — resolve that one to
    // SOURCE, same as pricing/scanning/returns.
    "^@routeflow/types/internal-email$": "<rootDir>/../../packages/types/internal-email.ts",
    // SA-714: the pure staff "Backorder" tag rule, same subpath trick (the package root is stubbed).
    "^@routeflow/types/order-line-backorder$":
      "<rootDir>/../../packages/types/order-line-backorder.ts",
    // SA-767 L-2.4 D: the stock-count commit copy, same subpath trick (the package root is stubbed).
    "^@routeflow/types/stock-count-commit-copy$":
      "<rootDir>/../../packages/types/stock-count-commit-copy.ts",
    "^expo-secure-store$": "<rootDir>/__tests__/__mocks__/expo-secure-store.js",
    // #2653: the shell bridge is pure TS (zod only) — resolve it to SOURCE, ahead of the ui stub.
    "^@routeflow/ui/shell-bridge$": "<rootDir>/../../packages/ui/src/shell-bridge.ts",
    "^@routeflow/ui/(.*)$": "<rootDir>/__tests__/__mocks__/@routeflow/ui.js",
    "^@routeflow/types$": "<rootDir>/__tests__/__mocks__/@routeflow/types.js",
  },
  // Avoid trying to transform node_modules (except socket.io-client which ships ESM)
  transformIgnorePatterns: [
    "node_modules[\\\\/](?!(socket\\.io-client|engine\\.io-client|@react-navigation[\\\\/]core|@react-navigation[\\\\/]routers|use-latest-callback|nanoid)[\\\\/])",
  ],
};
