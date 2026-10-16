/**
 * Pins the pure logic behind scripts/graph.mjs (radius = graph + git grep) and scripts/graph-refresh.mjs
 * (scripts/lib/graph-core.cjs): path resolution, the four-list reconcile, GRAPHIFY_OFF, and the overlay
 * files the graph host re-applies. The graph itself is never loaded: these are set operations on arrays.
 * Design: specs/graphify/DESIGN.md section 2 (items 4-12) and section 3 (item 4).
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require("../../../../scripts/lib/graph-core.cjs");

const REPO = path.resolve(__dirname, "../../../..");

describe("parseSymbolSpec / parseArgs", () => {
  it("splits file.ts::Symbol and keeps a bare name or node id whole", () => {
    expect(core.parseSymbolSpec("getTierPrice")).toEqual({
      raw: "getTierPrice",
      name: "getTierPrice",
    });
    expect(core.parseSymbolSpec("packages\\pricing\\src\\tier-pricing.ts::getTierPrice")).toEqual({
      raw: "packages\\pricing\\src\\tier-pricing.ts::getTierPrice",
      file: "packages/pricing/src/tier-pricing.ts",
      name: "getTierPrice",
    });
    expect(core.parseSymbolSpec("./a/b.ts::X").file).toBe("a/b.ts");
    expect(() => core.parseSymbolSpec("")).toThrow();
    expect(() => core.parseSymbolSpec("a.ts::")).toThrow();
  });

  it("parses radius flags and passes explain|affected|path through untouched", () => {
    const r = core.parseArgs(["radius", "A", "b.ts::B", "--depth", "3", "--cap", "10", "--json"]);
    expect(r.cmd).toBe("radius");
    expect(r.symbols.map((s: { name: string }) => s.name)).toEqual(["A", "B"]);
    expect(r.flags).toEqual({ depth: 3, cap: 10, json: true });
    expect(core.parseArgs(["affected", "X", "--depth", "1"]).passthrough).toEqual([
      "X",
      "--depth",
      "1",
    ]);
    expect(core.parseArgs(["serve", "--port", "9000"]).flags.port).toBe(9000);
    expect(core.parseArgs([]).cmd).toBe("help");
    expect(() => core.parseArgs(["radius"])).toThrow(/at least one symbol/);
    expect(() => core.parseArgs(["radius", "A", "--wat"])).toThrow(/unknown flag/);
    expect(() => core.parseArgs(["build"])).toThrow(/unknown command/);
  });
});

describe("resolveGraphPath", () => {
  const g = (p: string) => `${p}/graphify-out/graph.json`;
  const only =
    (...present: string[]) =>
    (p: string) =>
      present.includes(p);

  it("prefers GRAPHIFY_GRAPH, then GRAPHIFY_HOST, the script's own host, the cwd, then the default hosts", () => {
    const base = { scriptDir: "/h/scripts", cwd: "/w", home: "/u", exists: () => true };
    expect(core.resolveGraphPath({ ...base, env: { GRAPHIFY_GRAPH: "/x/graph.json" } }).graph).toBe(
      "/x/graph.json",
    );
    expect(core.resolveGraphPath({ ...base, env: { GRAPHIFY_HOST: "/hh" } }).graph).toBe(g("/hh"));
    expect(core.resolveGraphPath({ ...base, env: {} })).toMatchObject({
      graph: g("/h"),
      host: "/h",
      source: "script-host",
    });
    expect(core.resolveGraphPath({ ...base, env: {}, exists: only(g("/w")) })).toMatchObject({
      host: "/w",
      source: "cwd",
    });
    expect(
      core.resolveGraphPath({ ...base, env: {}, exists: only(g("/u/code/rf-mobile-release")) })
        .source,
    ).toBe("default-mac");
    expect(
      core.resolveGraphPath({
        ...base,
        env: {},
        exists: only(g("C:/ClaudeCode/rf-mobile-release")),
      }).source,
    ).toBe("default-pc");
  });

  it("never falls back silently when an explicit GRAPHIFY_GRAPH is missing, and reports what it tried", () => {
    const r = core.resolveGraphPath({
      env: { GRAPHIFY_GRAPH: "/nope/graph.json" },
      scriptDir: "/h/scripts",
      cwd: "/w",
      home: "/u",
      exists: only(g("/h")),
    });
    expect(r.graph).toBeNull();
    expect(r.explicit).toBe("/nope/graph.json");
    const none = core.resolveGraphPath({
      env: {},
      scriptDir: "/h/scripts",
      cwd: "/w",
      home: "/u",
      exists: () => false,
    });
    expect(none.graph).toBeNull();
    expect(none.tried).toContain(g("/h"));
  });
});

describe("pythonCandidates / pythonFromShebang", () => {
  it("lists GRAPHIFY_PY first, then the pipx and uv venvs for the platform", () => {
    const win = core.pythonCandidates({
      env: { GRAPHIFY_PY: "C:\\py\\python.exe", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
      platform: "win32",
    });
    expect(win[0]).toBe("C:/py/python.exe");
    expect(win).toContain("C:/Users/a/AppData/Local/pipx/pipx/venvs/graphifyy/Scripts/python.exe");
    const mac = core.pythonCandidates({ env: {}, home: "/Users/a", platform: "darwin" });
    expect(mac).toContain("/Users/a/.local/pipx/venvs/graphifyy/bin/python");
    expect(mac).toContain("/Users/a/.local/share/uv/tools/graphifyy/bin/python");
  });

  it("reads the interpreter from a launcher shebang", () => {
    expect(core.pythonFromShebang("#!/Users/a/.local/pipx/venvs/graphifyy/bin/python")).toBe(
      "/Users/a/.local/pipx/venvs/graphifyy/bin/python",
    );
    expect(core.pythonFromShebang("#!/bin/sh")).toBeNull();
    expect(core.pythonFromShebang("MZ")).toBeNull();
  });
});

describe("reconcile (graph hits vs git grep files)", () => {
  const hits = [
    { file: "apps/api/src/a.ts", rel: "calls", depth: 1 },
    { file: "apps/api/src/c.ts", rel: "calls", depth: 2 },
    { file: "apps/api/src/c.ts", rel: "references", depth: 1 }, // shallowest wins
    { file: "apps/api/src/a.spec.ts", rel: "calls", depth: 1 },
    { file: "packages/pricing/src/def.ts", rel: "references", depth: 1 }, // the definition file
    { file: ".claude/code-map/api.md", rel: "references", depth: 1 }, // out of scope
  ];
  const grep = [
    "apps/api/src/a.ts",
    "apps/api/src/b.ts",
    "apps/api/src/b.spec.ts",
    "packages/pricing/src/def.ts",
    "apps/web/lib/w.ts",
  ];

  it("sorts every file into both / grep-only / graph-only / specs", () => {
    const r = core.reconcile({
      graphHits: hits,
      grepFiles: grep,
      defFiles: ["packages/pricing/src/def.ts"],
    });
    expect(r.both).toEqual(["apps/api/src/a.ts"]);
    expect(r.grepOnly).toEqual(["apps/api/src/b.ts", "apps/web/lib/w.ts"]);
    expect(r.graphOnly).toEqual([{ file: "apps/api/src/c.ts", rel: "references", depth: 1 }]);
    expect(r.specs).toEqual(["apps/api/src/a.spec.ts", "apps/api/src/b.spec.ts"]);
  });

  it("with no graph answer every grep file is grep-only (UNKNOWN is not none)", () => {
    const r = core.reconcile({ graphHits: [], grepFiles: grep });
    expect(r.both).toEqual([]);
    expect(r.graphOnly).toEqual([]);
    expect(r.grepOnly).toHaveLength(4);
  });

  it("recognises spec and test files by name and folder", () => {
    for (const f of [
      "a.spec.ts",
      "a.test.tsx",
      "x/__tests__/y.ts",
      "apps/web/e2e/z.ts",
      "x/q.db.spec.ts",
    ])
      expect(core.isSpecFile(f)).toBe(true);
    for (const f of ["a.ts", "spec/a.ts", "x/latest.ts"]) expect(core.isSpecFile(f)).toBe(false);
  });

  it("parses git grep output to sorted, unique, in-scope posix paths", () => {
    expect(core.parseGrepOutput("apps\\b.ts\npackages/a.ts\napps\\b.ts\n.claude/x.md\n\n")).toEqual(
      ["apps/b.ts", "packages/a.ts"],
    );
  });
});

describe("capList / renderList / formatHeader", () => {
  it("caps at 40 and says how many were left out", () => {
    const items = Array.from({ length: 45 }, (_, i) => `f${i}`);
    expect(core.capList(items)).toMatchObject({ more: 5 });
    expect(core.capList(items).shown).toHaveLength(40);
    const lines = core.renderList("grep-only", items, { note: "READ FIRST" });
    expect(lines[0]).toBe("grep-only (45) READ FIRST:");
    expect(lines).toHaveLength(42);
    expect(lines[41]).toBe("  +5 more");
    expect(core.renderList("both", [])).toEqual(["both (0)"]);
  });

  it("prints graph@<sha> N behind", () => {
    expect(core.formatHeader({ sha: "b6ed040dc3dbfc3918b5ac661cbb05abe340f394", behind: 3 })).toBe(
      "graph@b6ed040dc 3 behind",
    );
    expect(core.formatHeader({ sha: "b6ed040dc", behind: null })).toBe("graph@b6ed040dc ? behind");
    expect(core.formatHeader({ sha: null })).toBe("graph@missing");
    expect(core.formatHeader({ off: true })).toBe("graph off");
  });
});

describe("canary", () => {
  it("passes only when the graph finds >= 80% of grep's non-test files for every symbol", () => {
    const ok = core.canaryVerdict([
      { symbol: "a", both: 8, grepOnly: 2 },
      { symbol: "b", both: ["x"], grepOnly: [] },
    ]);
    expect(ok.pass).toBe(true);
    expect(core.canaryLabel(ok)).toBe("pass");
    const blind = core.canaryVerdict([
      { symbol: "a", both: 8, grepOnly: 2 },
      { symbol: "getTierPrice", both: 1, grepOnly: 35 },
    ]);
    expect(blind.pass).toBe(false);
    expect(core.canaryLabel(blind)).toBe("blind");
    expect(core.canaryVerdict([{ symbol: "z", both: 0, grepOnly: 0 }]).pass).toBe(false); // no grep baseline
    expect(core.canaryVerdict([]).pass).toBe(false);
  });
});

describe("serve command and log record", () => {
  it("is exactly DESIGN item 6: http on loopback, no session reaping, one context", () => {
    const c = core.buildServeCommand({ graph: "/h/graphify-out/graph.json" });
    expect(c.args.join(" ")).toBe(
      "-I -X utf8 -m graphify.serve --transport http --host 127.0.0.1 --port 8765 --session-timeout 0 /h/graphify-out/graph.json",
    );
    expect(c.env).toEqual({ GRAPHIFY_MAX_CONTEXTS: "1" });
  });

  it("builds the query-log.jsonl record", () => {
    const rec = core.buildLogRecord({
      cmd: "radius",
      symbols: [{ raw: "A" }, "B"],
      ms: 12,
      bytes: 99,
      sha: "b6ed040dc3dbfc39",
      behind: 2,
      grepOnly: 5,
      now: new Date("2026-10-15T20:00:00Z"),
    });
    expect(rec).toEqual({
      ts: "2026-10-15T20:00:00.000Z",
      cmd: "radius",
      symbols: ["A", "B"],
      ms: 12,
      bytes: 99,
      sha: "b6ed040dc",
      behind: 2,
      grepOnly: 5,
    });
  });
});

describe("refresh helpers", () => {
  it("skips under 20 commits behind unless forced or the graph is missing", () => {
    expect(core.shouldRefresh({ behind: 19, hasGraph: true }).go).toBe(false);
    expect(core.shouldRefresh({ behind: 20, hasGraph: true }).go).toBe(true);
    expect(core.shouldRefresh({ behind: 1, hasGraph: true, force: true }).go).toBe(true);
    expect(core.shouldRefresh({ behind: 0, hasGraph: false }).go).toBe(true);
  });

  it("prunes every dated backup folder except the newest and leaves everything else", () => {
    expect(
      core.backupFoldersToPrune([
        "cache",
        "2026-10-13",
        "graph.json",
        "2026-10-15",
        "2026-10-14",
        "wiki",
      ]),
    ).toEqual(["2026-10-13", "2026-10-14"]);
    expect(core.backupFoldersToPrune(["2026-10-15"])).toEqual([]);
  });

  it("refuses a host with edits beyond the overlay", () => {
    expect(
      core.foreignChanges(
        " M .graphifyignore\n M packages/pricing/package.json\n?? graphify-out/BUILT_AT\n",
      ),
    ).toEqual([]);
    expect(core.foreignChanges(" M .graphifyignore\n M apps/api/src/x.ts\n")).toEqual([
      " M apps/api/src/x.ts",
    ]);
  });

  it("puts source first in exports['.'] once, changing nothing else", () => {
    const text =
      '{\n  "name": "p",\n  "description": "a \\u2014 b",\n  "exports": {\n    ".": {\n      "types": "./dist/index.d.ts",\n      "default": "./dist/index.js"\n    },\n    "./package.json": "./package.json"\n  }\n}\n';
    const r = core.applySourceCondition(text);
    expect(r.changed).toBe(true);
    expect(Object.keys(JSON.parse(r.text).exports["."])).toEqual(["source", "types", "default"]);
    expect(r.text).toContain("a \\u2014 b"); // untouched bytes
    expect(core.applySourceCondition(r.text)).toEqual({ text: r.text, changed: false });
    expect(core.applySourceCondition('{"name":"x"}').changed).toBe(false);
  });
});

describe("what the repo ships", () => {
  it("keeps .graphifyignore equal to the overlay constant the refresh re-applies", () => {
    expect(fs.readFileSync(path.join(REPO, ".graphifyignore"), "utf8").replace(/\r\n/g, "\n")).toBe(
      core.CODE_ONLY_IGNORE,
    );
  });

  it("gives pricing, scanning and returns a leading 'source' export condition and leaves types/default alone", () => {
    for (const p of core.SOURCE_EXPORT_PACKAGES) {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(REPO, "packages", p, "package.json"), "utf8"),
      );
      expect(Object.keys(pkg.exports["."])).toEqual(["source", "types", "default"]);
      expect(pkg.exports["."].source).toBe("./src/index.ts");
      expect(pkg.exports["."].types).toBe("./dist/index.d.ts");
      expect(pkg.exports["."].default).toBe("./dist/index.js");
      expect(fs.existsSync(path.join(REPO, "packages", p, "src/index.ts"))).toBe(true);
    }
  });
});

describe("GRAPHIFY_OFF", () => {
  it("reads 1/true/yes/on only", () => {
    for (const v of ["1", "true", "YES", "on"])
      expect(core.isGraphOff({ GRAPHIFY_OFF: v })).toBe(true);
    for (const v of ["", "0", "false", undefined])
      expect(core.isGraphOff({ GRAPHIFY_OFF: v })).toBe(false);
  });

  it("makes graph.mjs print 'graph off' and exit 0 without touching a graph or python", () => {
    const out = execFileSync(
      process.execPath,
      [path.join(REPO, "scripts/graph.mjs"), "radius", "Anything"],
      {
        encoding: "utf8",
        env: { ...process.env, GRAPHIFY_OFF: "1", GRAPHIFY_GRAPH: "/does/not/exist.json" },
      },
    );
    expect(out.trim()).toBe("graph off");
  });
});
