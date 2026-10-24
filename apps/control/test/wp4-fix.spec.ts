/** WP4 fix round 1 — shards, sha hardening, warnings, cache, bare dirs, multi-PR, git path. */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bugsAsTasks, locationAreas } from "../src/domain/adapters";
import { loadRegisters } from "../src/sources/registers";
import { git, jl } from "./helpers/temp-repo";

const bug = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `acme: bug ${id}`,
  location: "apps/api/src/x.ts",
  severity: "low",
  register: "Open",
  sensitive: false,
  sensitiveFor: [],
  ...extra,
});

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "wp4-"));
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function fixture(shards: Record<string, string>, bugs = [bug("B01"), bug("B02"), bug("B03")]) {
  const d = tmp();
  dirs.push(d);
  fs.mkdirSync(path.join(d, "registers"), { recursive: true });
  fs.mkdirSync(path.join(d, "status"), { recursive: true });
  fs.writeFileSync(path.join(d, "registers", "bugs.jsonl"), jl2(bugs));
  for (const [n, c] of Object.entries(shards)) fs.writeFileSync(path.join(d, "status", n), c);
  return d;
}
const jl2 = (rows: unknown[]) => rows.map((r) => jl(r)).join("");

describe("1. shards", () => {
  it("already-fixed shard over an Open row -> code-complete + registerLag, pr carried", () => {
    const d = fixture({
      "S1.jsonl":
        jl({ id: "B01", state: "queued" }) + jl({ id: "B01", state: "already-fixed", pr: 77 }),
    });
    const t = loadRegisters({ fixtureDir: d }).tasks.find((x) => x.id === "B01") as any;
    expect(t).toMatchObject({
      status: "code-complete",
      phase: "already-fixed",
      pr: 77,
      registerLag: true,
    });
  });
  it("queued shard -> phase queued, still planned, no lag", () => {
    const d = fixture({ "S1.jsonl": jl({ id: "B02", state: "queued" }) });
    const t = loadRegisters({ fixtureDir: d }).tasks.find((x) => x.id === "B02") as any;
    expect(t.phase).toBe("queued");
    expect(t.status).toBe("planned");
    expect(t.registerLag).toBeUndefined();
  });
  it("last row per id wins across shard files", () => {
    const d = fixture({
      "A.jsonl": jl({ id: "B03", state: "done", pr: 1 }),
      "B.jsonl": jl({ id: "B03", state: "queued" }),
    });
    const t = loadRegisters({ fixtureDir: d }).tasks.find((x) => x.id === "B03") as any;
    expect(t).toMatchObject({ phase: "queued", status: "planned" });
  });
});

describe("2. sha injection", () => {
  it("rejects a non-40-hex sha and creates no file", () => {
    const d = tmp();
    dirs.push(d);
    const out = path.join(d, "x");
    expect(() => loadRegisters({ repoDir: d, sha: `--output=${out}` })).toThrow();
    expect(fs.existsSync(out)).toBe(false);
    expect(() => loadRegisters({ repoDir: d, sha: "abc123" })).toThrow();
  });
});

describe("3. warnings", () => {
  it("skips malformed lines with a file:line warning", () => {
    const d = fixture({});
    fs.appendFileSync(path.join(d, "registers", "bugs.jsonl"), "{not json\n");
    const r = loadRegisters({ fixtureDir: d }) as any;
    expect(r.tasks).toHaveLength(3);
    expect(r.warnings.some((w: string) => /bugs\.jsonl:4/.test(w))).toBe(true);
  });
  it("git failure -> warnings, empty tasks", () => {
    const d = tmp();
    dirs.push(d);
    const r = loadRegisters({ repoDir: d, sha: "0".repeat(40) }) as any;
    expect(r.tasks).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("5. bare directory", () => {
  it.each([
    ["apps/api payments", ["apps/api/**"]],
    ["apps/api/src/invoices — x", ["apps/api/src/invoices/**"]],
    ["apps/web/app/(dashboard)/page.tsx", ["apps/web/app/(dashboard)/page.tsx"]],
    ["apps/api/src/**", ["apps/api/src/**"]],
  ])("%s", (loc, want) => expect(locationAreas(loc)).toEqual(want));
});

describe("6. multi-PR", () => {
  it("Fixed · #789 + #802 -> prs both, pr first", () => {
    const t = bugsAsTasks([bug("B01", { register: "Fixed · #789 + #802" })])[0] as any;
    expect(t.prs).toEqual([789, 802]);
    expect(t.pr).toBe(789);
  });
});

describe("7. git path + cache", () => {
  const mk = () => {
    const d = tmp();
    dirs.push(d);
    git(d, ["init", "-q"]);
    const w = (p: string, c: string) => {
      fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true });
      fs.writeFileSync(path.join(d, p), c);
    };
    w(".claude/campaign/bugs.jsonl", jl(bug("B01")));
    w(".claude/campaign/status/S.jsonl", jl({ id: "B01", state: "proven", pr: 5 }));
    w(".claude/roadmap/features.jsonl", "");
    w(".claude/roadmap/deferred.jsonl", "");
    w(".claude/roadmap/releases.jsonl", jl({ id: "R1", name: "r", status: "planned" }));
    git(d, ["add", "."]);
    git(d, ["commit", "-q", "-m", "x"]);
    return { d, sha: git(d, ["rev-parse", "HEAD"]).trim() };
  };
  it("reads registers and shards at a sha; single-slot cache", () => {
    const a = mk();
    const r1 = loadRegisters({ repoDir: a.d, sha: a.sha });
    expect(r1.tasks[0]).toMatchObject({ id: "B01", status: "code-complete", phase: "proven" });
    expect(r1.releases).toHaveLength(1);
    expect(loadRegisters({ repoDir: a.d, sha: a.sha })).toBe(r1);
    const b = mk();
    loadRegisters({ repoDir: b.d, sha: b.sha });
    expect(loadRegisters({ repoDir: a.d, sha: a.sha })).not.toBe(r1);
  });
});

describe("follow-ups", () => {
  it("extensionless known files stay bare paths", () => {
    expect(locationAreas("apps/api/Dockerfile")).toEqual(["apps/api/Dockerfile"]);
    expect(locationAreas("apps/api/src")).toEqual(["apps/api/src/**"]);
  });
  it("parse-warning-only load is cached; git spawns counted", () => {
    const d = tmp();
    dirs.push(d);
    git(d, ["init", "-q"]);
    fs.mkdirSync(path.join(d, ".claude/campaign"), { recursive: true });
    fs.writeFileSync(path.join(d, ".claude/campaign/bugs.jsonl"), jl(bug("B01")) + "{bad\n");
    for (const f of ["features", "deferred", "releases"]) {
      fs.mkdirSync(path.join(d, ".claude/roadmap"), { recursive: true });
      fs.writeFileSync(path.join(d, `.claude/roadmap/${f}.jsonl`), "");
    }
    git(d, ["add", "."]);
    git(d, ["commit", "-q", "-m", "x"]);
    const sha = git(d, ["rev-parse", "HEAD"]).trim();
    let n = 0;
    const run = (repo: string, args: string[]) => {
      n++;
      return git(repo, args);
    };
    const r1 = loadRegisters({ repoDir: d, sha, run });
    expect(r1.warnings.length).toBe(1);
    const before = n;
    expect(before).toBeGreaterThan(0);
    expect(loadRegisters({ repoDir: d, sha, run })).toBe(r1);
    expect(n).toBe(before);
  });
});
