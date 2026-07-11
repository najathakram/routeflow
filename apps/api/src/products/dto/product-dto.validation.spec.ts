import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateProductDto } from "./create-product.dto";
import { UpdateProductDto } from "./update-product.dto";

/**
 * Locks the tolerant-optional behavior of the product DTOs. The product edit
 * form naturally produces empty strings; before the @Transform hardening,
 * `parentProductId: ""` failed @IsUUID and a cleared tier failed @IsDecimal —
 * a 400 on EVERY save of a standalone product from the detail page (the
 * reported "error saving tier prices").
 */
describe("product DTO validation (tolerant optionals)", () => {
  const validateUpdate = async (payload: Record<string, unknown>) => {
    const dto = plainToInstance(UpdateProductDto, payload);
    return { dto, errors: await validate(dto) };
  };

  it('treats parentProductId: "" as absent (the tier-save 400 root cause)', async () => {
    const { dto, errors } = await validateUpdate({
      name: "Cherry Tomatoes",
      priceTier2: "9.00",
      parentProductId: "",
    });
    expect(errors).toHaveLength(0);
    expect(dto.parentProductId).toBeUndefined();
  });

  it("still accepts a real parent UUID and rejects a malformed one", async () => {
    const ok = await validateUpdate({ parentProductId: "b4b2ff28-9d55-4c62-8f39-1d1a0f6f4e11" });
    expect(ok.errors).toHaveLength(0);
    const bad = await validateUpdate({ parentProductId: "not-a-uuid" });
    expect(bad.errors.map((e) => e.property)).toContain("parentProductId");
  });

  it('treats cleared tier fields ("") as absent instead of 400ing', async () => {
    const { dto, errors } = await validateUpdate({ priceTier2: "", priceTier3: "   " });
    expect(errors).toHaveLength(0);
    expect(dto.priceTier2).toBeUndefined();
    expect(dto.priceTier3).toBeUndefined();
  });

  it("accepts tier prices as numbers (coerced to decimal strings)", async () => {
    const { dto, errors } = await validateUpdate({ priceTier2: 9.5, priceTier4: 8 });
    expect(errors).toHaveLength(0);
    expect(dto.priceTier2).toBe("9.5");
    expect(dto.priceTier4).toBe("8");
  });

  it("accepts tier prices as decimal strings (existing web behavior unchanged)", async () => {
    const { dto, errors } = await validateUpdate({ priceTier5: "7.25" });
    expect(errors).toHaveLength(0);
    expect(dto.priceTier5).toBe("7.25");
  });

  it('still rejects junk tier values ("NaN", "abc")', async () => {
    const nan = await validateUpdate({ priceTier2: "NaN" });
    expect(nan.errors.map((e) => e.property)).toContain("priceTier2");
    const abc = await validateUpdate({ priceTier3: "abc" });
    expect(abc.errors.map((e) => e.property)).toContain("priceTier3");
  });

  it("accepts a NUMERIC pricePerUnit + standardCost (mobile sends numbers)", async () => {
    // Before the @Transform hardening these @IsDecimal string fields had no
    // coercion, so a numeric price 400'd EVERY mobile product create/edit.
    const create = plainToInstance(CreateProductDto, {
      name: "T",
      unit: "ea",
      pricePerUnit: 12.5,
      standardCost: 4,
    });
    expect(await validate(create)).toHaveLength(0);
    expect(create.pricePerUnit).toBe("12.5");
    expect(create.standardCost).toBe("4");

    const { dto, errors } = await validateUpdate({ pricePerUnit: 7, standardCost: 3 });
    expect(errors).toHaveLength(0);
    expect(dto.pricePerUnit).toBe("7");
    expect(dto.standardCost).toBe("3");
  });

  it("still requires a non-empty pricePerUnit on create", async () => {
    const dto = plainToInstance(CreateProductDto, { name: "T", unit: "ea", pricePerUnit: "" });
    expect((await validate(dto)).map((e) => e.property)).toContain("pricePerUnit");
  });

  it("applies the same tolerance on CreateProductDto", async () => {
    const dto = plainToInstance(CreateProductDto, {
      name: "New Product",
      unit: "each",
      pricePerUnit: "10.00",
      priceTier2: "",
      priceTier3: 9,
      parentProductId: "",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.priceTier2).toBeUndefined();
    expect(dto.priceTier3).toBe("9");
    expect(dto.parentProductId).toBeUndefined();
  });
});
