import { dunningZone } from "./dunning-zone";

/** The dunning 03:00 rule reads the tenant zone ONLY through the single reader (`resolveZone`, SA-738). */
const prismaWith = (findUnique: jest.Mock) => ({ tenantConfig: { findUnique } }) as never;

describe("dunningZone", () => {
  it("resolves by the explicit tenant id (context-object form): no ambient tenant is needed", async () => {
    const findUnique = jest.fn().mockResolvedValue({ timezone: "America/Chicago" });
    expect(await dunningZone(prismaWith(findUnique), "t1")).toBe("America/Chicago");
    expect(findUnique).toHaveBeenCalledWith({
      where: { tenantId: "t1" },
      select: { timezone: true },
    });
  });

  it("a missing config row, a null zone and an invalid zone all fall back to UTC", async () => {
    for (const cfg of [null, { timezone: null }, { timezone: "Not/AZone" }, { timezone: "" }]) {
      expect(await dunningZone(prismaWith(jest.fn().mockResolvedValue(cfg)), "t1")).toBe("UTC");
    }
  });

  it("a failed lookup never stops a sweep: UTC", async () => {
    const findUnique = jest.fn().mockRejectedValue(new Error("db down"));
    expect(await dunningZone(prismaWith(findUnique), "t1")).toBe("UTC");
  });
});
