import { Prisma } from "@prisma/client";
import {
  type NestedPolicy,
  NestedTenantWalkError,
  findNestedWithoutTenant,
  isTenantOwnedModel,
  stampNestedTenant,
  walkTablesBuiltCount,
} from "./nested-tenant-walk";

/**
 * SA-620 B1: ONE DMMF-driven walker stamps tenantId on NESTED relation writes (a child created through
 * `items: { create | createMany | connectOrCreate | upsert }`), so a child model with a nullable tenantId
 * can no longer be written with NULL. Driven by Prisma.dmmf: a new child model is covered automatically.
 */
const T = "tenant-1";
const stamp = (model: string, data: unknown, tenantId = T) =>
  stampNestedTenant(model, data, tenantId);

const CHILD_MODELS = [
  "VendorBillItem",
  "InvoiceItem",
  "EstimateItem",
  "OrderItem",
  "OrderTemplateItem",
  "RecurringInvoiceItem",
  "ReturnItem",
  "RouteStop",
  "PurchaseOrderItem",
  "BillPayment",
];
const NOT_TENANT_OWNED = ["TripStop", "TransactionLineItem"];

const dm = (Prisma as any).dmmf.datamodel.models as Array<{
  name: string;
  fields: Array<{ name: string; kind: string; type: string }>;
}>;
/** Every (parent, relation field, child) in the data model whose child carries a tenantId. */
const relationsTo = (child: string) =>
  dm
    .filter((m) => m.name !== "Tenant") // a Tenant parent assigns the tenant through the relation itself
    .flatMap((m) =>
      m.fields
        .filter((f) => f.kind === "object" && f.type === child)
        .map((f) => ({ parent: m.name, field: f.name })),
    );

describe("stampNestedTenant: DMMF coverage (SA-620 case 1)", () => {
  it.each(CHILD_MODELS)(
    "%s is tenant-owned and reached through EVERY parent relation that targets it",
    (child) => {
      expect(isTenantOwnedModel(child)).toBe(true);
      const rels = relationsTo(child);
      expect(rels.length).toBeGreaterThan(0);
      for (const { parent, field } of rels) {
        const out: any = stamp(parent, { [field]: { create: { note: "x" } } });
        expect(out[field].create.tenantId).toBe(T); // single-object form
        const many: any = stamp(parent, { [field]: { create: [{ a: 1 }, { a: 2 }] } });
        expect(many[field].create.map((c: any) => c.tenantId)).toEqual([T, T]);
      }
    },
  );

  it.each(NOT_TENANT_OWNED)("%s has no tenantId column: never stamped", (child) => {
    expect(isTenantOwnedModel(child)).toBe(false);
    for (const { parent, field } of relationsTo(child)) {
      const out: any = stamp(parent, { [field]: { create: { a: 1 } } });
      expect(out[field].create).toEqual({ a: 1 });
    }
  });

  it("every relation field whose target is tenant-owned is reached (the data model is the only list)", () => {
    let checked = 0;
    for (const m of dm.filter((x) => x.name !== "Tenant"))
      for (const f of m.fields) {
        if (f.kind !== "object" || !isTenantOwnedModel(f.type)) continue;
        const out: any = stamp(m.name, { [f.name]: { create: {} } });
        expect(out[f.name].create.tenantId).toBe(T);
        checked++;
      }
    expect(checked).toBeGreaterThan(100);
  });
});

