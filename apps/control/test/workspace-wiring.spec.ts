/**
 * T5 (R2) — the `apps/control` workspace is wired into the monorepo so turbo runs its tasks.
 *
 * Asserts package.json identity + the four turbo-visible scripts, the launcher script names in the
 * root package.json, and the scaffold files WP0 ships. Files are read at test time.
 */

import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CONTROL = path.join(REPO_ROOT, "apps", "control");

function readJson(file: string): Record<string, any> {
  expect(fs.existsSync(file)).toBe(true);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("apps/control workspace wiring (T5)", () => {
  const pkg = () => readJson(path.join(CONTROL, "package.json"));

  it("is the private @routeflow/control package", () => {
    const p = pkg();
    expect(p.name).toBe("@routeflow/control");
    expect(p.private).toBe(true);
  });

  it("declares the scripts turbo runs, with the planned commands", () => {
    const s = pkg().scripts ?? {};
    expect(s.build).toBe("tsc -p tsconfig.build.json");
    expect(s.start).toBe("node dist/main.js");
    expect(s["dev:control"]).toBe("node --watch dist/main.js");
    expect(s.test).toBe("jest");
    expect(s.lint).toBe('eslint "src/**/*.ts"');
    expect(s["check-types"]).toBe("tsc --noEmit -p tsconfig.json");
  });

  it("has no runtime dependencies at all", () => {
    const deps = pkg().dependencies;
    expect(deps === undefined || Object.keys(deps).length === 0).toBe(true);
  });

  it("pins the toolchain devDependencies", () => {
    const dev = pkg().devDependencies ?? {};
    for (const name of ["jest", "ts-jest", "@types/node", "typescript", "eslint"]) {
      expect(dev[name]).toBeDefined();
    }
  });

  it("root package.json exposes the control and ctl launcher scripts", () => {
    const root = readJson(path.join(REPO_ROOT, "package.json"));
    expect(root.scripts.control).toBe("node apps/control/bin/ctl.mjs serve");
    expect(root.scripts.ctl).toBe("node apps/control/bin/ctl.mjs");
  });

  it("ships the scaffold files", () => {
    const files = [
      "tsconfig.json",
      "tsconfig.build.json",
      "eslint.config.mjs",
      "Dockerfile",
      "railway.toml",
      "README.md",
      path.join("src", "main.ts"),
      path.join("bin", "ctl.mjs"),
    ];
    const missing = files.filter((f) => !fs.existsSync(path.join(CONTROL, f)));
    expect(missing).toEqual([]);
    expect(fs.existsSync(path.join(REPO_ROOT, ".claude", "control", "README.md"))).toBe(true);
  });

  it("gitignores the per-machine lane file", () => {
    const gi = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
    expect(gi.split(/\r?\n/).map((l) => l.trim())).toContain(".claude/control/.lane");
  });
});
