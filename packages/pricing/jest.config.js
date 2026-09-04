module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testRegex: ".*\\.spec\\.ts$",
  roots: ["<rootDir>/src"],
  // The REG-B### money regressions moved here out of apps/api, so this
  // workspace must publish its own campaign run artifact — otherwise
  // scripts/campaign-check.mjs (which reads .campaign/runs/*.json) sees no
  // proof for them and `npm run verify` fails on an undischarged claim.
  reporters: [
    "default",
    ["<rootDir>/../../scripts/jest-campaign-reporter.cjs", { artifact: "pricing" }],
  ],
};
