import { Logger } from "@nestjs/common";
import type { InvoiceDisplayUnitView } from "@routeflow/types";
import {
  clearIssueDisplayUnits,
  freezeDraftIssueUnits,
  freezeIssueUnitsFromCatalog,
  itemsWithDisplayUnits,
  loadDisplayUnitCatalog,
  loadStopDisplayUnitCatalog,
  resolveDraftIssueUnits,
  resolveFromCatalog,
  resolveIssueDisplayUnits,
  resolveLiveDisplayUnits,
  withItemDisplayUnits,
  writeIssueBaseLabels,
  writeIssueDisplayUnits,
} from "./invoice-display-unit";

// SA-827 (T2): live display-unit resolve + the one-time snapshot at first issue. Acme fixtures only.
const TENANT = "tenant-acme";
const CUSTOMER = "cust-acme";

const productRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  unit: "Box",
  packLabel: "Box",
  baseUnitLabel: "Piece",
  unitsPerBox: 15,
  pricePerUnit: "30.01",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  orderUnitRef: null,
  packAuto: null,
  invoiceUnitRef: null,
  ...extra,
});

interface Fx {
  customer?: { pricingTier: number | null; invoiceUnitDefault?: string } | null;
  customerPrices?: unknown[];
  tierUnits?: unknown[];
  products?: unknown[];
  units?: unknown[];
  business?: string | null;
  invoice?: { customerId: string } | null;
  items?: unknown[];
}

