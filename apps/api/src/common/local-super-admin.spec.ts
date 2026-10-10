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
    // #2221: Node reports 666 on win32 whatever chmod says, so the script skips its mode checks there
    // (and says so) — the 0600 assertion is only real on POSIX.
    expect(out).toContain(process.platform === "win32" ? "skip mode assertions" : "mode 0600");
  });
});
