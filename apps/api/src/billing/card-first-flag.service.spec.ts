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

  it("R7-6: after a good read, a later read error keeps the LAST value (on stays on, off stays off)", async () => {
    jest.useFakeTimers();
    try {
      const on = build(
        jest
          .fn()
          .mockResolvedValueOnce([{ value: "on" }])
          .mockRejectedValue(new Error("db down")),
      );
      expect(await on.svc.isEnabled()).toBe(true);
      jest.advanceTimersByTime(6_000); // past the cache: the next call re-reads, and the read fails
      expect(await on.svc.isEnabled()).toBe(true);
      const off = build(
        jest
          .fn()
          .mockResolvedValueOnce([{ value: "off" }])
          .mockRejectedValue(new Error("db down")),
      );
      expect(await off.svc.isEnabled()).toBe(false);
      jest.advanceTimersByTime(6_000);
      expect(await off.svc.isEnabled()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("R7-6: false only when nothing was ever read (a first read that fails)", async () => {
    expect(await build(jest.fn().mockRejectedValue(new Error("db down"))).svc.isEnabled()).toBe(
      false,
    );
  });
});
