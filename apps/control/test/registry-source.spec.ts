/** B1-a2 (C5): registers.ts reads the register through a registry source, keyed on two shas. */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadRegisters, readRegistrySource } from "../src/sources/registers";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function recorder() {
  const calls: Array<{ repoDir: string; args: string[] }> = [];
  const run = (repoDir: string, args: string[]): string => {
    calls.push({ repoDir, args });
    return args[0] === "ls-tree" ? "" : '{"id":"B1","title":"t","status":"open"}\n';
  };
  return { calls, run };
}

describe("registry source (B1-a2 C5)", () => {
  it("readRegistrySource() equals the shared scripts/lib/registry-source.json", () => {
    const file = path.join(REPO_ROOT, "scripts", "lib", "registry-source.json");
    expect(readRegistrySource()).toEqual(JSON.parse(fs.readFileSync(file, "utf8")));
  });

  it("the cache key carries both shas: a new register sha re-reads, the same pair does not", () => {
    const { calls, run } = recorder();
    const repo = "/repo-two-sha";
    loadRegisters({ repoDir: repo, sha: SHA_A, run, registry: { repoDir: repo, sha: SHA_A } });
    const first = calls.length;
    expect(first).toBeGreaterThan(0);
    loadRegisters({ repoDir: repo, sha: SHA_A, run, registry: { repoDir: repo, sha: SHA_A } });
    expect(calls.length).toBe(first);
    loadRegisters({ repoDir: repo, sha: SHA_A, run, registry: { repoDir: repo, sha: SHA_B } });
    expect(calls.length).toBeGreaterThan(first);
  });

  it("register files come from the registry source's repo and sha; roadmap files from the repo sha", () => {
    const { calls, run } = recorder();
    loadRegisters({
      repoDir: "/product",
      sha: SHA_A,
      run,
      registry: { repoDir: "/specs", sha: SHA_C, prefix: "registry/campaign" },
    });
    const shows = calls.filter((c) => c.args[0] === "show").map((c) => `${c.repoDir} ${c.args[2]}`);
    expect(shows).toContain(`/specs ${SHA_C}:registry/campaign/bugs.jsonl`);
    expect(shows).toContain(`/product ${SHA_A}:.claude/roadmap/features.jsonl`);
    const tree = calls.find((c) => c.args[0] === "ls-tree");
    expect(tree?.repoDir).toBe("/specs");
    expect(tree?.args).toContain("registry/campaign/status/");
  });

  it("rejects a registry sha that is not a full 40-hex id", () => {
    expect(() =>
      loadRegisters({ repoDir: "/r", sha: SHA_A, registry: { repoDir: "/r", sha: "abc" } }),
    ).toThrow(/40-hex/);
  });
});
