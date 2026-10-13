import { LabelFakeDb } from "../product-categories/testing/label-fake-db";
import {
  LABEL_KEPT_ON_REPARENT_ACTION,
  LabelLockTimeoutError,
} from "../product-categories/label-writer";
import { effectiveCategoryIdsUnder, keepLabelsOnReparent } from "./keep-labels-on-reparent";

/**
 * H2: reparenting a variant must never silently drop a label (a legal selling ban) that the variant carried
 * through its OLD parent. Whatever was effective before and is not after becomes the variant's OWN INCLUDE,
 * written by the single label writer with an audit row, in the same transaction.
 */
const ACTOR = { id: "u1", name: "Ann" };

function world() {
  const db = new LabelFakeDb();
  db.addCategory("ca", "CA ban").addCategory("ny", "NY ban").addCategory("misc", "Misc");
  db.addProduct("P1").addProduct("P2").addProduct("P3").addProduct("C", "P1");
  db.addLabel("P1", "ca", "INCLUDE");
  db.addLabel("P1", "ny", "INCLUDE");
  return db;
}

const run = (
  db: LabelFakeDb,
  args: Partial<Parameters<typeof keepLabelsOnReparent>[1]> & {
    productId: string;
    fromParentId: string | null;
    toParentId: string | null;
  },
) =>
  db
    .prisma("t1")
    .tenantTransaction((tx: any) =>
      keepLabelsOnReparent(tx, { tenantId: "t1", actor: ACTOR, text: null, ...args }),
    );

const effectiveOf = (db: LabelFakeDb, productId: string, parentId: string | null) =>
  db
    .prisma("t1")
    .tenantTransaction((tx: any) => effectiveCategoryIdsUnder(tx, "t1", productId, parentId));

