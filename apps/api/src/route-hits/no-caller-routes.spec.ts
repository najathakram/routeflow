/**
 * W3: the checked-in no-caller route list (apps/api/scripts/data/no-caller-routes.json, from the dead-weight
 * audit) must not rot. Every listed route must still exist as a real controller route (so a route that was
 * removed or renamed fails here and the list gets refreshed), and the report script's self-test must pass.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.join(__dirname, "..");
const LIST: Array<{ route: string; controller: string; deadConfidence: string }> = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../scripts/data/no-caller-routes.json"), "utf8"),
);

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) controllerFiles(full, out);
    else if (/\.controller\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

const join = (...parts: string[]) => "/" + parts.join("/").split("/").filter(Boolean).join("/");

/** Every `METHOD /api/v1/<controller prefix>/<handler path>` declared by a literal @Controller/@Get/... */
function declaredRoutes(): Set<string> {
  const out = new Set<string>();
  for (const file of controllerFiles(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    // A file may declare several controllers (routes + route-runs): each handler belongs to the
    // nearest @Controller above it.
    const ctrlRe =
      /@Controller\(\s*(?:["'`]([^"'`]*)["'`]|\{[^}]*path:\s*["'`]([^"'`]*)["'`][^}]*\})?\s*\)/g;
    const ctrls: Array<{ at: number; prefix: string }> = [];
    for (let c = ctrlRe.exec(text); c; c = ctrlRe.exec(text)) {
      ctrls.push({ at: c.index, prefix: c[1] ?? c[2] ?? "" });
    }
    const re = /@(Get|Post|Put|Patch|Delete)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const owner = [...ctrls].reverse().find((c) => c.at < m.index);
      out.add(`${m[1].toUpperCase()} ${join("api/v1", owner?.prefix ?? "", m[2] ?? "")}`);
    }
  }
  return out;
}

describe("no-caller route list (W3)", () => {
  const declared = declaredRoutes();

  it("has 111 unique routes in the `METHOD /api/v1/...` form the counter emits", () => {
    expect(LIST).toHaveLength(111);
    expect(new Set(LIST.map((r) => r.route)).size).toBe(111);
    for (const r of LIST) expect(r.route).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\//);
  });

  it("every listed route still exists as a controller route (the list cannot rot)", () => {
    const missing = LIST.filter((r) => !declared.has(r.route)).map((r) => r.route);
    expect(missing).toEqual([]);
  });

  it("the report script's self-test passes (read-only guard, zero set, observed-days rule)", () => {
    const out = execFileSync(
      process.execPath,
      [path.join(__dirname, "../../scripts/report-zero-call-routes.mjs"), "--self-test"],
      { encoding: "utf8" },
    );
    expect(out).toMatch(/self-test: all 7 passed/);
  });
});