function makeDb(fx: Fx) {
  const db = {
    customer: { findFirst: jest.fn().mockResolvedValue(fx.customer ?? { pricingTier: 1 }) },
    customerPrice: { findMany: jest.fn().mockResolvedValue(fx.customerPrices ?? []) },
    productTierUnit: { findMany: jest.fn().mockResolvedValue(fx.tierUnits ?? []) },
    product: { findMany: jest.fn().mockResolvedValue(fx.products ?? []) },
    productUnit: { findMany: jest.fn().mockResolvedValue(fx.units ?? []) },
    systemConfig: {
      findFirst: jest.fn().mockResolvedValue(fx.business == null ? null : { value: fx.business }),
    },
    invoice: {
      findFirst: jest
        .fn()
        .mockResolvedValue(fx.invoice === undefined ? { customerId: CUSTOMER } : fx.invoice),
    },
    invoiceItem: {
      findMany: jest.fn().mockResolvedValue(fx.items ?? []),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  return db;
}

const flag = (on: boolean | "throw") => ({
  hasFlagStrict: jest.fn().mockImplementation(async () => {
    if (on === "throw") throw new Error("flag read failed");
    return on;
  }),
});

const invoice = (productIds: Array<string | null>) => ({
  customerId: CUSTOMER,
  items: productIds.map((p, i) => ({ id: `it-${i}`, productId: p })),
});

describe("resolveLiveDisplayUnits", () => {
  it("flag off: every item is legacy and no catalog query runs", async () => {
    const db = makeDb({ products: [productRow("p1")], business: "smallest" });
    const live = await resolveLiveDisplayUnits(db as any, TENANT, invoice(["p1"]), flag(false));
    expect(live.get("it-0")).toEqual({ kind: "legacy", label: null });
    expect(db.product.findMany).not.toHaveBeenCalled();
  });

  it("a failed flag read counts as flag off", async () => {
    const db = makeDb({ products: [productRow("p1")], business: "smallest" });
    const live = await resolveLiveDisplayUnits(db as any, TENANT, invoice(["p1"]), flag("throw"));
    expect(live.get("it-0")).toEqual({ kind: "legacy", label: null });
  });

  it("flag on + business 'smallest': a boxed product resolves to pieces, one batched query per table", async () => {
    const db = makeDb({ products: [productRow("p1"), productRow("p2")], business: "smallest" });
    const live = await resolveLiveDisplayUnits(
      db as any,
      TENANT,
      invoice(["p1", "p2", null]),
      flag(true),
    );
    expect(live.get("it-0")).toEqual({ kind: "pieces", label: "Piece" });
    expect(live.get("it-1")).toEqual({ kind: "pieces", label: "Piece" });
    expect(live.get("it-2")).toEqual({ kind: "legacy", label: null });
    for (const m of [db.product, db.customerPrice, db.productTierUnit, db.productUnit])
      expect(m.findMany).toHaveBeenCalledTimes(1);
  });

  it("nothing set: legacy (a tenant that never chose sees no change)", async () => {
    const db = makeDb({ products: [productRow("p1")] });
    const live = await resolveLiveDisplayUnits(db as any, TENANT, invoice(["p1"]), flag(true));
    expect(live.get("it-0")).toEqual({ kind: "legacy", label: null });
  });

  it("the customer's own product override ('pack') beats the business 'smallest'", async () => {
    const db = makeDb({
      products: [productRow("p1")],
      business: "smallest",
      customerPrices: [{ productId: "p1", pricingTier: null, invoiceUnitRef: "pack" }],
    });
    const live = await resolveLiveDisplayUnits(db as any, TENANT, invoice(["p1"]), flag(true));
    expect(live.get("it-0")).toEqual({ kind: "legacy", label: null });
  });

  it("customer default PIECES on a flag-OFF tenant: product lines read pieces (no ladder), no catalog query runs", async () => {
    const db = makeDb({
      customer: { pricingTier: 1, invoiceUnitDefault: "PIECES" },
      products: [productRow("p1")],
    });
    const live = await resolveLiveDisplayUnits(
      db as any,
      TENANT,
      invoice(["p1", null]),
      flag(false),
    );
    expect(live.get("it-0")).toEqual({ kind: "pieces", label: "Piece" });
    expect(live.get("it-1")).toEqual({ kind: "legacy", label: null });
    expect(db.product.findMany).not.toHaveBeenCalled();
    expect(db.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ invoiceUnitDefault: true }) }),
    );
  });

  it("customer default PIECES on a flag-on tenant reads the ladder's base label", async () => {
    const db = makeDb({
      customer: { pricingTier: 1, invoiceUnitDefault: "PIECES" },
      products: [productRow("p1", { baseUnitLabel: "Stick" })],
    });
    const live = await resolveLiveDisplayUnits(db as any, TENANT, invoice(["p1"]), flag(true));
    expect(live.get("it-0")).toEqual({ kind: "pieces", label: "Stick" });
  });

  it("customer default PACK beats a business 'smallest': legacy", async () => {
    const db = makeDb({
      customer: { pricingTier: 1, invoiceUnitDefault: "PACK" },
      products: [productRow("p1")],
      business: "smallest",
    });
    const live = await resolveLiveDisplayUnits(db as any, TENANT, invoice(["p1"]), flag(true));
    expect(live.get("it-0")).toEqual({ kind: "legacy", label: null });
  });

  it("customer default PIECES beats the product's own 'pack' ref: pieces", async () => {
    const db = makeDb({
      customer: { pricingTier: 1, invoiceUnitDefault: "PIECES" },
      products: [productRow("p1", { invoiceUnitRef: "pack" })],
    });
    const live = await resolveLiveDisplayUnits(db as any, TENANT, invoice(["p1"]), flag(true));
    expect(live.get("it-0")).toEqual({ kind: "pieces", label: "Piece" });
  });

  it("SA-827a: a CustomerPrice 'base' ref beats the customer default PACK: pieces", async () => {
    const db = makeDb({
      customer: { pricingTier: 1, invoiceUnitDefault: "PACK" },
      products: [productRow("p1")],
      customerPrices: [{ productId: "p1", pricingTier: null, invoiceUnitRef: "base" }],
    });
    const live = await resolveLiveDisplayUnits(db as any, TENANT, invoice(["p1"]), flag(true));
    expect(live.get("it-0")).toEqual({ kind: "pieces", label: "Piece" });
  });

  it("customer default LEGACY falls through to the business setting", async () => {
    const db = makeDb({
      customer: { pricingTier: 1, invoiceUnitDefault: "LEGACY" },
      products: [productRow("p1")],
      business: "smallest",
    });
    const live = await resolveLiveDisplayUnits(db as any, TENANT, invoice(["p1"]), flag(true));
    expect(live.get("it-0")).toEqual({ kind: "pieces", label: "Piece" });
  });

  it("customer default LEGACY on a flag-off tenant stays legacy", async () => {
    const db = makeDb({
      customer: { pricingTier: 1, invoiceUnitDefault: "LEGACY" },
      business: "smallest",
    });
    const live = await resolveLiveDisplayUnits(db as any, TENANT, invoice(["p1"]), flag(false));
    expect(live.get("it-0")).toEqual({ kind: "legacy", label: null });
  });

  it("any error gives legacy for every item and never throws", async () => {
    const db = makeDb({ products: [productRow("p1")], business: "smallest" });
    db.product.findMany.mockRejectedValue(new Error("db down"));
    const live = await resolveLiveDisplayUnits(
      db as any,
      TENANT,
      invoice(["p1", "p2"]),
      flag(true),
    );
    expect(live.get("it-0")).toEqual({ kind: "legacy", label: null });
    expect(live.get("it-1")).toEqual({ kind: "legacy", label: null });
  });
});

describe("resolveLiveDisplayUnits tenant filters (M1)", () => {
  it("every query carries an explicit tenant filter", async () => {
    const db = makeDb({ products: [productRow("p1")], business: "smallest" });
    await resolveLiveDisplayUnits(db as any, TENANT, invoice(["p1"]), flag(true));
    expect(db.customer.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT });
    expect(db.customerPrice.findMany.mock.calls[0][0].where).toMatchObject({
      customer: { tenantId: TENANT },
    });
    expect(db.productTierUnit.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT });
    expect(db.product.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT });
    expect(db.productUnit.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT });
    expect(db.systemConfig.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT });
  });
});

