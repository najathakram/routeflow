import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The shared `test:repo-truth` task hashes cross-workspace inputs (turbo.json). A `!**/node_modules/**` negation only
// applies inside the task's OWN workspace, so with the plain form the key hashed ~13k generated files (dependency
// installs, Jest caches, Next and package builds) and changed every time the lane merely ran: the cache never hit and
// the key cost seconds to compute. The negations must be rooted (`!$TURBO_ROOT$/**/node_modules/**`).
//
// Pinned on turbo's own answer, not on the text of turbo.json: `turbo run test:repo-truth --dry=json` lists the files
// it WOULD hash and the key. This is a -script spec (it spawns turbo), so it runs in the serial script lane.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const GENERATED = /(^|\/)(node_modules|\.next|dist|\.turbo|\.jest-cache)\//;
const TASK = "@routeflow/api#test:repo-truth";

function dryRun(): { hash: string; inputs: string[] } {
  const res = spawnSync(
    "npx",
    ["turbo", "run", "test:repo-truth", "--dry=json", "--filter=@routeflow/api"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
      maxBuffer: 256 * 1024 * 1024,
      // A turbo task may run this spec; a nested turbo must not inherit the parent's run state.
      env: { ...process.env, TURBO_RUN_SUMMARY: "false", CI: "" },
    },
  );
  expect(res.status).toBe(0);
  const json = JSON.parse(res.stdout.slice(res.stdout.indexOf("{")));
  const task = json.tasks.find((t: { taskId: string }) => t.taskId === TASK);
  expect(task).toBeDefined();
  return { hash: task.hash, inputs: Object.keys(task.inputs ?? {}) };
}

describe("test:repo-truth cache key", () => {
  it("hashes no generated file, whichever workspace it sits in", () => {
    const { inputs } = dryRun();
    expect(inputs.length).toBeGreaterThan(100); // the dry run really listed the inputs
    const generated = inputs.filter((f) => GENERATED.test(f));
    expect(generated.slice(0, 5)).toEqual([]);
    expect(generated).toHaveLength(0);
  }, 240_000);

  it("does not move when a generated tree is written to (the lane merely running)", () => {
    const before = dryRun().hash;
    const probes = [
      "apps/api/.jest-cache/key-probe.tmp",
      "apps/web/.next/key-probe.tmp",
      "packages/pricing/dist/key-probe.tmp",
      "packages/ui/.turbo/key-probe.tmp",
    ].map((p) => path.join(REPO_ROOT, p));
    try {
      for (const p of probes) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, `probe ${Date.now()}`);
      }
      expect(dryRun().hash).toBe(before);
    } finally {
      for (const p of probes) fs.rmSync(p, { force: true });
    }
  }, 480_000);
});