describe("stampNestedTenant: shapes (SA-620 case 2)", () => {
  it("createMany (object and array data), connectOrCreate (object and array), upsert create", () => {
    const a: any = stamp("VendorBill", { items: { createMany: { data: [{ q: 1 }, { q: 2 }] } } });
    expect(a.items.createMany.data.map((r: any) => r.tenantId)).toEqual([T, T]);
    const b: any = stamp("VendorBill", { items: { createMany: { data: { q: 1 } } } });
    expect(b.items.createMany.data.tenantId).toBe(T);
    const c: any = stamp("VendorBill", {
      items: { connectOrCreate: { where: { id: "x" }, create: { q: 1 } } },
    });
    expect(c.items.connectOrCreate.create.tenantId).toBe(T);
    const d: any = stamp("VendorBill", {
      items: {
        connectOrCreate: [
          { where: { id: "x" }, create: { q: 1 } },
          { where: { id: "y" }, create: { q: 2 } },
        ],
      },
    });
    expect(d.items.connectOrCreate.map((e: any) => e.create.tenantId)).toEqual([T, T]);
    const e: any = stamp("VendorBill", {
      items: { upsert: { where: { id: "x" }, create: { q: 1 }, update: { q: 2 } } },
    });
    expect(e.items.upsert.create.tenantId).toBe(T);
    expect(e.items.upsert.update).toEqual({ q: 2 }); // update data of an existing row is not stamped
  });

  it("goes 2-3 levels deep, through list and single relations (relation names come from the data model)", () => {
    const rel = (parent: string, child: string) =>
      dm
        .find((m) => m.name === parent)!
        .fields.find((f) => f.kind === "object" && f.type === child)!;
    const orderItems = rel("Order", "OrderItem").name;
    const out: any = stamp("Order", { [orderItems]: { create: [{ q: 1 }] } });
    expect(out[orderItems].create[0].tenantId).toBe(T);
    // a tenant-owned grandchild under OrderItem is stamped too
    const grand = dm
      .find((m) => m.name === "OrderItem")!
      .fields.find((f) => f.kind === "object" && isTenantOwnedModel(f.type) && f.type !== "Order");
    expect(grand).toBeDefined();
    const deep: any = stamp("Order", {
      [orderItems]: { create: [{ [grand!.name]: { create: [{ z: 1 }] } }] },
    });
    expect(deep[orderItems].create[0].tenantId).toBe(T);
    const g = deep[orderItems].create[0][grand!.name].create;
    expect((Array.isArray(g) ? g[0] : g).tenantId).toBe(T);
  });

  it("a sibling create next to an update is stamped; update.data itself is never stamped", () => {
    const out: any = stamp("VendorBill", {
      items: { update: { where: { id: "1" }, data: { q: 2 } }, create: [{ q: 3 }] },
    });
    expect(out.items.create[0].tenantId).toBe(T);
    expect(out.items.update.data).toEqual({ q: 2 });
  });

  it("a nested create INSIDE update.data (the edit that adds a grandchild), the to-one update shorthand, and upsert.update are walked", () => {
    const grand = dm
      .find((m) => m.name === "OrderItem")!
      .fields.find((f) => f.kind === "object" && isTenantOwnedModel(f.type) && f.type !== "Order")!;
    const orderItems = dm
      .find((m) => m.name === "Order")!
      .fields.find((f) => f.kind === "object" && f.type === "OrderItem")!.name;
    const inUpdateData: any = stamp("Order", {
      [orderItems]: {
        update: { where: { id: "1" }, data: { [grand.name]: { create: [{ z: 1 }] } } },
      },
    });
    const g1 = inUpdateData[orderItems].update.data[grand.name].create[0];
    expect(g1.tenantId).toBe(T);
    const inUpsertUpdate: any = stamp("Order", {
      [orderItems]: {
        upsert: {
          where: { id: "1" },
          create: { q: 1 },
          update: { [grand.name]: { create: [{ z: 2 }] } },
        },
      },
    });
    expect(inUpsertUpdate[orderItems].upsert.update[grand.name].create[0].tenantId).toBe(T);
    // to-one shorthand: Customer-style `rel: { update: { ...data } }` carrying a nested create
    const toOne: any = stamp("OrderItem", {
      order: { update: { [orderItems]: { create: { q: 1 } } } },
    });
    expect(toOne.order.update[orderItems].create.tenantId).toBe(T);
  });

  it("a parent that IS the Tenant gets no stamping (the relation itself assigns the tenant; TenantConfigCreateWithoutTenantInput has no tenantId)", () => {
    const input = { config: { upsert: { create: { businessName: "x" }, update: {} } } };
    expect(stamp("Tenant", input)).toEqual(input);
    expect(findNestedWithoutTenant("Tenant", input)).toEqual([]);
  });

  it("connect / disconnect / set / delete / deleteMany / updateMany.where are untouched", () => {
    const input = {
      items: {
        connect: [{ id: "a" }],
        disconnect: { id: "b" },
        set: [{ id: "c" }],
        delete: { id: "d" },
        deleteMany: { vendorBillId: "v" },
        updateMany: { where: { q: 1 }, data: { q: 2 } },
      },
    };
    expect(stamp("VendorBill", input)).toEqual(input);
  });
});