describe("resolveIssueDisplayUnits (read side: a NON-transaction client)", () => {
  const unsnapped = (id: string, productId: string | null) => ({ id, productId });

  it("resolves only items whose snapshot is still empty, with an explicit tenant filter", async () => {
    const db = makeDb({
      products: [productRow("p1")],
      business: "smallest",
      items: [unsnapped("it-a", "p1")],
    });
    const out = await resolveIssueDisplayUnits(db as any, TENANT, "inv-1", flag(true));
    expect(out.get("it-a")).toEqual({ kind: "pieces", label: "Piece" });
    expect(db.invoice.findFirst.mock.calls[0][0].where).toEqual({ id: "inv-1", tenantId: TENANT });
    const where = db.invoiceItem.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      invoiceId: "inv-1",
      invoiceUnitFactor: null,
      invoice: { tenantId: TENANT },
    });
  });

  it("reads the invoice's own rows through ownRowsDb (the caller's tx) and the catalog through readDb", async () => {
    const catalog = makeDb({ products: [productRow("p1")], business: "smallest", items: [] });
    const own = makeDb({ items: [unsnapped("it-a", "p1")] });
    const out = await resolveIssueDisplayUnits(catalog as any, TENANT, "inv-1", flag(true), own);
    expect(out.get("it-a")).toEqual({ kind: "pieces", label: "Piece" });
    expect(own.invoice.findFirst).toHaveBeenCalledTimes(1);
    expect(own.invoiceItem.findMany).toHaveBeenCalledTimes(1);
    expect(catalog.invoiceItem.findMany).not.toHaveBeenCalled();
    expect(catalog.product.findMany).toHaveBeenCalled();
    expect(own.product.findMany).not.toHaveBeenCalled();
  });

  it("never throws: a resolver error gives an empty map (=> legacy)", async () => {
    const db = makeDb({ items: [unsnapped("it-a", "p1")] });
    db.product.findMany.mockRejectedValue(new Error("db down"));
    const out = await resolveIssueDisplayUnits(db as any, TENANT, "inv-1", flag(true));
    expect(out.size).toBe(0);
  });

  it("an item read error gives an empty map", async () => {
    const db = makeDb({});
    db.invoiceItem.findMany.mockRejectedValue(new Error("boom"));
    const out = await resolveIssueDisplayUnits(db as any, TENANT, "inv-1", flag(true));
    expect(out.size).toBe(0);
  });

  it("rethrows an own-rows read failure on the caller's tx (a retryable conflict must not be swallowed)", async () => {
    const catalog = makeDb({ products: [productRow("p1")], business: "smallest", items: [] });
    const own = makeDb({});
    // isTxClient: a tx client has no $connect function.
    delete (own as any).$connect;
    own.invoiceItem.findMany.mockRejectedValue({ code: "40001" });
    await expect(
      resolveIssueDisplayUnits(catalog as any, TENANT, "inv-1", flag(true), own),
    ).rejects.toEqual({ code: "40001" });
  });

  it("the same own-rows rejection on a non-tx readDb (no ownRowsDb) gives an empty map", async () => {
    const db = makeDb({});
    (db as any).$connect = jest.fn();
    db.invoiceItem.findMany.mockRejectedValue({ code: "40001" });
    const out = await resolveIssueDisplayUnits(db as any, TENANT, "inv-1", flag(true));
    expect(out.size).toBe(0);
  });

  it("an undefined invoice id or tenant reads nothing", async () => {
    const db = makeDb({ items: [unsnapped("it-a", "p1")] });
    expect((await resolveIssueDisplayUnits(db as any, TENANT, undefined as any)).size).toBe(0);
    expect((await resolveIssueDisplayUnits(db as any, undefined as any, "inv-1")).size).toBe(0);
    expect(db.invoiceItem.findMany).not.toHaveBeenCalled();
  });
});

/** A hand-built TRANSACTION client: no $connect (isTxClient reads that), $executeRaw records each statement. */
function makeTx(opts: { failUpdateWith?: unknown } = {}) {
  const sql: string[] = [];
  const tx: any = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
      sql.push(strings.join("").trim());
      return 0;
    }),
    invoiceItem: {
      updateMany: jest.fn(async () => {
        if (opts.failUpdateWith) throw opts.failUpdateWith;
        return { count: 1 };
      }),
    },
  };
  return { tx, sql };
}

const piecesUnit = (label = "Piece") => ({ kind: "pieces" as const, label });
const legacyUnit = () => ({ kind: "legacy" as const, label: null });

