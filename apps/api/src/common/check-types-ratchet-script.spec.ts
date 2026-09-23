import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// B806: the rules behind apps/api `check-types` (scripts/lib/check-types-ratchet-core.mjs). The
// library is ESM (.mjs) and this suite runs under ts-jest's CommonJS transform, so each case spawns a
// `node --input-type=module` child that imports the real module and prints one JSON line. The full
// compile itself is exercised by `check-types` in verify, never here (it needs a ~3 GB heap).

const API_DIR = path.resolve(__dirname, "../..");
const CORE = pathToFileURL(path.join(API_DIR, "scripts/lib/check-types-ratchet-core.mjs")).href;

function core(body: string): any {
  const res = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import * as c from "${CORE}";\n${body}`],
    { encoding: "utf8" },
  );
  if (res.status !== 0 || !res.stdout.trim()) {
    throw new Error(`core shim failed (${res.status}):\n${res.stdout}\n${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim());
}

/** evaluate() over diagnostics given as [file, count] pairs. */
const judge = (files: Array<[string | null, number]>, baseline: Record<string, number>) =>
  core(`
    const d = ${JSON.stringify(files)}.flatMap(([file, n]) =>
      Array.from({ length: n }, (_, i) => ({ file, line: i + 1, code: 2339, message: "m" })));
    const r = c.evaluate(d, ${JSON.stringify(baseline)});
    console.log(JSON.stringify({ ok: r.ok, failures: r.failures.map((f) => [f.kind, f.file]) }));
  `);

describe("check-types ratchet rules (B806)", () => {
  it("passes when every spec file is at its baseline and no source file has an error", () => {
    expect(judge([["src/a.spec.ts", 3]], { "src/a.spec.ts": 3 })).toEqual({
      ok: true,
      failures: [],
    });
  });

  it("RED: a NEW spec error (a file the baseline does not list) fails", () => {
    expect(judge([["src/new.spec.ts", 1]], {}).failures).toEqual([
      ["spec-regression", "src/new.spec.ts"],
    ]);
  });

  it("RED: a RISING count in a listed spec file fails", () => {
    expect(judge([["src/a.spec.ts", 4]], { "src/a.spec.ts": 3 }).failures).toEqual([
      ["spec-regression", "src/a.spec.ts"],
    ]);
  });

  it("RED: a FIXED error whose baseline was not lowered fails (the ratchet only moves down)", () => {
    expect(judge([["src/a.spec.ts", 1]], { "src/a.spec.ts": 3 }).failures).toEqual([
      ["stale-baseline", "src/a.spec.ts"],
    ]);
    expect(judge([], { "src/a.spec.ts": 3 }).failures).toEqual([
      ["stale-baseline", "src/a.spec.ts"],
    ]);
  });

  it("RED: a SOURCE error is zero-tolerance, and a baseline entry can never allow-list one", () => {
    expect(judge([["src/orders/orders.service.ts", 1]], {}).failures).toEqual([
      ["source-error", "src/orders/orders.service.ts"],
    ]);
    expect(
      judge([["src/orders/orders.service.ts", 1]], { "src/orders/orders.service.ts": 1 }).failures,
    ).toEqual([
      ["baseline-non-spec", "src/orders/orders.service.ts"],
      ["source-error", "src/orders/orders.service.ts"],
    ]);
  });

  it("RED: a diagnostic with no file (a config or global error) counts as a source error", () => {
    expect(judge([[null, 1]], {}).failures).toEqual([["source-error", "<no file>"]]);
  });

  it("lowering never raises an entry and drops files that reached zero", () => {
    const out = core(`
      const counts = new Map([["src/a.spec.ts", 1], ["src/b.spec.ts", 9]]);
      console.log(JSON.stringify(c.lowerBaseline({ "src/b.spec.ts": 2, "src/a.spec.ts": 3, "src/c.spec.ts": 5 }, counts)));
    `);
    expect(out).toEqual({ "src/a.spec.ts": 1, "src/b.spec.ts": 2 });
  });

  it("an out-of-memory worker exit becomes the actionable heap message, not a raw FATAL", () => {
    const out = core(`console.log(JSON.stringify([
      c.classifyWorkerExit({ status: 134, signal: null, stderr: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory" }),
      c.classifyWorkerExit({ status: 0, signal: null, stderr: "" }),
    ]));`);
    expect(out[0].kind).toBe("oom");
    expect(out[0].message).toContain("NODE_OPTIONS=--max-old-space-size=4096");
    expect(out[1]).toBeNull();
  });

  it("the api check-types script is the ratchet, and the ratchet sets the heap itself", () => {
    const pkg = JSON.parse(readFileSync(path.join(API_DIR, "package.json"), "utf8"));
    expect(pkg.scripts["check-types"]).toBe("node scripts/check-types-ratchet.mjs");
    const cli = readFileSync(path.join(API_DIR, "scripts/check-types-ratchet.mjs"), "utf8");
    expect(cli).toMatch(/--max-old-space-size=\$\{HEAP_MB\}/);
    expect(cli).toMatch(/NODE_OPTIONS/);
    expect(core(`console.log(JSON.stringify(c.HEAP_MB));`)).toBe(4096);
  });

  it("tsconfig.spec.json compiles the specs the default tsconfig excludes", () => {
    const spec = JSON.parse(readFileSync(path.join(API_DIR, "tsconfig.spec.json"), "utf8"));
    expect(spec.extends).toBe("./tsconfig.json");
    expect(spec.include).toEqual(["src/**/*.ts"]);
    expect(JSON.stringify(spec.exclude ?? [])).not.toMatch(/spec/);
  });
});
