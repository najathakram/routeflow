import { Prisma } from "@prisma/client";
import { assertNameFree, mapNameUniqueViolation, nameTakenMessage } from "./product-name-rules";

/** SA-603a (a) / SA-603b: the active-only, lock-guarded name check and the P2002 map for the two partial uniques. */
function makeTx(holder: { id: string; name: string } | null) {
  const calls: string[] = [];
  const tx = {
    calls,
    $executeRaw: jest.fn((strings: TemplateStringsArray, ...v: unknown[]) => {
      calls.push(`lock:${String(v[1])}`);
      return Promise.resolve(1);
    }),
    product: {
      findFirst: jest.fn((args: unknown) => {
        calls.push("product.findFirst");
        (tx as any).lastWhere = (args as any).where;
        return Promise.resolve(holder);
      }),
    },
  };
  return tx;
}

describe("assertNameFree", () => {
  it("takes the name lock BEFORE reading, keyed (tenant, parent, lower(name))", async () => {
    const tx = makeTx(null);
    await assertNameFree(tx, {
      tenantId: "t1",
      parentProductId: null,
      name: "Apple",
      excludeId: null,
    });
    expect(tx.calls).toEqual(["lock:t1::apple", "product.findFirst"]);
  });

  it("counts ACTIVE products only, in the same parent scope, case-insensitively, excluding itself", async () => {
    const tx = makeTx(null);
    await assertNameFree(tx, {
      tenantId: "t1",
      parentProductId: "fam",
      name: "Apple",
      excludeId: "me",
    });
    expect((tx as any).lastWhere).toEqual({
      tenantId: "t1",
      isActive: true,
      name: { equals: "Apple", mode: "insensitive" },
      parentProductId: "fam",
      id: { not: "me" },
    });
  });

  it("an active holder is a 409 NAME_TAKEN naming it (standalone and variant copy)", async () => {
    await expect(
      assertNameFree(makeTx({ id: "h", name: "apple" }), {
        tenantId: "t1",
        parentProductId: null,
        name: "Apple",
        excludeId: null,
      }),
    ).rejects.toMatchObject({
      response: {
        code: "NAME_TAKEN",
        message: nameTakenMessage("Apple", false),
        field: "name",
        value: "Apple",
        productId: "h",
        productName: "apple",
      },
    });
    await expect(
      assertNameFree(makeTx({ id: "h", name: "Red" }), {
        tenantId: "t1",
        parentProductId: "fam",
        name: "Red",
        excludeId: null,
      }),
    ).rejects.toMatchObject({
      response: { message: 'A variant named "Red" already exists for this product' },
    });
  });

  it("reactivating uses the readable reactivate copy", async () => {
    await expect(
      assertNameFree(makeTx({ id: "h", name: "Apple" }), {
        tenantId: "t1",
        parentProductId: null,
        name: "Apple",
        excludeId: "me",
        reactivating: true,
      }),
    ).rejects.toMatchObject({
      response: {
        code: "NAME_TAKEN",
        message: `Can't reactivate: an active product named "Apple" already exists. Rename one of them first.`,
      },
    });
  });

  it("no holder -> resolves", async () => {
    await expect(
      assertNameFree(makeTx(null), {
        tenantId: "t1",
        parentProductId: null,
        name: "Apple",
        excludeId: null,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("mapNameUniqueViolation", () => {
  const p2002 = (meta: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "x", meta });

  it("maps the driver-adapter shape for either active-name index", () => {
    for (const index of [
      "Product_tenant_root_name_active_key",
      "Product_tenant_parent_name_active_key",
    ]) {
      expect(() =>
        mapNameUniqueViolation(
          p2002({ driverAdapterError: { cause: { constraint: { index } } } }),
          "Apple",
          false,
        ),
      ).toThrow(
        expect.objectContaining({ response: expect.objectContaining({ code: "NAME_TAKEN" }) }),
      );
    }
  });

  it("maps the native target shape", () => {
    expect(() =>
      mapNameUniqueViolation(
        p2002({ target: "Product_tenant_root_name_active_key" }),
        "Apple",
        false,
      ),
    ).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: "NAME_TAKEN" }) }),
    );
  });

  it("rethrows any other P2002 and any non-Prisma error untouched", () => {
    const other = p2002({ target: "Product_tenantId_sku_key" });
    expect(() => mapNameUniqueViolation(other, "Apple", false)).toThrow(other);
    const plain = new Error("boom");
    expect(() => mapNameUniqueViolation(plain, "Apple", false)).toThrow(plain);
  });
});
