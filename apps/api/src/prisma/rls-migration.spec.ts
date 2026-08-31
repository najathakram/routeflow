import fs from "node:fs";
import path from "node:path";

// REG-G8b / R9 — the FALSIFIABLE half of G8.
//
// prisma-isolation.spec.ts characterizes engine behavior that already existed; this file is
// R9's actual proof obligation. It reads the filesystem — no mocks, nothing this suite can
// configure to agree with itself — and every assertion below is red on the untouched branch,
// where `apps/api/prisma/migrations/20260909000000_rls/` simply does not exist.
//
// Why the shape of these assertions matters: the policy loop in the migration swallows every
// per-table failure (`WHEN OTHERS => RAISE NOTICE`), so `prisma migrate deploy` exiting 0
// proves NOTHING about whether RLS actually landed. The migration therefore has to carry its
// own post-apply assertion that RAISES. And because that assertion re-declares the table list
// a SECOND time, the two lists drifting apart would arm one set of tables and verify another —
// silently. The drift check below is the only thing standing between that and production.

const MIGRATION_DIR = path.join(
  __dirname,
  "..",
  "..",
  "prisma",
  "migrations",
  "20260909000000_rls",
);
const MIGRATION_SQL = path.join(MIGRATION_DIR, "migration.sql");

/** Every `tables TEXT[] := ARRAY[ ... ];` literal in the file, in source order. */
function tableListLiterals(sql: string): string[][] {
  return [...sql.matchAll(/tables\s+TEXT\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]\s*;/g)].map((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((t) => t[1]),
  );
}

describe("REG-G8b RLS migration (R9 / T-G8b)", () => {
  it("REG-G8b: the RLS migration occupies slot 20260909000000_rls", () => {
    // rls.sql sitting outside migration control was the whole defect: nothing applied it, and
    // nothing could tell whether it had ever been applied.
    expect(fs.existsSync(MIGRATION_SQL)).toBe(true);
  });

  it("REG-G8b: every policied table is armed with ENABLE + FORCE and a tenant_isolation policy", () => {
    const sql = fs.readFileSync(MIGRATION_SQL, "utf8");
    const [policied] = tableListLiterals(sql);

    // A sanity floor: the tenant-scoped surface is dozens of tables, so a regex that drifted
    // and parsed one or two names must not read as "all tables armed".
    expect(policied.length).toBeGreaterThan(40);
    // Spot-anchor the tables that hold the money and the tenancy root — if the list is ever
    // trimmed, these are the ones whose loss is unrecoverable.
    for (const critical of ["User", "Customer", "Order", "Invoice", "Payment", "Transaction"]) {
      expect(policied).toContain(critical);
    }

    // The loop arms the list by `format()`, not by per-table literals, so assert the three
    // statements the loop must execute for each name it iterates.
    expect(sql).toMatch(/ALTER TABLE[^;']*ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/ALTER TABLE[^;']*FORCE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/CREATE POLICY\s+tenant_isolation/i);
  });

  it("REG-G8b: the assertion block checks the SAME table list the policy loop arms", () => {
    // Two copies of the list live in this file (the arming loop and the post-apply assertion).
    // If they drift, the migration arms one set and verifies another — and the verification
    // passes while an unarmed table ships wide open.
    const sql = fs.readFileSync(MIGRATION_SQL, "utf8");
    const lists = tableListLiterals(sql);
    expect(lists).toHaveLength(2);
    expect(lists[1]).toEqual(lists[0]);
  });

  it("REG-G8b: the migration asserts relrowsecurity post-apply, so migrate deploy cannot exit 0 with RLS off", () => {
    const sql = fs.readFileSync(MIGRATION_SQL, "utf8");
    // The arming loop deliberately swallows failures…
    expect(sql).toMatch(/WHEN OTHERS THEN\s*\n?\s*RAISE NOTICE/i);
    // …so the file must end with a block that re-reads the catalog and RAISES.
    expect(sql).toMatch(/relrowsecurity/);
    // FORCE is not optional: without relforcerowsecurity the table OWNER — which is the app's
    // own role on Railway — bypasses every policy, and RLS is decorative.
    expect(sql).toMatch(/relforcerowsecurity/);
    // ENABLE+FORCE landing while CREATE POLICY is swallowed leaves a DENY-ALL table, so the
    // policy's own existence has to be part of the assertion too.
    expect(sql).toMatch(/pg_policies/);
    expect(sql).toMatch(/RAISE\s+EXCEPTION/i);
  });
});
