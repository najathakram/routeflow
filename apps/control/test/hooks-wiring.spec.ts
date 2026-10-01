/**
 * T60 (R31) — orient/handoff/settings/closeout are wired to the control CLI.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

function ctlHook(): string | undefined {
  const s = JSON.parse(read(".claude/settings.json"));
  return (s.hooks.SessionStart as any[])
    .flatMap((g) => g.hooks as any[])
    .map((h) => h.command as string)
    .find((c) => c.includes("apps/control/bin/ctl.mjs"));
}

describe("T60 hooks wiring (R31)", () => {
  it("orient.md has a step 9 running ctl next, capped at 30 lines", () => {
    const o = read(".claude/commands/orient.md");
    expect(o).toMatch(/^\s*9\.\s/m);
    expect(o).toContain("npm run ctl -- next --lane");
    expect(o).toContain("apps/control/bin/ctl.mjs");
    expect(o).toMatch(/30 lines/);
  });

  it("handoff.md has a Control: line and a ctl handoff step", () => {
    const h = read(".claude/commands/handoff.md");
    expect(h).toContain("- Control:");
    expect(h).toContain("npm run ctl -- handoff --card");
  });

  it("settings.json SessionStart runs the ctl brief, failing open, keeping existing hooks", () => {
    const ctl = ctlHook();
    expect(ctl).toBeDefined();
    expect(ctl).toContain("next");
    expect(ctl).toContain("--hook");
    const s = read(".claude/settings.json");
    expect(s).toContain("plane-triage.mjs");
    expect(s).toContain("check-git-hooks.mjs");
  });

  it("the SessionStart ctl hook exits 0 with no lane configured", () => {
    const cmd = ctlHook();
    expect(cmd).toBeDefined();
    const r = spawnSync("sh", ["-c", cmd as string], {
      cwd: ROOT,
      env: { ...process.env, CTL_LANE: "" },
      encoding: "utf8",
      timeout: 60000,
    });
    expect(r.status).toBe(0);
  });

  it("the hook command is a cross-platform node -e (no POSIX shell), timeout 10, valid JSON", () => {
    const cmd = ctlHook() as string;
    expect(cmd.startsWith("node -e ")).toBe(true);
    expect(cmd).not.toMatch(/\[ -f|; exit 0|2>\/dev\/null|&&/);
    expect(cmd).toContain("existsSync");
    const hook = (JSON.parse(read(".claude/settings.json")).hooks.SessionStart as any[])
      .flatMap((g) => g.hooks as any[])
      .find((h) => h.command === cmd);
    expect(hook.timeout).toBe(10);
  });

  it("running the hook command with no lane exits 0 quickly and prints nothing", () => {
    const cmd = ctlHook() as string;
    const t0 = Date.now();
    const r = spawnSync("sh", ["-c", cmd], {
      cwd: ROOT,
      env: { ...process.env, CTL_LANE: "", CONTROL_STATE_ORIGIN: "file:///nonexistent/none.git" },
      encoding: "utf8",
      timeout: 30000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("closeout.mjs accepts --task <RF-id> and emits a ctl done line", () => {
    const src = read(".claude/skills/dev-pipeline/scripts/closeout.mjs");
    expect(src).toContain("--task");
    expect(src).toMatch(/ctl.*done|done.*ctl/);
    const r = spawnSync(
      "node",
      [path.join(ROOT, ".claude/skills/dev-pipeline/scripts/closeout.mjs"), "--help"],
      { cwd: ROOT, encoding: "utf8", timeout: 30000 },
    );
    expect(`${r.stdout}${r.stderr}`).toContain("--task");
  });
});