describe("keepLabelsOnReparent", () => {
  it("(1) a variant moved to an UNLABELLED parent keeps the inherited bans as its own INCLUDEs", async () => {
    const db = world();
    expect([...(await effectiveOf(db, "C", "P1"))].sort()).toEqual(["ca", "ny"]);
    expect([...(await effectiveOf(db, "C", "P2"))]).toEqual([]); // the bug: both vanish

    const out = await run(db, { productId: "C", fromParentId: "P1", toParentId: "P2" });

    expect(out.keptLabels).toEqual(["CA ban", "NY ban"]);
    for (const c of ["ca", "ny"]) {
      const row = db.label("C", c);
      expect(row).toMatchObject({ mode: "INCLUDE", tenantId: "t1", createdById: "u1" });
      expect(row?.parentProductIdAtWrite).toBeNull();
    }
    // the engine's own rule now keeps both bans on the child under its NEW parent
    expect([...(await effectiveOf(db, "C", "P2"))].sort()).toEqual(["ca", "ny"]);
    expect(db.audits).toHaveLength(2);
    expect(db.audits[0]).toMatchObject({
      tenantId: "t1",
      userId: "u1",
      action: LABEL_KEPT_ON_REPARENT_ACTION,
      entityType: "Product",
      entityId: "C",
    });
    expect(db.audits[0].meta).toMatchObject({
      categoryId: "ca",
      source: "reparent",
      fromParentProductId: "P1",
      toParentProductId: "P2",
    });
  });

  it("(2) unlinking to standalone keeps every inherited label as an own INCLUDE", async () => {
    const db = world();
    const out = await run(db, { productId: "C", fromParentId: "P1", toParentId: null });
    expect(out.keptLabels).toEqual(["CA ban", "NY ban"]);
    expect([...(await effectiveOf(db, "C", null))].sort()).toEqual(["ca", "ny"]);
  });

  it("(3) keeps only what is LOST: a label the new parent also carries gets no own row", async () => {
    const db = world();
    db.addLabel("P3", "ca", "INCLUDE");
    const out = await run(db, { productId: "C", fromParentId: "P1", toParentId: "P3" });
    expect(out.keptLabels).toEqual(["NY ban"]);
    expect(db.label("C", "ca")).toBeUndefined();
    expect(db.label("C", "ny")?.mode).toBe("INCLUDE");
    expect(db.audits).toHaveLength(1);
  });

  it("(3b) several children each materialise their own (one call per child)", async () => {
    const db = world();
    db.addProduct("C2", "P1");
    await run(db, { productId: "C", fromParentId: "P1", toParentId: "P2" });
    await run(db, { productId: "C2", fromParentId: "P1", toParentId: "P2" });
    expect(
      db.labels
        .filter((l) => l.productId === "C2")
        .map((l) => l.categoryId)
        .sort(),
    ).toEqual(["ca", "ny"]);
    expect(db.audits.map((a) => a.entityId).sort()).toEqual(["C", "C", "C2", "C2"]);
  });

  it("(4) controls: nothing lost writes nothing (own INCLUDEs, same labels, no old parent)", async () => {
    const db = world();
    db.addLabel("C", "ca", "INCLUDE");
    db.addLabel("C", "ny", "INCLUDE");
    const own = await run(db, { productId: "C", fromParentId: "P1", toParentId: "P2" });
    expect(own.keptLabels).toEqual([]);

    const db2 = world();
    db2.addLabel("P2", "ca", "INCLUDE");
    db2.addLabel("P2", "ny", "INCLUDE");
    const same = await run(db2, { productId: "C", fromParentId: "P1", toParentId: "P2" });
    expect(same.keptLabels).toEqual([]);
    expect(db2.labels.filter((l) => l.productId === "C")).toEqual([]);
    expect(db2.audits).toEqual([]);

    const db3 = world();
    db3.addProduct("S"); // standalone with no labels, adopted by an unlabelled family
    const none = await run(db3, { productId: "S", fromParentId: null, toParentId: "P2" });
    expect(none.keptLabels).toEqual([]);
    expect(db3.audits).toEqual([]);
    expect(db3.calls.some((c) => ["create", "update", "deleteMany"].includes(c.op))).toBe(false);
  });

  it("(4b) a variant's opt-out is not 'kept': it never carried the label", async () => {
    const db = world();
    db.addLabel("C", "ca", "EXCLUDE", "P1");
    const out = await run(db, { productId: "C", fromParentId: "P1", toParentId: "P2" });
    expect(out.keptLabels).toEqual(["NY ban"]);
    expect(db.label("C", "ca")?.mode).toBe("EXCLUDE");
  });

  it("(4c) an INERT opt-out (pinned to no parent) does not block the keep: it is replaced by an INCLUDE", async () => {
    const db = world();
    db.addLabel("C", "ca", "EXCLUDE", null); // inert: the label still applies via P1
    expect([...(await effectiveOf(db, "C", "P1"))].sort()).toEqual(["ca", "ny"]);
    const out = await run(db, { productId: "C", fromParentId: "P1", toParentId: "P2" });
    expect(out.keptLabels).toEqual(["CA ban", "NY ban"]);
    expect(db.label("C", "ca")).toMatchObject({ mode: "INCLUDE" });
    expect(db.labels.filter((l) => l.productId === "C" && l.categoryId === "ca")).toHaveLength(1);
    expect([...(await effectiveOf(db, "C", "P2"))].sort()).toEqual(["ca", "ny"]);
  });

  it("(4d) a label removed on purpose from the NEW family is still kept (never skipped as 'parent-removed')", async () => {
    const db = world();
    const out = await run(db, { productId: "C", fromParentId: "P1", toParentId: "P2" });
    expect(out.keptLabels).toHaveLength(2);
  });

  it("(4e) an ARCHIVED label still bans, so it is kept too", async () => {
    const db = world();
    db.categories.find((c) => c.id === "ca")!.archivedAt = new Date("2026-01-01T00:00:00Z");
    const out = await run(db, { productId: "C", fromParentId: "P1", toParentId: "P2" });
    expect(out.keptLabels).toEqual(["CA ban", "NY ban"]);
  });

  it("(4f) labels chain through a grandparent", async () => {
    const db = new LabelFakeDb();
    db.addCategory("ca", "CA ban");
    db.addProduct("G").addProduct("P", "G").addProduct("C", "P").addProduct("Q");
    db.addLabel("G", "ca", "INCLUDE");
    const out = await run(db, { productId: "C", fromParentId: "P", toParentId: "Q" });
    expect(out.keptLabels).toEqual(["CA ban"]);
  });

  it("(5) tenant isolation: another tenant's label rows and categories are never read or written", async () => {
    const db = world();
    db.addCategory("ca-t2", "CA ban", "t2");
    db.addProduct("X2", null, "t2");
    db.addLabel("X2", "ca-t2", "INCLUDE", null, "t2");
    const before = JSON.stringify(db.labels.filter((l) => l.tenantId === "t2"));
    await run(db, { productId: "C", fromParentId: "P1", toParentId: "P2" });
    expect(JSON.stringify(db.labels.filter((l) => l.tenantId === "t2"))).toBe(before);
    expect(db.labels.filter((l) => l.tenantId === "t1" && l.productId === "C")).toHaveLength(2);
    // every read the helper issued named the tenant itself (the fake would otherwise return t2 rows)
    for (const c of db.calls.filter((c) =>
      ["productCategory", "product", "productCategoryLabel"].includes(c.model),
    )) {
      if (c.op === "create") expect(c.args.data.tenantId ?? "t1").toBe("t1");
      else expect(c.args.where?.tenantId).toBe("t1");
    }
    expect(db.audits.every((a) => a.tenantId === "t1")).toBe(true);
  });

  it("(5b) a category of another tenant is not materialised", async () => {
    const db = world();
    db.addLabel("P1", "ca-t2", "INCLUDE"); // corrupt: t1 product points at t2's category
    db.addCategory("ca-t2", "Foreign", "t2");
    const out = await run(db, { productId: "C", fromParentId: "P1", toParentId: "P2" });
    expect(out.keptLabels).toEqual(["CA ban", "NY ban"]);
    expect(db.label("C", "ca-t2")).toBeUndefined();
  });

  it("(6) atomic: a failing write rolls the whole keep back and the error propagates", async () => {
    const db = world();
    db.auditError = new Error("audit down");
    await expect(run(db, { productId: "C", fromParentId: "P1", toParentId: "P2" })).rejects.toThrow(
      "audit down",
    );
    expect(db.labels.filter((l) => l.productId === "C")).toEqual([]);
    expect(db.audits).toEqual([]);
  });

  it("(6b) a busy label lock is the coded 409, not a swallowed skip", async () => {
    const db = world();
    db.lockError = Object.assign(new Error("lock timeout"), { meta: { code: "55P03" } });
    await expect(
      run(db, { productId: "C", fromParentId: "P1", toParentId: "P2" }),
    ).rejects.toBeInstanceOf(LabelLockTimeoutError);
  });

  it("runs the add-only category-text sync after a keep (and not for a no-loss move)", async () => {
    const db = world();
    db.addCategory("snack", "Snacks");
    await run(db, { productId: "C", fromParentId: "P1", toParentId: "P2", text: "Snacks" });
    expect(db.label("C", "snack")?.mode).toBe("INCLUDE");

    const db2 = world();
    db2.addCategory("snack", "Snacks");
    db2.addLabel("P2", "ca", "INCLUDE");
    db2.addLabel("P2", "ny", "INCLUDE");
    await run(db2, { productId: "C", fromParentId: "P1", toParentId: "P2", text: "Snacks" });
    expect(db2.label("C", "snack")).toBeUndefined();
  });
});
