/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
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
    "^expo-secure-store$": "<rootDir>/__tests__/__mocks__/expo-secure-store.js",
    "^@routeflow/ui/(.*)$": "<rootDir>/__tests__/__mocks__/@routeflow/ui.js",
    "^@routeflow/types$": "<rootDir>/__tests__/__mocks__/@routeflow/types.js",
  },
  // Avoid trying to transform node_modules (except socket.io-client which ships ESM)
  transformIgnorePatterns: ["node_modules/(?!(socket\\.io-client|engine\\.io-client)/)"],
};
