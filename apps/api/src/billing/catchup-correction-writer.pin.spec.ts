/**
 * SA-1122 (i) OP-7 pin: CatchupCorrectionService is the ONE writer of the three catch-up correction markers.
 *  - the action names appear in exactly three non-spec source files: the service (writer), `catchup-markers.ts` (reader)
 *    and `audit-actions.constant.ts` (labels), and in no other file of apps/api (src, scripts) or the repo's scripts/;
 *  - of those, only the service writes an AuditLog row.
 * A second writer (a script with its own SQL, a controller inserting a row) fails here before it can drift from the first.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const API = join(__dirname, "..", "..");
const ROOTS = [join(API, "src"), join(API, "scripts"), join(API, "..", "..", "scripts")];
const NAMES = /COVERAGE_VOID|COVERAGE_RESTORE|BILLING_START_OVERRIDE/;
const WRITE =
  /auditLog\.(create|createMany|upsert)\b|INSERT\s+INTO\s+"?AuditLog|recordAdminAction\(|auditService\.log\(/i;

const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|js|mjs|cjs)$/.test(name) && !/\.(spec|test)\.(ts|js)$/.test(name))
      files.push(p);
  }
};
ROOTS.forEach(walk);
const rel = (p: string) =>
  relative(join(API, "..", ".."), p)
    .split(sep)
    .join("/");
const naming = files.filter((f) => NAMES.test(readFileSync(f, "utf8")));

describe("the catch-up correction markers have one writer", () => {
  it("only the service, the marker reader and the labels name the three actions", () => {
    expect(naming.map(rel).sort()).toEqual([
      "apps/api/src/billing/catchup-correction.service.ts",
      "apps/api/src/billing/catchup-markers.ts",
      "apps/api/src/platform-admin/audit-actions.constant.ts",
    ]);
  });

  it("of those, exactly one file writes an AuditLog row: the service", () => {
    const writers = naming.filter((f) => WRITE.test(readFileSync(f, "utf8"))).map(rel);
    expect(writers).toEqual(["apps/api/src/billing/catchup-correction.service.ts"]);
  });
});
