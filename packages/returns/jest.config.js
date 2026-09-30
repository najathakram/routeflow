module.exports = {
  preset: "ts-jest",
  // #2671: a per-worktree cache (dies with the worktree), never the shared OS-temp jest cache.
  cacheDirectory: "<rootDir>/.jest-cache",
  testEnvironment: "node",
  testRegex: ".*\\.spec\\.ts$",
  roots: ["<rootDir>/src"],
  reporters: [
    "default",
    ["<rootDir>/../../scripts/jest-campaign-reporter.cjs", { artifact: "returns" }],
  ],
};
