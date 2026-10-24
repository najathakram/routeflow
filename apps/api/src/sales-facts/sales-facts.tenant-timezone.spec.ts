import { SalesFactsService } from "./sales-facts.service";
import { createMockPrisma } from "../testing/prisma-mock";

/** SA-738: the sales-facts/product-insights/export zone is the RESOLVED zone, never a raw stored string. */
describe("SalesFactsService.tenantTimezone", () => {
  const make = (row: unknown) => {
    const prisma = createMockPrisma() as any;
    prisma.tenantConfig.findUnique = jest.fn().mockResolvedValue(row);
    return new SalesFactsService(prisma);
  };

  it("passes a valid zone through unchanged (characterization)", async () => {
    await expect(make({ timezone: "America/Chicago" }).tenantTimezone("t1")).resolves.toBe(
      "America/Chicago",
    );
  });

  it("a tenant with no config row is on UTC", async () => {
    await expect(make(null).tenantTimezone("t1")).resolves.toBe("UTC");
  });

  it("an invalid stored zone is UTC, not the raw string", async () => {
    await expect(make({ timezone: "Mars/Phobos" }).tenantTimezone("t1")).resolves.toBe("UTC");
  });
});