describe("stampNestedTenant: no-ops, throws, purity (SA-620 case 3)", () => {
  it("a child already carrying the SAME tenantId is kept; null/undefined are stamped", () => {
    const out: any = stamp("VendorBill", {
      items: { create: [{ tenantId: T }, { tenantId: null }, { tenantId: undefined }, {}] },
    });
    expect(out.items.create.map((c: any) => c.tenantId)).toEqual([T, T, T, T]);
  });

  it("an explicit DIFFERENT tenantId at any depth throws, naming the path", () => {
    expect(() => stamp("VendorBill", { items: { create: { tenantId: "other" } } })).toThrow(
      NestedTenantWalkError,
    );
    expect(() => stamp("VendorBill", { items: { create: { tenantId: "other" } } })).toThrow(
      /data\.items\.create/,
    );
    expect(() =>
      stamp("VendorBill", {
        items: { createMany: { data: [{ tenantId: T }, { tenantId: "other" }] } },
      }),
    ).toThrow(/data\.items\.createMany\.data\[1\]/);
  });

  it("the input is never mutated and untouched branches are shared, not copied", () => {
    const input = { note: "n", items: { create: [{ q: 1 }] }, scans: { connect: { id: "s" } } };
    const snapshot = JSON.parse(JSON.stringify(input));
    const out: any = stamp("VendorBill", input);
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect(out.scans).toBe(input.scans);
  });

  it("scalar FK columns and non-relation keys are untouched", () => {
    const out: any = stamp("VendorBillItem", { vendorBillId: "v", description: "d", qty: 3 });
    expect(out).toEqual({ vendorBillId: "v", description: "d", qty: 3 });
  });

  it("null / undefined / empty / non-object data are safe", () => {
    for (const d of [null, undefined, {}, [], "x", 3])
      expect(() => stamp("VendorBill", d)).not.toThrow();
    expect(stamp("VendorBill", null)).toBeNull();
    expect(stamp("VendorBill", undefined)).toBeUndefined();
  });

  it("an unknown model is a no-op (never throws on a name the data model lacks)", () => {
    expect(stamp("NotAModel", { items: { create: {} } })).toEqual({ items: { create: {} } });
  });

  it("the depth cap THROWS (never silently stops stamping) and names the path", () => {
    // Build a chain parent -> child -> parent -> ... deeper than the cap, from the data model's own names.
    const rel = dm
      .find((m) => m.name === "Order")!
      .fields.find((f) => f.kind === "object" && f.type === "OrderItem")!;
    const back = dm
      .find((m) => m.name === "OrderItem")!
      .fields.find((f) => f.kind === "object" && f.type === "Order")!;
    let data: any = { note: "leaf" };
    for (let i = 0; i < 20; i++)
      data = { [rel.name]: { create: { [back.name]: { create: data } } } };
    let err: any;
    try {
      stamp("Order", data);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NestedTenantWalkError);
    expect(err.message).toMatch(/depth/i);
    expect(err.message).toMatch(/data\./);
  });
});

describe("findNestedWithoutTenant (the dark non-TENANT check)", () => {
  it("never throws on depth: it stops and reports what it has seen (the dark check must not break a write)", () => {
    const rel = dm.find((m) => m.name === "Order")!.fields.find((f) => f.type === "OrderItem")!;
    const back = dm.find((m) => m.name === "OrderItem")!.fields.find((f) => f.type === "Order")!;
    let data: any = { note: "leaf" };
    for (let i = 0; i < 20; i++)
      data = { [rel.name]: { create: { [back.name]: { create: data } } } };
    expect(() => findNestedWithoutTenant("Order", data)).not.toThrow();
    expect(findNestedWithoutTenant("Order", data).length).toBeGreaterThan(0);
  });
  it("lists nested tenant-owned creates with no tenantId; explicit null and a value are fine", () => {
    const out = findNestedWithoutTenant("VendorBill", {
      items: { create: [{ q: 1 }, { q: 2, tenantId: null }, { q: 3, tenantId: "t" }] },
    });
    expect(out).toEqual([{ model: "VendorBillItem", path: "data.items.create[0]" }]);
  });
});

describe("the walker is memoized (SA-620 case 6)", () => {
  it("its DMMF tables are built once however many calls are made", () => {
    stamp("VendorBill", { items: { create: {} } });
    const before = walkTablesBuiltCount();
    for (let i = 0; i < 200; i++) stamp("Invoice", { items: { create: { q: i } } });
    expect(walkTablesBuiltCount()).toBe(before);
    expect(before).toBe(1);
  });
});

