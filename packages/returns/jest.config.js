module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testRegex: ".*\\.spec\\.ts$",
  roots: ["<rootDir>/src"],
  reporters: [
    "default",
    ["<rootDir>/../../scripts/jest-campaign-reporter.cjs", { artifact: "returns" }],
  ],
};
