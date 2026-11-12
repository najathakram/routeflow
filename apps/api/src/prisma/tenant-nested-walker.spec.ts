import * as fs from "fs";
import * as path from "path";
import { Prisma } from "@prisma/client";
import {
  buildRelationIndex,
  findNestedTenantGaps,
  stampNestedTenant,
  type RelationIndex,
} from "./tenant-nested-walker";

/**
 * SA-1110 (B929) rows W-5, W-6, W-7 and the stamp rules 1-4 as pure specs, plus the two pins: the class pin
 * (every tenant-owned relation of the REAL schema is stamped and reported, no hand list) and the one-home pin
 * (the old one-level predicates no longer exist). Synthetic models drive the traversal depth the real schema
 * does not need to reach; the real DMMF drives the rest.
 */
const scalar = (name: string) => ({ name, kind: "scalar", type: "String", isList: false });
const rel = (name: string, type: string, isList: boolean, from: string[] = []) => ({
  name,
  kind: "object",
  type,
  isList,
  relationFromFields: from,
});
const tenantRel = rel("tenant", "Tenant", false, ["tenantId"]);
// A (tenant-owned) -> items: B[] (tenant-owned) -> sub: C[] (tenant-owned) ; Plain (no tenantId) -> bs: B[]
const MODELS = [
  { name: "Tenant", fields: [scalar("id")] },
  { name: "A", fields: [scalar("tenantId"), tenantRel, rel("items", "B", true)] },
  {
    name: "B",
    fields: [
      scalar("tenantId"),
      scalar("aId"),
      scalar("productId"),
      tenantRel,
      rel("a", "A", false, ["aId"]),
      rel("product", "P", false, ["productId"]),
      rel("sub", "C", true),
    ],
  },
  { name: "C", fields: [scalar("tenantId"), tenantRel] },
  { name: "P", fields: [scalar("tenantId"), tenantRel] },
  // tenantId scalar only: no `tenant` relation, so rule 3 can never apply
  { name: "D", fields: [scalar("tenantId")] },
  { name: "Plain", fields: [rel("bs", "B", true), rel("d", "D", false)] },
  { name: "A2", fields: [scalar("tenantId"), rel("one", "B", false)] },
] as unknown as Prisma.DMMF.Model[];
const IDX: RelationIndex = buildRelationIndex(MODELS);
const T = "t-ctx";

describe("the relation index", () => {
  it("records child, tenant ownership, a tenant relation and the owning keys per relation", () => {
    const items = IDX.get("A")?.get("items");
    expect(items).toMatchObject({
      child: "B",
      childIsTenantOwned: true,
      childHasTenantRelation: true,
    });
    expect([...(items?.owningRelationKeys ?? [])].sort()).toEqual(["a", "product"]);
    expect(IDX.get("Plain")?.get("d")).toMatchObject({
      child: "D",
      childIsTenantOwned: true,
      childHasTenantRelation: false,
    });
    expect(IDX.get("B")?.get("sub")?.owningRelationKeys.size).toBe(0);
  });

  it("the default index is built once", () => {
    expect(buildRelationIndex()).toBe(buildRelationIndex());
  });
});

