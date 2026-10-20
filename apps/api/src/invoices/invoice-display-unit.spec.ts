import {
  clearIssueDisplayUnits,
  resolveIssueDisplayUnits,
  resolveLiveDisplayUnits,
  withItemDisplayUnits,
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
  customer?: { pricingTier: number | null } | null;
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
      new Map([
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
  it("nulls both columns for that invoice's items under the savepoint; only those two keys", async () => {
    const { tx, sql } = makeTx();
    await clearIssueDisplayUnits(tx, "inv-1");
    expect(tx.invoiceItem.updateMany).toHaveBeenCalledWith({
      where: { invoiceId: "inv-1" },
      data: { invoiceUnitLabel: null, invoiceUnitFactor: null },
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