describe("writeIssueDisplayUnits (write side: inside the caller's tx, under a savepoint)", () => {
  it("one updateMany per distinct label, ONLY the two display keys, guarded by invoiceId and an empty snapshot", async () => {
    const { tx } = makeTx();
    await writeIssueDisplayUnits(
      tx,
      "inv-1",
      new Map<string, InvoiceDisplayUnitView>([
        ["it-a", piecesUnit("Piece")],
        ["it-b", piecesUnit("Piece")],
        ["it-c", piecesUnit("Each")],
        ["it-d", legacyUnit()],
      ]),
    );
    expect(tx.invoiceItem.updateMany).toHaveBeenCalledTimes(2);
    const calls = tx.invoiceItem.updateMany.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContainEqual({
      where: { id: { in: ["it-a", "it-b"] }, invoiceId: "inv-1", invoiceUnitFactor: null },
      data: { invoiceUnitLabel: "Piece", invoiceUnitFactor: 1 },
    });
    expect(calls).toContainEqual({
      where: { id: { in: ["it-c"] }, invoiceId: "inv-1", invoiceUnitFactor: null },
      data: { invoiceUnitLabel: "Each", invoiceUnitFactor: 1 },
    });
    for (const c of calls) {
      expect(Object.keys(c.data).sort()).toEqual(["invoiceUnitFactor", "invoiceUnitLabel"]);
    }
  });

  it("legacy-only items make zero statements (no savepoint, no updateMany)", async () => {
    const { tx, sql } = makeTx();
    await writeIssueDisplayUnits(tx, "inv-1", new Map([["it-a", legacyUnit()]]));
    await writeIssueDisplayUnits(tx, "inv-1", new Map());
    expect(tx.invoiceItem.updateMany).not.toHaveBeenCalled();
    expect(sql).toEqual([]);
  });

  it("runs under SAVEPOINT display_unit_snapshot and RELEASEs it on success", async () => {
    const { tx, sql } = makeTx();
    await writeIssueDisplayUnits(tx, "inv-1", new Map([["it-a", piecesUnit()]]));
    expect(sql).toEqual([
      "SAVEPOINT display_unit_snapshot",
      "RELEASE SAVEPOINT display_unit_snapshot",
    ]);
  });

  it("a non-conflict write error is swallowed AFTER ROLLBACK TO SAVEPOINT (the money tx stays usable)", async () => {
    const { tx, sql } = makeTx({ failUpdateWith: new Error("boom") });
    await expect(
      writeIssueDisplayUnits(tx, "inv-1", new Map([["it-a", piecesUnit()]])),
    ).resolves.toBeUndefined();
    expect(sql).toEqual([
      "SAVEPOINT display_unit_snapshot",
      "ROLLBACK TO SAVEPOINT display_unit_snapshot",
    ]);
  });

  it.each([
    ["40001", { code: "40001" }],
    ["P2034", { code: "P2034" }],
  ])(
    "a %s write conflict is RETHROWN with no rollback-to, so retryCreditTx can retry",
    async (_n, err) => {
      const { tx, sql } = makeTx({ failUpdateWith: err });
      await expect(
        writeIssueDisplayUnits(tx, "inv-1", new Map([["it-a", piecesUnit()]])),
      ).rejects.toBe(err);
      expect(sql).toEqual(["SAVEPOINT display_unit_snapshot"]);
    },
  );

  it("a failed ROLLBACK TO SAVEPOINT is rethrown (the tx is unusable)", async () => {
    const { tx } = makeTx({ failUpdateWith: new Error("boom") });
    tx.$executeRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      if (strings.join("").includes("ROLLBACK")) throw new Error("rollback failed");
      return 0;
    });
    await expect(
      writeIssueDisplayUnits(tx, "inv-1", new Map([["it-a", piecesUnit()]])),
    ).rejects.toThrow("rollback failed");
  });

  it("a non-tx client (the inline flip) opens no savepoint and swallows an error", async () => {
    const db: any = {
      $connect: jest.fn(),
      $executeRaw: jest.fn(),
      invoiceItem: { updateMany: jest.fn().mockRejectedValue(new Error("boom")) },
    };
    await expect(
      writeIssueDisplayUnits(db, "inv-1", new Map([["it-a", piecesUnit()]])),
    ).resolves.toBeUndefined();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("null or undefined units issue zero statements", async () => {
    const { tx, sql } = makeTx();
    await writeIssueDisplayUnits(tx, "inv-1", null);
    await writeIssueDisplayUnits(tx, "inv-1", undefined);
    expect(tx.invoiceItem.updateMany).not.toHaveBeenCalled();
    expect(sql).toEqual([]);
  });

  it("refuses to write with an undefined invoice id or item id (Prisma drops undefined where keys)", async () => {
    const { tx, sql } = makeTx();
    await writeIssueDisplayUnits(tx, undefined as any, new Map([["it-a", piecesUnit()]]));
    await writeIssueDisplayUnits(tx, "inv-1", new Map([[undefined as any, piecesUnit()]]));
    await writeIssueDisplayUnits(tx, "", new Map([["it-a", piecesUnit()]]));
    expect(tx.invoiceItem.updateMany).not.toHaveBeenCalled();
    expect(sql).toEqual([]);
  });
});