describe("SA-620c: the dark/enforced policy for a cross-tenant child and the depth cap", () => {
  const dark = () => {
    const report = jest.fn();
    const policy: NestedPolicy = { enforce: false, report };
    return { policy, report };
  };
  const enforced = () => {
    const report = jest.fn();
    return { policy: { enforce: true, report } as NestedPolicy, report };
  };
  const deepData = () => {
    const rel = dm.find((m) => m.name === "Order")!.fields.find((f) => f.type === "OrderItem")!;
    const back = dm.find((m) => m.name === "OrderItem")!.fields.find((f) => f.type === "Order")!;
    let data: any = { note: "leaf" };
    for (let i = 0; i < 20; i++)
      data = { [rel.name]: { create: { [back.name]: { create: data } } } };
    return data;
  };

  it("a MISSING tenantId is filled in silently in both modes (never refused, never reported)", () => {
    for (const { policy, report } of [dark(), enforced()]) {
      const out: any = stampNestedTenant(
        "VendorBill",
        { items: { create: [{ q: 1 }] } },
        T,
        policy,
      );
      expect(out.items.create[0].tenantId).toBe(T);
      expect(report).not.toHaveBeenCalled();
    }
  });

  it("DARK: a cross-tenant child is OVERRIDDEN with the context tenant and reported, not thrown (mirrors the top level)", () => {
    const { policy, report } = dark();
    const out: any = stampNestedTenant(
      "VendorBill",
      { items: { create: { tenantId: "other" } } },
      T,
      policy,
    );
    expect(out.items.create.tenantId).toBe(T);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toBe("CROSS_TENANT_CHILD");
    expect(report.mock.calls[0][1]).toMatch(/VendorBillItem at data\.items\.create/);
    expect(JSON.stringify(report.mock.calls[0])).not.toContain("other"); // never the foreign tenant id
  });

  it("ENFORCED: a cross-tenant child throws, naming the path", () => {
    const { policy } = enforced();
    expect(() =>
      stampNestedTenant("VendorBill", { items: { create: { tenantId: "other" } } }, T, policy),
    ).toThrow(/data\.items\.create/);
  });

  it("DARK: nesting beyond the soft cap (8) is REPORTED but still STAMPED (stopping would leave NULL-tenant rows); ENFORCED it throws", () => {
    const d = dark();
    const out: any = stampNestedTenant("Order", deepData(), T, d.policy);
    expect(d.report).toHaveBeenCalledWith("DEPTH", expect.stringMatching(/data\./));
    // every created row below the soft cap carries the tenant too
    const rel = dm
      .find((m) => m.name === "Order")!
      .fields.find((f) => f.type === "OrderItem")!.name;
    const back = dm
      .find((m) => m.name === "OrderItem")!
      .fields.find((f) => f.type === "Order")!.name;
    let node: any = out;
    let stamped = 0;
    for (let i = 0; i < 20; i++) {
      const item = node[rel].create;
      expect(item.tenantId).toBe(T);
      stamped++;
      node = item[back].create;
      expect(node.tenantId).toBe(T);
      stamped++;
    }
    expect(stamped).toBe(40);
    const e = enforced();
    expect(() => stampNestedTenant("Order", deepData(), T, e.policy)).toThrow(
      NestedTenantWalkError,
    );
  });

  it("a pathological nesting beyond the HARD cap (64) throws in EVERY mode, naming the path", () => {
    const rel = dm.find((m) => m.name === "Order")!.fields.find((f) => f.type === "OrderItem")!;
    const back = dm.find((m) => m.name === "OrderItem")!.fields.find((f) => f.type === "Order")!;
    let data: any = { note: "leaf" };
    for (let i = 0; i < 40; i++)
      data = { [rel.name]: { create: { [back.name]: { create: data } } } };
    expect(() => stampNestedTenant("Order", data, T, dark().policy)).toThrow(/hard limit/);
    expect(() => stampNestedTenant("Order", data, T, enforced().policy)).toThrow(
      NestedTenantWalkError,
    );
  });

  it("the HARD cap boundary: a chain of exactly 64 relation hops stamps (dark reports, enforced throws at the soft cap), 65 throws in EVERY mode", () => {
    const rel = dm.find((m) => m.name === "Order")!.fields.find((f) => f.type === "OrderItem")!;
    const back = dm.find((m) => m.name === "OrderItem")!.fields.find((f) => f.type === "Order")!;
    // n relation hops below the root: Order -> OrderItem -> Order -> ...
    const chain = (n: number) => {
      let data: any = { note: "leaf" };
      for (let i = n; i >= 1; i--) {
        const key = i % 2 === 1 ? rel.name : back.name;
        data = { [key]: { create: data } };
      }
      return data;
    };
    const d = dark();
    const out: any = stampNestedTenant("Order", chain(64), T, d.policy);
    expect(out[rel.name].create.tenantId).toBe(T);
    expect(d.report).toHaveBeenCalledWith("DEPTH", expect.any(String));
    expect(d.report).toHaveBeenCalledTimes(1);
    expect(() => stampNestedTenant("Order", chain(64), T, enforced().policy)).toThrow(
      /depth limit of 8/,
    );
    expect(() => stampNestedTenant("Order", chain(65), T, dark().policy)).toThrow(/hard limit/);
    expect(() => stampNestedTenant("Order", chain(65), T, enforced().policy)).toThrow(
      NestedTenantWalkError,
    );
  });

  it("reports once per walk per kind, not once per row (a 1000-row createMany with foreign tenants is one report)", () => {
    const { policy, report } = dark();
    const rows = Array.from({ length: 1000 }, () => ({ q: 1, tenantId: "other" }));
    const out: any = stampNestedTenant(
      "VendorBill",
      { items: { createMany: { data: rows } } },
      T,
      policy,
    );
    expect(out.items.createMany.data.every((r: any) => r.tenantId === T)).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][1]).not.toMatch(/\[\d+\]/); // no per-row index in the site
  });
});