describe("stamp rules 1-4 (first hit wins, context wins)", () => {
  it("rule 4: a plain child gets the scalar tenantId", () => {
    const out = stampNestedTenant("A", { items: { create: { x: 1 } } }, T, IDX) as any;
    expect(out.items.create).toEqual({ x: 1, tenantId: T });
  });

  it("rule 1: a child that holds a tenant key gets the connect form, and its scalar tenantId goes", () => {
    const out = stampNestedTenant(
      "A",
      { items: { create: [{ x: 1, tenant: { connect: { id: "other" } }, tenantId: "other" }] } },
      T,
      IDX,
    ) as any;
    expect(out.items.create[0]).toEqual({ x: 1, tenant: { connect: { id: T } } });
  });

  it("rule 2: a createMany element takes the scalar, even beside a checked-looking key", () => {
    const out = stampNestedTenant(
      "A",
      { items: { createMany: { data: [{ x: 1 }, { x: 2, product: { connect: { id: "p" } } }] } } },
      T,
      IDX,
    ) as any;
    expect(out.items.createMany.data).toEqual([
      { x: 1, tenantId: T },
      { x: 2, product: { connect: { id: "p" } }, tenantId: T },
    ]);
  });

  it("rule 3: an owning relation in checked form takes tenant: { connect }, never a scalar", () => {
    const out = stampNestedTenant(
      "A",
      { items: { create: [{ x: 1, product: { connect: { id: "p" } } }] } },
      T,
      IDX,
    ) as any;
    expect(out.items.create[0]).toEqual({
      x: 1,
      product: { connect: { id: "p" } },
      tenant: { connect: { id: T } },
    });
    expect("tenantId" in out.items.create[0]).toBe(false);
  });

  it("rule 3 needs a tenant relation on the child: without one the scalar is used (rule 4)", () => {
    const out = stampNestedTenant("Plain", { d: { create: { x: 1 } } }, T, IDX) as any;
    expect(out.d.create).toEqual({ x: 1, tenantId: T });
  });

  it("W-7: a different explicit child tenantId is replaced by the context, at every depth", () => {
    const out = stampNestedTenant(
      "A",
      { items: { create: [{ tenantId: "other", sub: { create: { tenantId: "other2" } } }] } },
      T,
      IDX,
    ) as any;
    expect(out.items.create[0].tenantId).toBe(T);
    expect(out.items.create[0].sub.create.tenantId).toBe(T);
  });

  it("a non-relation key named like a payload word is left alone", () => {
    const data = { create: { x: 1 }, items: { connect: [{ id: "b" }] } };
    expect(stampNestedTenant("A", data, T, IDX)).toEqual(data);
  });
});

