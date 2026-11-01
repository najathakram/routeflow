const path = require("path");
const base = require("./package.json").jest;
const {
  findCrossWorkspaceSpecs,
  specPathsRegex,
} = require("../../scripts/lib/cross-workspace-specs.cjs");

// Every api spec that reads another workspace's source is DERIVED (scripts/lib/cross-workspace-specs.cjs), so a
// new one is on this lane the day it is written; cross-workspace-lane.spec.ts pins the derivation.
// `-script.spec.ts` specs already run in the serial script lane (script-spec-lane.spec.ts: exactly one lane each).
const derived = (findCrossWorkspaceSpecs(path.resolve(__dirname, "../.."))["apps/api"] || [])
  .map((s) => s.spec)
  .filter((spec) => !spec.endsWith("-script.spec.ts"));

// The hand-kept names are the specs that guard repo truth WITHOUT matching the detector's shape (they walk the
// api's own tree, or read a file the detector cannot see by name), plus the derivation's own spec.
const handKept =
  "(docs-truth|no-dead-deps|no-single-schema-path|client-page-params|no-react-skew-hacks|next-version|audit-allowlist-retired|bugs-self-test-script|denied-identifiers|size-ratchet|owner-report-db-url|no-collection-time-clock-fuse|cleanup-imported-no-client|no-hand-typed-open-invoice-statuses|no-hand-typed-enum-mirrors|graph-core|no-stray-pipeline-state|cross-workspace-lane)\\.spec\\.ts$";

module.exports = {
  ...base,
  // Never inherit the campaign reporter: it would overwrite .campaign/runs/api.json
  // with only this lane's results and turn campaign-check falsely RED.
  reporters: ["default"],
  // One string (turbo-inputs.spec.ts builds a RegExp from it).
  testRegex: derived.length ? `${handKept}|${specPathsRegex(derived)}` : handKept,
  testPathIgnorePatterns: ["/node_modules/"],
};
