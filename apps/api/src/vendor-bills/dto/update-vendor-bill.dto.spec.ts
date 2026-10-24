import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateVendorBillDto } from "./update-vendor-bill.dto";

/**
 * B292: `items: []` on PATCH would delete every line and recreate none. Absent items is "no change"
 * (602's optional semantics); an empty list is a validation error before the service runs.
 */
const run = (body: Record<string, unknown>) =>
  validate(plainToInstance(UpdateVendorBillDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe("UpdateVendorBillDto — items (B292)", () => {
  it("rejects an empty items array", async () => {
    const errors = await run({ items: [] });
    expect(errors.map((e) => e.property)).toEqual(["items"]);
    expect(Object.keys(errors[0].constraints ?? {})).toContain("arrayMinSize");
  });

  it("passes when items is absent (no change to the lines)", async () => {
    expect(await run({ notes: "x" })).toHaveLength(0);
  });

  it("passes one line", async () => {
    expect(await run({ items: [{ description: "Flour", qty: 1, unitCost: 2 }] })).toHaveLength(0);
  });
});
