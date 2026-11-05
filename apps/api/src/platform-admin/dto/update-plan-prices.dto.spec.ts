import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdatePlanPricesDto } from "./update-plan-prices.dto";

/** SA-1100 §2: a price edit must carry the count the admin confirmed (`expectedAffected`). */
describe("UpdatePlanPricesDto: expectedAffected", () => {
  const run = (body: Record<string, unknown>) =>
    validate(plainToInstance(UpdatePlanPricesDto, body));

  it("accepts a price with a whole-number count, zero included", async () => {
    expect(await run({ monthly: 149, expectedAffected: 3 })).toHaveLength(0);
    expect(await run({ monthly: 149, expectedAffected: 0 })).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["negative", -1],
    ["a fraction", 1.5],
    ["a string", "3"],
    ["null", null],
  ])("refuses a count that is %s", async (_l, v) => {
    const errors = await run({ monthly: 149, expectedAffected: v });
    expect(errors.map((e) => e.property)).toContain("expectedAffected");
  });
});
