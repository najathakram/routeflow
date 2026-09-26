import { execFileSync } from "child_process";
import * as path from "path";

/**
 * D-03 (#1803): `scripts/local-super-admin.mjs` mints a throwaway super-admin for the LOCAL Playwright lane
 * only. Its safety properties are the point, so its own self-test (the non-local refusal list, per-run random
 * passwords, the 0600 credential file) runs in the default lane: a change that loosens the guard fails here.
 */
describe("scripts/local-super-admin.mjs", () => {
  it("--self-test passes: refuses every non-local target, random passwords, mode-600 file", () => {
    const script = path.resolve(__dirname, "../../../../scripts/local-super-admin.mjs");
    const out = execFileSync(process.execPath, [script, "--self-test"], { encoding: "utf8" });
    expect(out).toContain("self-test: all passed");
    expect(out).not.toContain("FAIL");
    expect(out).toContain("refuses");
    expect(out).toContain("mode 0600");
  });
});
