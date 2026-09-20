const base = require("./package.json").jest;

module.exports = {
  ...base,
  // Never inherit the campaign reporter: it would overwrite .campaign/runs/api.json
  // with only this lane's results and turn campaign-check falsely RED.
  reporters: ["default"],
  testRegex: ".*\\.db\\.spec\\.ts$",
  testPathIgnorePatterns: ["/node_modules/"],
  testTimeout: 30000,
  // One worker: every spec in this lane shares ONE database, and three of them run tools that act
  // on the WHOLE database rather than on their own tenants — publish-and-repin.mjs scans every
  // PRODUCTION tenant (its `--only-test-tenants` guard REFUSES the batch, exit 3, if another
  // spec's non-test-slug tenant exists at that instant), and the two backfill specs reclassify /
  // re-stamp whole tables. With parallel workers those windows overlap: D6-D9/K3 went red about
  // one run in three (B592). Serial costs a few minutes in a lane that runs once per PR.
  maxWorkers: 1,
};
