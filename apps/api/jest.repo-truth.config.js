const base = require("./package.json").jest;

module.exports = {
  ...base,
  // Never inherit the campaign reporter: it would overwrite .campaign/runs/api.json
  // with only this lane's results and turn campaign-check falsely RED.
  reporters: ["default"],
  testRegex:
    "(docs-truth|no-dead-deps|no-single-schema-path|client-page-params|no-react-skew-hacks|next-version|audit-allowlist-retired)\\.spec\\.ts$",
  testPathIgnorePatterns: ["/node_modules/"],
};
