import { CardFirstFlagService, CARD_FIRST_FLAG_KEY } from "./card-first-flag.service";

function build(read: jest.Mock) {
  const prisma = { $queryRaw: read, $executeRaw: jest.fn().mockResolvedValue(1) };
  return { svc: new CardFirstFlagService(prisma as never), prisma };
}

describe("CardFirstFlagService (SA-774: platform-level dark flag, fail-closed)", () => {
  it("uses its own platform key", () => {
    expect(CARD_FIRST_FLAG_KEY).toBe("billing.cardFirstPlanPick");
  });

  it("defaults OFF when there is no row", async () => {
    expect(await build(jest.fn().mockResolvedValue([])).svc.isEnabled()).toBe(false);
  });

  it.each(["on", "ON", " On "])("the value %p turns it on", async (v) => {
    expect(await build(jest.fn().mockResolvedValue([{ value: v }])).svc.isEnabled()).toBe(true);
  });

  it.each(["off", "", "yes", "true", "1", "enabled", "onn"])(
    "the value %p is OFF (only the literal 'on' enables it)",
    async (v) => {
      expect(await build(jest.fn().mockResolvedValue([{ value: v }])).svc.isEnabled()).toBe(false);
    },
  );

  it("fails CLOSED on a read error and does not cache the failure", async () => {
    const read = jest
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce([{ value: "on" }]);
    const { svc } = build(read);
    expect(await svc.isEnabled()).toBe(false);
    expect(await svc.isEnabled()).toBe(true);
  });

  it("caches a good read briefly, and setEnabled() updates the cache at once", async () => {
    const read = jest.fn().mockResolvedValue([{ value: "on" }]);
    const { svc, prisma } = build(read);
    await svc.isEnabled();
    await svc.isEnabled();
    expect(read).toHaveBeenCalledTimes(1);
    await svc.setEnabled(false);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(await svc.isEnabled()).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("writes the literal 'on' / 'off' (per call, a swap must fail)", async () => {
    const { svc, prisma } = build(jest.fn());
    await svc.setEnabled(true);
    await svc.setEnabled(false);
    const bound = prisma.$executeRaw.mock.calls.map((c: unknown[]) => c[c.length - 1]);
    expect(bound).toEqual(["on", "off"]);
  });
});
