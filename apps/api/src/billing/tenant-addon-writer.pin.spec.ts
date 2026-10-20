/**
 * SA-788 P3 - `tenant-addon-writer.ts` is the ONLY code that writes `TenantAddon`.
 *
 * A row change that bypasses the writer leaves no `addon.state_changed` record, which is how the 10-12
 * deactivations went unseen. So under `apps/api/src` (specs excluded):
 *   - no `tenantAddon.(create|createMany|update|updateMany|upsert|delete|deleteMany)` outside the writer;
 *   - no raw `UPDATE "TenantAddon"` / `INSERT INTO "TenantAddon"` / `DELETE FROM "TenantAddon"`;
 *   - `AddonChangeSource` has exactly the 15 values below, so a new writer is a conscious edit.
 * The seed and cleanup scripts under `apps/api/scripts` and `scripts/` touch TEST tenants only and are listed
 * EXEMPT here with that reason (the one script that touches a live tenant's rows, `stamp-addon-comp.mjs`, writes the
 * record itself, A5).
 *
 * Shaped like `addon-lockheld-single-caller.sa769.spec.ts`: comments are blanked, the detector has a self-test, and
 * an empty scan fails.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  API_SRC_ROOT,
  collectSourceFiles,
  codeOnly,
  findCalls,
  scanSource,
} from "../testing/source-scan";
import { ADDON_CHANGE_SOURCES } from "./tenant-addon-writer";

const WRITER = "billing/tenant-addon-writer.ts";
const DIRECT_WRITE =
  /\btenantAddon\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
const RAW_WRITE =
  /(?:\bUPDATE\s+"TenantAddon"|\bINSERT\s+INTO\s+"TenantAddon"|\bDELETE\s+FROM\s+"TenantAddon")/i;

/** Source scripts that write TenantAddon directly, and why that is allowed. */
export const EXEMPT_SCRIPTS: Readonly<Record<string, string>> = {
  "scripts/demo-seed.js": "seeds the routeflow-demo tenant only",
  "scripts/e2e-seed.js": "seeds the e2e test tenant only",
  "../../scripts/enable-developer-mode.mjs": "developer-mode switch for a local/test tenant",
};
// Also exempt, outside this scan: `prisma/seed.ts` (the additive local dev seed) and the cleanup scripts
// `scripts/ux-audit-cleanup.js` / `scripts/nuke-tenant-data.js`, which delete TEST tenants' rows only.

export const EXPECTED_SOURCES = [
  "tenant.enable",
  "tenant.disable",
  "admin.enable",
  "admin.comp",
  "admin.uncomp",
  "admin.disable",
  "subscribe.pick",
  "subscribe.drop",
  "checkout.adopt",
  "plan.stop_billing",
  "plan.reprice",
  "plan_change.revert",
  "manual_activation.price",
  "lock.cancel_clear_item",
  "profile.apply",
];

describe("SA-788 P3 - the TenantAddon writer is the only writer", () => {
  it("walks a non-trivial number of source files (an empty scan must not report green)", () => {
    expect(collectSourceFiles().length).toBeGreaterThan(200);
    expect(scanSource(DIRECT_WRITE).filter((s) => s.file === WRITER).length).toBeGreaterThan(3);
  });

  it("the detector flags a planted direct write and a raw statement, and ignores a comment and a read (R14)", () => {
    const planted = `
      class Bad {
        async sneaky(tx: any) {
          await tx.tenantAddon.update({ where: { id: "x" }, data: { active: false } });
          await tx.$executeRaw\`UPDATE "TenantAddon" SET active = false\`;
        }
        async fine(tx: any) {
          // await tx.tenantAddon.update({ where: { id }, data: {} });
          /* DELETE FROM "TenantAddon" */
          await tx.tenantAddon.findMany({ where: {} });
          await tx.$queryRaw\`SELECT id FROM "TenantAddon" WHERE id = 1 FOR UPDATE\`;
        }
      }`.replace(/^ {6}/gm, "");
    expect(findCalls("billing/planted.ts", planted, DIRECT_WRITE).map((h) => h.fn)).toEqual([
      "sneaky",
    ]);
    expect(RAW_WRITE.test(codeOnly(planted))).toBe(true);
    const clean = planted.replace(/^.*sneaky[\s\S]*?\n {2}\}\n/m, "");
    expect(findCalls("billing/planted.ts", clean, DIRECT_WRITE)).toEqual([]);
    expect(RAW_WRITE.test(codeOnly(clean))).toBe(false);
  });

  it("no tenantAddon write call exists outside tenant-addon-writer.ts", () => {
    expect(
      scanSource(DIRECT_WRITE)
        .filter((s) => s.file !== WRITER)
        .map((s) => `${s.file}#${s.fn}:${s.line}`),
    ).toEqual([]);
  });

  it("no raw INSERT / UPDATE / DELETE on TenantAddon exists in src", () => {
    const hits = collectSourceFiles()
      .filter((f) => RAW_WRITE.test(codeOnly(fs.readFileSync(f, "utf8"))))
      .map((f) => path.relative(API_SRC_ROOT, f).replace(/\\/g, "/"));
    expect(hits).toEqual([]);
  });

  it("AddonChangeSource has exactly the 15 sanctioned values (a new writer is a conscious edit)", () => {
    expect([...ADDON_CHANGE_SOURCES]).toEqual(EXPECTED_SOURCES);
    expect(new Set(ADDON_CHANGE_SOURCES).size).toBe(15);
  });

  it("every script that writes TenantAddon directly is listed EXEMPT with a reason (no silent new script)", () => {
    const apiRoot = path.resolve(API_SRC_ROOT, "..");
    const roots = [path.join(apiRoot, "scripts"), path.resolve(apiRoot, "..", "..", "scripts")];
    const found: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(full);
        } else if (/\.(c|m)?js$/.test(e.name)) {
          const code = codeOnly(fs.readFileSync(full, "utf8"));
          if (DIRECT_WRITE.test(code) && !/\.(spec|test)\./.test(e.name)) {
            found.push(path.relative(apiRoot, full).replace(/\\/g, "/"));
          }
        }
      }
    };
    roots.forEach(walk);
    expect(found.sort()).toEqual(Object.keys(EXEMPT_SCRIPTS).sort());
  });
});
