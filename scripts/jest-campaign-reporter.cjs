/**
 * jest-campaign-reporter — writes the campaign gate's run artifact on EVERY
 * jest run, so `scripts/campaign-check.mjs` can read fresh proof wherever
 * `npm run verify` executes (dev box or a fresh CI runner — the artifact is
 * gitignored and previously existed only when someone ran `jest --json` by
 * hand, which made CI's campaign-check fail on any `proven` ledger row).
 *
 * Emits the same shape `jest --json` produces, reduced to what the gate
 * parses: { testResults: [ { assertionResults: [ { fullName, status } ] } ] }.
 *
 * Wired as a second reporter (alongside "default") in apps/api's package.json
 * jest block and apps/mobile/jest.config.js, each passing { artifact: "api" }
 * / { artifact: "mobile" }. Writes are best-effort: a reporter must never
 * fail the test run it is observing.
 *
 * Caveat (deliberate): a SCOPED run (`jest -t REG-B190`) overwrites the
 * artifact with only the tests it ran. That is safe for the gate because
 * `verify` orders the full turbo test pass BEFORE campaign-check, so the gate
 * always reads the artifact the same invocation just regenerated; a stale
 * scoped artifact outside verify can only produce a false RED, never a false
 * green.
 */
const fs = require("node:fs");
const path = require("node:path");

class CampaignReporter {
  constructor(globalConfig, options) {
    this._name = (options && options.artifact) || "api";
  }
  onRunComplete(_contexts, results) {
    try {
      // Repo root = two levels up from the workspace jest ran in (apps/<ws>).
      const root = path.resolve(process.cwd(), "..", "..");
      const dir = path.join(root, ".campaign", "runs");
      fs.mkdirSync(dir, { recursive: true });
      const out = {
        numTotalTests: results.numTotalTests,
        numPassedTests: results.numPassedTests,
        numFailedTests: results.numFailedTests,
        testResults: (results.testResults || []).map((suite) => ({
          name: suite.testFilePath,
          assertionResults: (suite.testResults || []).map((t) => ({
            fullName: t.fullName || [...(t.ancestorTitles || []), t.title].join(" "),
            title: t.title,
            status: t.status,
          })),
        })),
      };
      fs.writeFileSync(path.join(dir, `${this._name}.json`), JSON.stringify(out));
    } catch (e) {
      // Never fail the run being observed.
      console.warn(`jest-campaign-reporter: could not write artifact: ${e && e.message}`);
    }
  }
}
module.exports = CampaignReporter;