describe("clearIssueDisplayUnits (revert to draft)", () => {
  it("nulls the frozen unit columns (incl. SA-1029 baseLabel) for that invoice's items under the savepoint; only those keys", async () => {
    const { tx, sql } = makeTx();
    await clearIssueDisplayUnits(tx, "inv-1");
    expect(tx.invoiceItem.updateMany).toHaveBeenCalledWith({
      where: { invoiceId: "inv-1" },
      data: { invoiceUnitLabel: null, invoiceUnitFactor: null, baseLabel: null },
    });
    expect(sql).toEqual([
      "SAVEPOINT display_unit_snapshot",
      "RELEASE SAVEPOINT display_unit_snapshot",
    ]);
  });

  it("an undefined invoice id writes nothing", async () => {
    const { tx, sql } = makeTx();
    await clearIssueDisplayUnits(tx, undefined as any);
    expect(tx.invoiceItem.updateMany).not.toHaveBeenCalled();
    expect(sql).toEqual([]);
  });

  it("a conflict is rethrown; any other error is swallowed after ROLLBACK TO SAVEPOINT", async () => {
    const a = makeTx({ failUpdateWith: { code: "P2034" } });
    await expect(clearIssueDisplayUnits(a.tx, "inv-1")).rejects.toEqual({ code: "P2034" });
    const b = makeTx({ failUpdateWith: new Error("boom") });
    await expect(clearIssueDisplayUnits(b.tx, "inv-1")).resolves.toBeUndefined();
    expect(b.sql).toContain("ROLLBACK TO SAVEPOINT display_unit_snapshot");
  });
});

describe("withItemDisplayUnits (P4)", () => {
  const live = new Map([["it-0", { kind: "legacy" as const, label: null }]]);
  const item = (snap: { label: string | null; factor: number | null }) => ({
    id: "it-0",
    invoiceUnitLabel: snap.label,
    invoiceUnitFactor: snap.factor,
  });

  it("a SENT invoice whose snapshot is Piece/1 reads pieces even though the live preference is now legacy", () => {
    const out = withItemDisplayUnits(
      { status: "SENT", items: [item({ label: "Piece", factor: 1 })] },
      live,
    );
    expect(out.items[0].displayUnit).toEqual({ kind: "pieces", label: "Piece" });
  });

  it("a DRAFT follows the live value", () => {
    const pieces = new Map([["it-0", { kind: "pieces" as const, label: "Piece" }]]);
    const out = withItemDisplayUnits(
      { status: "DRAFT", items: [item({ label: null, factor: null })] },
      pieces,
    );
    expect(out.items[0].displayUnit).toEqual({ kind: "pieces", label: "Piece" });
  });

  it("an issued invoice with no snapshot (pre SA-827) stays legacy", () => {
    const out = withItemDisplayUnits(
      { status: "SENT", items: [item({ label: null, factor: null })] },
      new Map(),
    );
    expect(out.items[0].displayUnit).toEqual({ kind: "legacy", label: null });
  });

  it("keeps every other field of the item and the invoice", () => {
    const out = withItemDisplayUnits(
      { status: "PAID", total: 5, items: [{ ...item({ label: null, factor: null }), qty: 3 }] },
      new Map(),
    );
    expect(out.total).toBe(5);
    expect(out.items[0].qty).toBe(3);
  });
});

describe("resolveDraftIssueUnits (pre-tx resolve for send/pay paths)", () => {
  const dbWith = (pre: unknown, fx: Fx = {}) => {
    const db = makeDb(fx);
    return { ...db, invoice: { ...db.invoice, findUnique: jest.fn().mockResolvedValue(pre) } };
  };

  it("an issued invoice gives null and runs no invoiceItem query", async () => {
    const db = dbWith({ status: "SENT", tenantId: TENANT });
    expect(await resolveDraftIssueUnits(db as any, "inv-1")).toBeNull();
    expect(db.invoice.findUnique).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      select: { status: true, tenantId: true },
    });
    expect(db.invoiceItem.findMany).not.toHaveBeenCalled();
  });

  it("a DRAFT resolves the units it would freeze", async () => {
    const db = dbWith(
      { status: "DRAFT", tenantId: TENANT },
      {
        products: [productRow("p1")],
        business: "smallest",
        items: [{ id: "it-a", productId: "p1" }],
      },
    );
    const out = await resolveDraftIssueUnits(db as any, "inv-1", flag(true));
    expect(out?.get("it-a")).toEqual({ kind: "pieces", label: "Piece" });
  });

  it("a row without a tenant (or a missing row) gives null", async () => {
    expect(
      await resolveDraftIssueUnits(dbWith({ status: "DRAFT", tenantId: null }) as any, "inv-1"),
    ).toBeNull();
    expect(await resolveDraftIssueUnits(dbWith(null) as any, "inv-1")).toBeNull();
  });
});

