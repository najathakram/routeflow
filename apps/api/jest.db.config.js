const base = require("./package.json").jest;

module.exports = {
  ...base,
  // Never inherit the campaign reporter: it would overwrite .campaign/runs/api.json
  // with only this lane's results and turn campaign-check falsely RED.
  reporters: ["default"],
  testRegex: ".*\\.db\\.spec\\.ts$",
  testPathIgnorePatterns: ["/node_modules/"],
  testTimeout: 30000,
};
