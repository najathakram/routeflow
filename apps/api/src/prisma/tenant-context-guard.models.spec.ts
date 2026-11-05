/**
 * SA-1105 Q4: the dark warn covers EVERY tenant-owned model, above all the ones whose `tenantId` column is nullable (a
 * create without it writes NULL silently; a required column fails loudly in Prisma). The nullable set is read from the
 * schema FOLDER text, the guarded set from the generated client, so a model added later is covered the day it lands.
 */
import * as fs from "fs";
import * as path from "path";
import { Prisma } from "@prisma/client";
import { isTenantModel, tenantRelationTarget } from "./prisma.service";

const SCHEMA = path.join(__dirname, "..", "..", "prisma", "schema");

function nullableTenantModels(): string[] {
  const names: string[] = [];
  for (const f of fs.readdirSync(SCHEMA).filter((n) => n.endsWith(".prisma"))) {
    for (const m of fs
      .readFileSync(path.join(SCHEMA, f), "utf8")
      .matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      if (/^\s+tenantId\s+String\?/m.test(m[2])) names.push(m[1]);
    }
  }
  return names.sort();
}

describe("the guard covers every nullable-tenantId model", () => {
  const nullable = nullableTenantModels();

  it("reads a believable number of them from the schema folder (non-vacuous)", () => {
    expect(nullable.length).toBeGreaterThan(50);
    expect(nullable).toContain("Customer");
  });

  it("each one is a tenant-owned model the guard checks", () => {
    expect(nullable.filter((m) => !isTenantModel(m))).toEqual([]);
  });

  it("nested-create detection resolves a relation to its tenant-owned child, one level", () => {
    expect(tenantRelationTarget("Order", "invoices")).toBe("Invoice");
    expect(tenantRelationTarget("Order", "lineItems")).toBe("OrderItem");
    // a relation to a model with no tenantId is not a tenant-owned child: nothing to check there
    const plain = Prisma.dmmf.datamodel.models
      .flatMap((m) => m.fields.map((f) => ({ parent: m.name, f })))
      .find(({ f }) => f.kind === "object" && !isTenantModel(f.type));
    expect(plain).toBeDefined();
    expect(tenantRelationTarget(plain!.parent, plain!.f.name)).toBeUndefined();
    expect(tenantRelationTarget("order", "invoices")).toBe(
      tenantRelationTarget("Order", "invoices"),
    );
    expect(tenantRelationTarget("Order", "noSuchRelation")).toBeUndefined();
  });
});