describe("traversal, every depth and every payload kind", () => {
  it("W-5: depth 2 is stamped under TENANT and reported as A.items.sub, one path however many rows", () => {
    const data = () => ({
      items: {
        create: [{ tenantId: "t", sub: { create: [{ q: 1 }, { q: 2 }] } }, { tenantId: "t" }],
      },
    });
    const stamped = stampNestedTenant("A", data(), T, IDX) as any;
    expect(stamped.items.create[0].sub.create).toEqual([
      { q: 1, tenantId: T },
      { q: 2, tenantId: T },
    ]);
    expect(findNestedTenantGaps("A", stamped, IDX)).toEqual([]);
    expect(findNestedTenantGaps("A", data(), IDX)).toEqual(["A.items.sub"]);
  });

  it("W-6: connectOrCreate and nested upsert create children are stamped and reported", () => {
    const data = () => ({
      items: {
        connectOrCreate: [{ where: { id: "x" }, create: { q: 1 } }],
        upsert: [{ where: { id: "y" }, create: { q: 2 }, update: { sub: { create: { q: 3 } } } }],
      },
    });
    const out = stampNestedTenant("A", data(), T, IDX) as any;
    expect(out.items.connectOrCreate[0].create).toEqual({ q: 1, tenantId: T });
    expect(out.items.upsert[0].create).toEqual({ q: 2, tenantId: T });
    expect(out.items.upsert[0].update.sub.create).toEqual({ q: 3, tenantId: T });
    expect(findNestedTenantGaps("A", data(), IDX).sort()).toEqual(["A.items", "A.items.sub"]);
  });

  it("a create under update.data, update[].data and a to-one update is walked", () => {
    const upd = {
      items: {
        update: [{ where: { id: "b" }, data: { sub: { create: { q: 1 } } } }],
        createMany: { data: [{ q: 2 }] },
      },
    };
    const out = stampNestedTenant("A", upd, T, IDX) as any;
    expect(out.items.update[0].data.sub.create).toEqual({ q: 1, tenantId: T });
    expect(out.items.update[0].where).toEqual({ id: "b" });
    // the update payload itself is not a create: no tenant is written into it
    expect("tenantId" in out.items.update[0].data).toBe(false);
    expect(findNestedTenantGaps("A", upd, IDX).sort()).toEqual(["A.items", "A.items.sub"]);

    const one = { one: { update: { sub: { create: {} } } } };
    expect(findNestedTenantGaps("A2", one, IDX)).toEqual(["A2.one.sub"]);
    const oneWithData = { one: { update: { where: {}, data: { sub: { create: {} } } } } };
    expect(findNestedTenantGaps("A2", oneWithData, IDX)).toEqual(["A2.one.sub"]);
  });

  it("recurses through a child that is not tenant-owned and stamps the tenant-owned one below it", () => {
    const out = stampNestedTenant("Plain", { bs: { create: { q: 1 } } }, T, IDX) as any;
    expect(out.bs.create.tenantId).toBe(T);
    const through = buildRelationIndex([
      { name: "Top", fields: [rel("mid", "Mid", false)] },
      { name: "Mid", fields: [rel("leaf", "C", true)] },
      MODELS[3],
    ] as unknown as Prisma.DMMF.Model[]);
    const data = { mid: { create: { leaf: { create: {} } } } };
    expect(findNestedTenantGaps("Top", data, through)).toEqual(["Top.mid.leaf"]);
  });

  it("a child that already names a tenant is no gap; an empty or null tenantId is", () => {
    const named = { items: { create: [{ tenantId: "t" }, { tenant: { connect: { id: "t" } } }] } };
    expect(findNestedTenantGaps("A", named, IDX)).toEqual([]);
    for (const tenantId of [undefined, null, ""]) {
      expect(findNestedTenantGaps("A", { items: { create: { tenantId } } }, IDX)).toEqual([
        "A.items",
      ]);
    }
  });

  it("an array at the root (createMany rows) is read row by row", () => {
    expect(findNestedTenantGaps("A", [{}, { items: { create: {} } }], IDX)).toEqual(["A.items"]);
  });

  it("connect, set, disconnect and delete are not payloads", () => {
    const data = {
      items: {
        connect: [{ id: "b" }],
        set: [],
        disconnect: [],
        delete: [{ id: "c" }],
        deleteMany: {},
      },
    };
    expect(findNestedTenantGaps("A", data, IDX)).toEqual([]);
    expect(stampNestedTenant("A", data, T, IDX)).toBe(data);
  });

  it("never mutates the caller's object, and shares what it did not touch", () => {
    const deepFreeze = (o: any): any => {
      if (o && typeof o === "object") Object.values(o).forEach(deepFreeze);
      return o && typeof o === "object" ? Object.freeze(o) : o;
    };
    const keep = { big: true };
    const input = deepFreeze({
      note: keep,
      items: { create: [{ x: 1, sub: { create: { q: 1 } } }], createMany: { data: [{ x: 2 }] } },
    });
    const snapshot = JSON.stringify(input);
    const out = stampNestedTenant("A", input, T, IDX) as any;
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).not.toBe(input);
    expect(out.note).toBe(keep);
    expect(out.items.create[0].tenantId).toBe(T);
  });

  it("junk payloads (undefined, null, strings, empty objects) pass through untouched", () => {
    for (const junk of [undefined, null, "x", 3, {}]) {
      expect(stampNestedTenant("A", junk, T, IDX)).toBe(junk);
      expect(findNestedTenantGaps("A", junk, IDX)).toEqual([]);
    }
    expect(findNestedTenantGaps("NoSuchModel", { items: { create: {} } }, IDX)).toEqual([]);
  });
});

describe("W-4 shape on the real schema: a checked-form child under VendorBill.items", () => {
  it("takes the tenant connect, not a scalar (Prisma refuses a scalar beside a relation)", () => {
    const out = stampNestedTenant(
      "VendorBill",
      { items: { create: [{ description: "d", product: { connect: { id: "p" } } }] } },
      T,
    ) as any;
    expect(out.items.create[0].tenant).toEqual({ connect: { id: T } });
    expect("tenantId" in out.items.create[0]).toBe(false);
  });
});