describe("itemsWithDisplayUnits (read-side decorator)", () => {
  const row = (snap: { label: string | null; factor: number | null }) => ({
    id: "it-0",
    productId: "p1",
    invoiceUnitLabel: snap.label,
    invoiceUnitFactor: snap.factor,
  });
  const inv = (status: string, snap: { label: string | null; factor: number | null }) => ({
    status,
    tenantId: TENANT,
    customerId: CUSTOMER,
    items: [row(snap)],
  });

  it("a SENT invoice with a Piece/1 snapshot reads pieces and makes no catalog query (P4)", async () => {
    const db = makeDb({ products: [productRow("p1")] });
    const out = await itemsWithDisplayUnits(
      db as any,
      inv("SENT", { label: "Piece", factor: 1 }),
      flag(true),
    );
    expect(out[0].displayUnit).toEqual({ kind: "pieces", label: "Piece" });
    expect(db.product.findMany).not.toHaveBeenCalled();
    expect(db.customer.findFirst).not.toHaveBeenCalled();
  });

  it("a DRAFT follows the live preference", async () => {
    const db = makeDb({ products: [productRow("p1")], business: "smallest" });
    const out = await itemsWithDisplayUnits(
      db as any,
      inv("DRAFT", { label: null, factor: null }),
      flag(true),
    );
    expect(out[0].displayUnit).toEqual({ kind: "pieces", label: "Piece" });
    expect(out[0].id).toBe("it-0");
  });

  it("an issued invoice with no snapshot stays legacy", async () => {
    const db = makeDb({ products: [productRow("p1")], business: "smallest" });
    const out = await itemsWithDisplayUnits(
      db as any,
      inv("SENT", { label: null, factor: null }),
      flag(true),
    );
    expect(out[0].displayUnit).toEqual({ kind: "legacy", label: null });
  });
});

describe("freezeDraftIssueUnits (resolve + write at the DRAFT -> issued transition)", () => {
  it("reads own rows through tx, the catalog through readDb, and writes in tx only (units, then the SA-1029 base word)", async () => {
    const catalog = makeDb({
      products: [productRow("p1")],
      business: "smallest",
      items: [{ id: "it-a", productId: "p1" }],
    });
    const tx: any = makeDb({ items: [{ id: "it-a", productId: "p1" }] });
    tx.$executeRaw = jest.fn(async () => 0);
    tx.invoiceItem.updateMany = jest.fn(async () => ({ count: 1 }));
    await freezeDraftIssueUnits(catalog as any, tx, { id: "inv-1", tenantId: TENANT }, flag(true));
    // tx: 1 read for the unit snapshot + 1 for the baseLabel writer; the baseLabel WORDS were read through readDb
    expect(tx.invoiceItem.findMany).toHaveBeenCalledTimes(2);
    expect(catalog.invoiceItem.findMany).toHaveBeenCalledTimes(1); // loadDraftBaseLabels, pre-tx
    expect(catalog.product.findMany).toHaveBeenCalled();
    expect(tx.invoiceItem.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.invoiceItem.updateMany.mock.calls[0][0].data).toEqual({
      invoiceUnitLabel: "Piece",
      invoiceUnitFactor: 1,
    });
    expect(tx.invoiceItem.updateMany.mock.calls[1][0].data).toEqual({ baseLabel: "Piece" });
  });

  it("a null tenantId does nothing", async () => {
    const catalog = makeDb({ items: [] });
    const { tx, sql } = makeTx();
    await freezeDraftIssueUnits(catalog as any, tx, { id: "inv-1", tenantId: null }, flag(true));
    expect(catalog.invoice.findFirst).not.toHaveBeenCalled();
    expect(tx.invoiceItem.updateMany).not.toHaveBeenCalled();
    expect(sql).toEqual([]);
  });

  it("the same non-tx client for read and write (the inline flip) swallows a write failure", async () => {
    const db: any = makeDb({
      products: [productRow("p1")],
      business: "smallest",
      items: [{ id: "it-a", productId: "p1" }],
    });
    db.$connect = jest.fn();
    db.invoiceItem.updateMany = jest.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      freezeDraftIssueUnits(db, db, { id: "inv-1", tenantId: TENANT }, flag(true)),
    ).resolves.toBeUndefined();
  });
});

