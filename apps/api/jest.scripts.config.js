const base = require("./package.json").jest;

// #2192: the spawn-heavy script specs (`*-script.spec.ts`: janitor, e2e-seed, release-health,
// prod-migrate, schema-drift, ...) drive a REAL script as a child process (node, git, and
// PowerShell children). Inside the parallel unit pool their spawn latency scales with CPU
// contention, so on a loaded machine they time out and refuse pre-push verify (#2146, #2176).
// They run here instead, one file at a time, AFTER the parallel pool has finished — see
// scripts/run-unit-tests.mjs, which is what `npm test -w apps/api` runs. The base config ignores
// the same pattern, so every script spec runs in exactly one lane.
//
// bugs-self-test-script.spec.ts is the one `-script.spec.ts` that stays in the repo-truth lane
// (jest.repo-truth.config.js): turbo hashes that task's cross-tree inputs, which it needs.
module.exports = {
  ...base,
  // The same campaign artifact as the parallel run, MERGED into it rather than overwriting it
  // (the reporter only merges when both runs share RF_CAMPAIGN_RUN_ID; see its header).
  reporters: [
    "default",
    ["<rootDir>/../../../scripts/jest-campaign-reporter.cjs", { artifact: "api", merge: true }],
  ],
  testRegex: "-script\\.spec\\.ts$",
  testPathIgnorePatterns: ["/node_modules/", "bugs-self-test-script\\.spec\\.ts$"],
  // Serial by construction, whatever --maxWorkers the caller passes (run-unit-tests.mjs drops it).
  maxWorkers: 1,
};
