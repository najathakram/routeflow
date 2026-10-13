import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { labelNameKey, labelText } from "./label-writer";

/**
 * labels-from-categories (SA-approved) — the PURE plan and the structural rules, no database. The script is ESM
 * and this suite runs under ts-jest's CommonJS transform, so the plan cases run in ONE `node --input-type=module`
 * child that imports the real module. The real-Postgres end-to-end cases live in labels-from-categories.db.spec.ts.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/labels-from-categories.mjs");
const code = fs.readFileSync(SCRIPT, "utf8");

function runModule(body: string) {
  const src = `
    import * as m from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
    const keyOf = (s) => (s ?? "").normalize("NFC").trim().replace(/\\s+/g, " ").toLowerCase();
    const textOf = (s) => (s ?? "").normalize("NFC").trim().replace(/\\s+/g, " ");
    ${body}`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "" },
  });
  if (res.status !== 0) throw new Error(res.stderr);
  return JSON.parse(res.stdout.trim().split("\n").pop()!);
}

describe("labels-from-categories — the plan", () => {
  it("the normalisers: NFC, trim, collapsed whitespace; the key is case-folded; blank is no label", () => {
    expect(labelText("  Frozen \t  Foods ")).toBe("Frozen Foods");
    expect(labelNameKey("FROZEN  foods")).toBe("frozen foods");
    expect(labelNameKey("Café")).toBe(labelNameKey("Café")); // NFC
    expect(labelNameKey("   ")).toBe("");
    expect(labelNameKey(null)).toBe("");
  });

  it("merges case/space variants into ONE label named by the most common casing, and LISTS the variants", () => {
    const out = runModule(`
      const plan = m.planLabels({
        products: [
          { id: "p1", category: "Snacks" }, { id: "p2", category: " Snacks " }, { id: "p3", category: "snacks" },
          { id: "p4", category: "Frozen  Foods" }, { id: "p5", category: "frozen foods" },
          { id: "p6", category: "  " },
        ],
        existing: [], memberships: [], keyOf, textOf,
      });
      console.log(JSON.stringify({ names: plan.labels.map((l) => [l.name, l.add.length]), merged: plan.merged, counts: plan.counts, rows: plan.rows }));`);
    expect(out.names).toEqual([
      ["Frozen Foods", 2], // a tie: code-point order, the capitalised form wins
      ["Snacks", 3],
    ]);
    expect(out.merged).toEqual([
      { name: "Frozen Foods", variants: ["Frozen Foods", "frozen foods"] },
      { name: "Snacks", variants: ["Snacks", "snacks"] },
    ]);
    expect(out.counts).toMatchObject({ blank: 1, newLabels: 2, memberships: 5 });
    expect(out.rows).toBe(7);
  });

  it("reuses an existing label by key, skips an archived match and an ambiguous pair, never flips an opt-out", () => {
    const out = runModule(`
      const plan = m.planLabels({
        products: [
          { id: "a", category: "Drinks" }, { id: "b", category: "drinks" }, { id: "c", category: "Drinks" },
          { id: "d", category: "Candy" }, { id: "e", category: "Tea" },
        ],
        existing: [
          { id: "L-drinks", name: "drinks", archivedAt: null },
          { id: "L-candy", name: "candy", archivedAt: "2026-01-01" },
          { id: "L-tea1", name: "Tea", archivedAt: null }, { id: "L-tea2", name: "TEA ", archivedAt: null },
        ],
        memberships: [
          { productId: "a", categoryId: "L-drinks", mode: "INCLUDE" },
          { productId: "b", categoryId: "L-drinks", mode: "EXCLUDE" },
        ],
        keyOf, textOf,
      });
      console.log(JSON.stringify({ labels: plan.labels.map((l) => [l.name, l.existingId, l.add]), archived: plan.archived, ambiguous: plan.ambiguous, counts: plan.counts }));`);
    expect(out.labels).toEqual([["drinks", "L-drinks", ["c"]]]); // existing name kept; only c added
    expect(out.archived).toEqual([{ name: "candy", products: 1 }]);
    expect(out.ambiguous).toEqual([{ name: "Tea", products: 1 }]);
    expect(out.counts).toMatchObject({ alreadyIn: 1, optedOut: 1, newLabels: 0, memberships: 1 });
  });

  it("a fully labelled tenant plans 0 rows (a re-run is a no-op)", () => {
    const out = runModule(`
      const plan = m.planLabels({
        products: [{ id: "a", category: "Snacks" }, { id: "b", category: "snacks" }],
        existing: [{ id: "L", name: "Snacks", archivedAt: null }],
        memberships: [{ productId: "a", categoryId: "L", mode: "INCLUDE" }, { productId: "b", categoryId: "L", mode: "INCLUDE" }],
        keyOf, textOf,
      });
      console.log(JSON.stringify({ rows: plan.rows, create: plan.create.length }));`);
    expect(out).toEqual({ rows: 0, create: 0 });
  });

  it("the live confirmation phrase carries the counts and the tenant id", () => {
    const out = runModule(`
      console.log(JSON.stringify(m.confirmPhrase({ addCount: 1700, create: new Array(42) }, "t-1")));`);
    expect(out).toBe("LABEL 1700 PRODUCTS WITH 42 NEW LABELS FOR t-1");
  });

  it("the test-only writer override is honoured only inside a Jest worker", () => {
    const out = runModule(`
      console.log(JSON.stringify({
        jest: m.writerPath({ LABELS_WRITER_MODULE: "/tmp/w.js", JEST_WORKER_ID: "1" }),
        prod: m.writerPath({ LABELS_WRITER_MODULE: "/tmp/w.js" }),
      }));`);
    expect(out.jest).toBe("/tmp/w.js");
    expect(out.prod).toMatch(/dist[\\/]product-categories[\\/]label-writer\.js$/);
  });
});

describe("labels-from-categories — structural rules (SA)", () => {
  it("memberships only through the single writer: no raw insert, no pin, no Product.category write", () => {
    expect(code).toContain('join(HERE, "..", "dist", "product-categories", "label-writer.js")');
    expect(code).toContain("writer.addIncludeIfAbsent(tx,");
    expect(code).not.toMatch(/productCategoryLabel\.(create|createMany|upsert|update|delete)/);
    expect(code).not.toContain("parentProductIdAtWrite");
    expect(code).not.toMatch(/\.product\.(update|updateMany|upsert)\(/);
    expect(code).not.toMatch(/productCategory\.(update|delete|updateMany|deleteMany)/); // never renames/archives
  });

  it("the dry run is a READ ONLY, REPEATABLE READ snapshot with statement and lock timeouts", () => {
    expect(code).toContain("SET TRANSACTION READ ONLY");
    expect(code).toContain('isolationLevel: "RepeatableRead"');
    expect(code).toMatch(/SET LOCAL statement_timeout/);
    expect(code).toMatch(/SET LOCAL lock_timeout/);
  });

  it("a live write is gated: backup, expect-rows, the protected-tenant guard and the live override + typed phrase", () => {
    expect(code).toContain('hasBackupAttestation(argv, "--backup-taken")');
    expect(code).toContain("--expect-rows");
    expect(code).toContain("confirmProtectedOverride(");
    expect(code).toContain("assertWritableTenant(");
    expect(code).toContain('has("--live-tenant-override")');
    expect(code).toContain("loadProtectedSlugs(process.env, url)");
    expect(code).toContain("couponFull: true"); // the paying predicate needs it selected
  });
});