describe("SA-967: one resolver, split into loadDisplayUnitCatalog (all the I/O) and a pure resolveFromCatalog", () => {
  const items = [
    { id: "it-0", productId: "p1" },
    { id: "it-1", productId: "p2" },
    { id: "it-2", productId: null },
    { id: "it-3", productId: "p-missing" },
  ];

  it("loadDisplayUnitCatalog: the flag first (off or a failed read is null, no catalog query), then one query per table", async () => {
    const off = makeDb({ products: [productRow("p1")], business: "smallest" });
    expect(await loadDisplayUnitCatalog(off, TENANT, CUSTOMER, ["p1"], flag(false))).toBeNull();
    expect(await loadDisplayUnitCatalog(off, TENANT, CUSTOMER, ["p1"], flag("throw"))).toBeNull();
    expect(off.product.findMany).not.toHaveBeenCalled();
    const on = makeDb({ products: [productRow("p1")], business: "smallest" });
    const catalog = await loadDisplayUnitCatalog(on, TENANT, CUSTOMER, ["p1"], flag(true));
    expect(catalog?.customerId).toBe(CUSTOMER);
    for (const m of [on.product, on.customerPrice, on.productTierUnit, on.productUnit])
      expect(m.findMany).toHaveBeenCalledTimes(1);
  });

  it("resolveFromCatalog is PURE (no client) and gives the same units as resolveLiveDisplayUnits (parity)", async () => {
    const db = makeDb({
      products: [productRow("p1"), productRow("p2", { unitsPerBox: 1, packLabel: "Each" })],
      business: "smallest",
    });
    const catalog = (await loadDisplayUnitCatalog(db, TENANT, CUSTOMER, ["p1", "p2"], flag(true)))!;
    const queriesAfterLoad = db.product.findMany.mock.calls.length;
    const pure = resolveFromCatalog(catalog, items);
    expect(db.product.findMany.mock.calls.length).toBe(queriesAfterLoad); // it read nothing
    const live = await resolveLiveDisplayUnits(
      db as any,
      TENANT,
      { customerId: CUSTOMER, items },
      flag(true),
    );
    expect([...pure.entries()]).toEqual(
      [...live.entries()].filter(([id]) => id !== "it-2"), // the null-product item is only in live's allLegacy
    );
    expect(pure.get("it-3")).toEqual({ kind: "legacy", label: null }); // a product the catalog lacks
  });

  const stop = { customerId: CUSTOMER, orders: [{ id: "ord-1" }, { id: "ord-2" }] };
  const prismaOf = (db: any, tenantId: string | null = TENANT) => ({
    forTenant: () => db,
    getTenantId: () => tenantId,
  });
  const withOrderItems = (fx: Fx, rows: unknown[] = [{ productId: "p1" }, { productId: null }]) =>
    Object.assign(makeDb(fx), { orderItem: { findMany: jest.fn().mockResolvedValue(rows) } });

  it("loadStopDisplayUnitCatalog: the stop's customer, the stop's orders' products, one load before any tx", async () => {
    const db = withOrderItems({ products: [productRow("p1")], business: "smallest" });
    const catalog = await loadStopDisplayUnitCatalog(prismaOf(db), stop, flag(true));
    expect(catalog?.customerId).toBe(CUSTOMER);
    expect(db.orderItem.findMany).toHaveBeenCalledTimes(1);
    expect(db.product.findMany).toHaveBeenCalledTimes(1);
    expect(db.orderItem.findMany.mock.calls[0][0].where.orderId).toEqual({
      in: ["ord-1", "ord-2"],
    });
  });

  it("no customer, no tenant, no orders, no products, the flag off, or a failing read: null, never a throw", async () => {
    const db = withOrderItems({ products: [productRow("p1")] });
    expect(await loadStopDisplayUnitCatalog(prismaOf(db), stop, flag(false))).toBeNull();
    expect(
      await loadStopDisplayUnitCatalog(prismaOf(db), { ...stop, customerId: null }, flag(true)),
    ).toBeNull();
    expect(await loadStopDisplayUnitCatalog(prismaOf(db, null), stop, flag(true))).toBeNull();
    expect(
      await loadStopDisplayUnitCatalog(prismaOf(db), { ...stop, orders: [] }, flag(true)),
    ).toBeNull();
    expect(
      await loadStopDisplayUnitCatalog(prismaOf(withOrderItems({}, [])), stop, flag(true)),
    ).toBeNull();
    const broken: any = withOrderItems({});
    broken.orderItem.findMany = jest.fn().mockRejectedValue(new Error("db down"));
    expect(await loadStopDisplayUnitCatalog(prismaOf(broken), stop, flag(true))).toBeNull();
  });

  const loaded = async (fx: Fx = { products: [productRow("p1")], business: "smallest" }) =>
    loadDisplayUnitCatalog(makeDb(fx), TENANT, CUSTOMER, ["p1"], flag(true));
  const txOf = (rows: unknown[] = [{ id: "it-a", productId: "p1" }]) => {
    const tx: any = makeDb({ items: rows });
    tx.$executeRaw = jest.fn(async () => 0);
    tx.invoiceItem.updateMany = jest.fn(async () => ({ count: 1 }));
    return tx;
  };

  it("freezeIssueUnitsFromCatalog takes the CATALOG, never a client: own rows through tx, ZERO catalog or flag queries on it, pieces written", async () => {
    const catalog = await loaded();
    const tx = txOf();
    await freezeIssueUnitsFromCatalog(tx, { id: "inv-1", tenantId: TENANT }, catalog);
    for (const m of [tx.product, tx.customer, tx.customerPrice, tx.productTierUnit, tx.productUnit])
      expect(Object.values(m).every((fn: any) => fn.mock.calls.length === 0)).toBe(true);
    expect(tx.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(tx.invoiceItem.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.invoiceItem.updateMany.mock.calls[0][0].data).toEqual({
      invoiceUnitLabel: "Piece",
      invoiceUnitFactor: 1,
    });
  });

  it("a null catalog, no tenant, or an invoice of another customer writes nothing (the line reads legacy)", async () => {
    const catalog = await loaded();
    const tx = txOf();
    await freezeIssueUnitsFromCatalog(tx, { id: "inv-1", tenantId: TENANT }, null);
    await freezeIssueUnitsFromCatalog(tx, { id: "inv-1", tenantId: null }, catalog);
    tx.invoice.findFirst.mockResolvedValue({ customerId: "cust-other" });
    await freezeIssueUnitsFromCatalog(tx, { id: "inv-1", tenantId: TENANT }, catalog);
    expect(tx.invoiceItem.updateMany).not.toHaveBeenCalled();
  });

  it("a product the catalog lacks is written nothing and warned about; the others still freeze", async () => {
    const catalog = await loaded();
    const tx = txOf([
      { id: "it-a", productId: "p1" },
      { id: "it-b", productId: "p-edited-since" },
    ]);
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await freezeIssueUnitsFromCatalog(tx, { id: "inv-1", tenantId: TENANT }, catalog);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("lacks 1 product(s) of invoice inv-1"),
    );
    warn.mockRestore();
    expect(tx.invoiceItem.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.invoiceItem.updateMany.mock.calls[0][0].where.id).toEqual({ in: ["it-a"] });
  });

  it("an own-rows read failure inside the caller's tx is rethrown (a 40001 must reach the retry, not a 25P02)", async () => {
    const catalog = await loaded();
    const tx = txOf();
    tx.invoiceItem.findMany = jest.fn().mockRejectedValue(new Error("serialization"));
    await expect(
      freezeIssueUnitsFromCatalog(tx, { id: "inv-1", tenantId: TENANT }, catalog),
    ).rejects.toThrow("serialization");
  });
});

