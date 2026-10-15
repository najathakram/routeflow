import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateTenantPriceDto } from "./update-tenant-price.dto";

async function errorsFor(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(UpdateTenantPriceDto, body));
  return errors.map((e) => e.property);
}

describe("UpdateTenantPriceDto (SA-733 D8)", () => {
  it.each(["next_cycle", "now_prorated"])("accepts effective=%s", async (effective) => {
    expect(await errorsFor({ monthly: 80, effective })).toEqual([]);
  });

  it("effective is optional (the service defaults it to next_cycle)", async () => {
    expect(await errorsFor({ monthly: 80 })).toEqual([]);
  });

  it.each(["immediately", "NEXT_CYCLE", "", 1])("rejects effective=%p", async (effective) => {
    expect(await errorsFor({ monthly: 80, effective })).toContain("effective");
  });

  it("keeps the existing fee rules (null clears; 3 decimals and negatives are refused)", async () => {
    expect(await errorsFor({ monthly: null, annual: null })).toEqual([]);
    expect(await errorsFor({ monthly: 10.005 })).toContain("monthly");
    expect(await errorsFor({ annual: -1 })).toContain("annual");
  });
});
