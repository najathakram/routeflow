import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateProductDto } from "./dto/update-product.dto";
import { assertPackUnchanged, PRODUCT_PACK_STALE_MESSAGE } from "./pack-precondition";

/** SA-797 (row 218): the value precondition's wire shape and compare, apart from the service. */
describe("pack precondition (SA-797)", () => {
  // the app's global ValidationPipe options (main.ts)
  const check = (body: object) =>
    validate(plainToInstance(UpdateProductDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it("the PATCH DTO accepts the expected pack values (an unknown field would be a 400)", async () => {
    const body = {
      unit: "Crate",
      expectedUnit: "Box",
      expectedUnitsPerBox: 24,
      expectedTenantUnitId: "6f1c2b9e-3a4d-4c5e-9f00-1a2b3c4d5e6f",
    };
    expect(await check(body)).toEqual([]);
    expect(
      await check({ unit: "Crate", expectedUnitsPerBox: null, expectedTenantUnitId: null }),
    ).toEqual([]);
    expect(await check({ unit: "Crate", expectedTenantUnitId: "not-a-uuid" })).not.toEqual([]);
  });

  const db = (id: string | null) => ({
    tenantUnit: { findFirst: jest.fn().mockResolvedValue(id ? { id } : null) },
  });

  it("a moved word is refused without looking up the tenant unit", async () => {
    const d = db("tu-1");
    await expect(
      assertPackUnchanged(
        d,
        "t1",
        { unit: "Carton", unitsPerBox: 24 },
        {
          expectedUnit: "Box",
          expectedTenantUnitId: "tu-1",
        },
      ),
    ).rejects.toMatchObject({
      response: { code: "PRODUCT_PACK_STALE", message: PRODUCT_PACK_STALE_MESSAGE },
    });
    expect(d.tenantUnit.findFirst).not.toHaveBeenCalled();
  });

  it("an unlinked pack read as unlinked (null) passes; one linked since is refused", async () => {
    const locked = { unit: "Box", unitsPerBox: null };
    await expect(
      assertPackUnchanged(db(null), "t1", locked, { expectedTenantUnitId: null }),
    ).resolves.toBeUndefined();
    await expect(
      assertPackUnchanged(db("tu-1"), "t1", locked, { expectedTenantUnitId: null }),
    ).rejects.toMatchObject({ response: { code: "PRODUCT_PACK_STALE" } });
  });

  it("the word compare is exact: a case-only rename (box -> Box) is a change the form did not read", async () => {
    await expect(
      assertPackUnchanged(
        db(null),
        "t1",
        { unit: "Box", unitsPerBox: 24 },
        { expectedUnit: "box" },
      ),
    ).rejects.toMatchObject({ response: { code: "PRODUCT_PACK_STALE" } });
  });
});