describe("writeIssueBaseLabels (SA-1029 D-S1: the writer names no product; the word comes from the pre-tx map)", () => {
  const txOfRows = (rows: unknown[]) => {
    const { tx, sql } = makeTx();
    tx.invoiceItem.findMany = jest.fn(async () => rows); // a tx with NO product model at all
    return { tx, sql };
  };
  const labels = new Map([
    ["p1", "Bag"],
    ["p2", "Bag"],
    ["p3", "Tin"],
  ]);

  it("D-S1: its findMany selects only id and productId, never a product relation", async () => {
    const { tx } = txOfRows([]);
    await writeIssueBaseLabels(tx, "inv-1", TENANT, labels);
    expect(tx.invoiceItem.findMany).toHaveBeenCalledTimes(1);
    const args = tx.invoiceItem.findMany.mock.calls[0][0];
    expect(args.select).toEqual({ id: true, productId: true });
    expect(args.select).not.toHaveProperty("product");
    expect(tx.product).toBeUndefined();
  });

  it("D-S1: its findMany reads the invoice's own unfrozen lines that have a productId (a loose line too)", async () => {
    const { tx } = txOfRows([]);
    await writeIssueBaseLabels(tx, "inv-1", TENANT, labels);
    expect(tx.invoiceItem.findMany.mock.calls[0][0].where).toEqual({
      invoiceId: "inv-1",
      baseLabel: null,
      productId: { not: null },
      invoice: { tenantId: TENANT },
    });
  });

  it("D-S1: one updateMany per distinct label, from the map alone (a tx with no product model passes)", async () => {
    const { tx } = txOfRows([
      { id: "it-a", productId: "p1" },
      { id: "it-b", productId: "p2" },
      { id: "it-c", productId: "p3" },
    ]);
    await writeIssueBaseLabels(tx, "inv-1", TENANT, labels);
    expect(tx.invoiceItem.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.invoiceItem.updateMany.mock.calls.map((c: any[]) => c[0])).toEqual([
      {
        where: { id: { in: ["it-a", "it-b"] }, invoiceId: "inv-1", baseLabel: null },
        data: { baseLabel: "Bag" },
      },
      {
        where: { id: { in: ["it-c"] }, invoiceId: "inv-1", baseLabel: null },
        data: { baseLabel: "Tin" },
      },
    ]);
  });

  it("D-S1: a product missing from the map is written nothing, with a warn; a null map writes nothing", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { tx } = txOfRows([
      { id: "it-a", productId: "p1" },
      { id: "it-x", productId: "p-unknown" },
    ]);
    await writeIssueBaseLabels(tx, "inv-1", TENANT, labels);
    expect(tx.invoiceItem.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.invoiceItem.updateMany.mock.calls[0][0].where.id).toEqual({ in: ["it-a"] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("inv-1"));
    const none = txOfRows([{ id: "it-a", productId: "p1" }]);
    await writeIssueBaseLabels(none.tx, "inv-1", TENANT, null);
    expect(none.tx.invoiceItem.updateMany).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("itemsWithDisplayUnits component views", () => {
  it("converts Decimal component prices to numbers", async () => {
    const db = makeDb({ products: [productRow("p1")] });
    const out = await itemsWithDisplayUnits(
      db as any,
      {
        status: "SENT",
        tenantId: TENANT,
        customerId: CUSTOMER,
        items: [
          {
            id: "it-0",
            productId: "p1",
            invoiceUnitLabel: "Piece",
            invoiceUnitFactor: 1,
            components: [
              {
                componentProductId: "p2",
                name: "Part",
                qty: { toString: () => "2" },
                displayUnitPrice4: { toString: () => "0.7875" },
              },
            ],
          } as any,
        ],
      },
      flag(true),
    );
    expect((out[0] as any).components[0]).toMatchObject({ qty: 2, displayUnitPrice4: 0.7875 });
  });
});