describe("owning-key pin: the runtime DMMF has no relationFromFields, so the schema folder is the judge", () => {
  const SCHEMA = path.join(__dirname, "..", "..", "prisma", "schema");
  const truth = new Map<string, Set<string>>(); // model -> relation fields that hold the FK, from the schema text
  for (const f of fs.readdirSync(SCHEMA).filter((n) => n.endsWith(".prisma"))) {
    for (const m of fs
      .readFileSync(path.join(SCHEMA, f), "utf8")
      .matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      const owning = new Set<string>();
      for (const r of m[2].matchAll(
        /^\s*(\w+)\s+\w+\??\s+@relation\([^)]*?fields:\s*\[([^\]]+)\]/gm,
      )) {
        if (r[1] !== "tenant") owning.add(r[1]);
      }
      truth.set(m[1], owning);
    }
  }

  it("reads a believable number of owning relations (non-vacuous)", () => {
    expect([...truth.values()].reduce((n, s) => n + s.size, 0)).toBeGreaterThan(150);
    expect(truth.get("VendorBillItem")).toEqual(
      new Set(["vendorBill", "product", "familyProduct"]),
    );
  });

  it("the index agrees with the schema text for every relation's child", () => {
    const wrong: string[] = [];
    for (const [parent, rels] of buildRelationIndex()) {
      for (const [key, info] of rels) {
        const expected = [...(truth.get(info.child) ?? [])].sort().join(",");
        const got = [...info.owningRelationKeys].sort().join(",");
        if (expected !== got)
          wrong.push(`${parent}.${key} -> ${info.child}: schema [${expected}] index [${got}]`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("class pin: every tenant-owned relation of the real schema (no hand list)", () => {
  const real = buildRelationIndex();
  const pairs = [...real].flatMap(([model, fields]) =>
    [...fields].filter(([, info]) => info.childIsTenantOwned).map(([key]) => [model, key] as const),
  );

  it("finds relation pairs at all (zero pairs would make this pin vacuous)", () => {
    expect(pairs.length).toBeGreaterThan(50);
    expect(pairs).toContainEqual(["VendorBill", "items"]);
  });

  it("stamps {R:{create:{}}} to a child with a tenant, and reports M.R on the unstamped payload", () => {
    const bad: string[] = [];
    for (const [model, key] of pairs) {
      const data = { [key]: { create: {} } };
      const gaps = findNestedTenantGaps(model, data);
      const stamped = stampNestedTenant(model, data, T) as any;
      const child = stamped[key].create;
      const named = child.tenantId === T || child.tenant?.connect?.id === T;
      if (!gaps.includes(`${model}.${key}`) || !named) bad.push(`${model}.${key}`);
      if (findNestedTenantGaps(model, stamped).length) bad.push(`${model}.${key} (still a gap)`);
    }
    expect(bad).toEqual([]);
  });
});

describe("one-home pin: the one-level predicates are gone, and prisma.service uses the walker", () => {
  const srcRoot = path.join(__dirname, "..");
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
    });
  const self = path.basename(__filename);

  it.each(["tenantRelationTarget", "nestedCreateGap"])(
    "%s appears nowhere in apps/api/src",
    (word) => {
      const hits = files(srcRoot)
        .filter((f) => path.basename(f) !== self)
        .filter((f) => fs.readFileSync(f, "utf8").includes(word))
        .map((f) => path.relative(srcRoot, f));
      expect(hits).toEqual([]);
    },
  );

  it("prisma.service.ts imports the walker by name", () => {
    const svc = fs.readFileSync(path.join(__dirname, "prisma.service.ts"), "utf8");
    const importLine = /import \{([^}]*)\} from "\.\/tenant-nested-walker"/.exec(svc)?.[1] ?? "";
    expect(importLine).toMatch(/\bstampNestedTenant\b/);
    expect(importLine).toMatch(/\bfindNestedTenantGaps\b/);
  });
});
