import { ConfigSnapshotFlagService } from "./config-snapshot-flag.service";

function build(read: jest.Mock) {
  const prisma = { $queryRaw: read, $executeRaw: jest.fn().mockResolvedValue(1) };
  return { svc: new ConfigSnapshotFlagService(prisma as never), prisma };
}

describe("ConfigSnapshotFlagService (A2 decision 2: live flag, fail-closed)", () => {
  it("defaults OFF when there is no row", async () => {
    expect(await build(jest.fn().mockResolvedValue([])).svc.isEnabled()).toBe(false);
  });

  it.each(["on", "ON", " On "])("the value %p turns it on", async (v) => {
    expect(await build(jest.fn().mockResolvedValue([{ value: v }])).svc.isEnabled()).toBe(true);
  });

  it.each(["off", "", "yes", "true", "1", "enabled", "onn", "null"])(
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
    expect(await svc.isEnabled()).toBe(true); // recovered on the very next call
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

  it("writes the literal 'on' for enabled=true and 'off' for enabled=false (per call — a swap must fail)", async () => {
    const { svc, prisma } = build(jest.fn());

    await svc.setEnabled(true);
    await svc.setEnabled(false);

    // A tagged-template call is (strings, ...values): the bound value is the last argument.
    const bound = prisma.$executeRaw.mock.calls.map((c: unknown[]) => c[c.length - 1]);
    expect(bound).toEqual(["on", "off"]);
  });

  describe("setEnabledAudited: the flag write and its audit row are ONE transaction", () => {
    function buildTx(opts: { auditFails?: boolean; writeFails?: boolean } = {}) {
      const calls: string[] = [];
      const tx = {
        $executeRaw: jest.fn(async () => {
          calls.push("flag");
          if (opts.writeFails) throw new Error("write failed");
          return 1;
        }),
        auditLog: {
          create: jest.fn(async () => {
            calls.push("audit");
            if (opts.auditFails) throw new Error("audit failed");
            return {};
          }),
        },
      };
      // a real $transaction: nothing is committed if the callback throws (recorded via `committed`)
      let committed = false;
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue([{ value: "off" }]),
        $executeRaw: jest.fn(),
        $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => {
          await fn(tx);
          committed = true;
        }),
      };
      return {
        svc: new ConfigSnapshotFlagService(prisma as never),
        prisma,
        tx,
        calls,
        committed: () => committed,
      };
    }

    it("writes the flag AND the audit row on the SAME transaction client (never the bare client)", async () => {
      const { svc, prisma, tx, calls, committed } = buildTx();
      await svc.setEnabledAudited(true, { userId: "admin-1", reason: "pilot on the test tenant" });
      expect(calls).toEqual(["flag", "audit"]);
      expect(prisma.$executeRaw).not.toHaveBeenCalled(); // not outside the transaction
      expect(committed()).toBe(true);
      const bound = tx.$executeRaw.mock.calls[0] as unknown as unknown[];
      expect(bound[bound.length - 1]).toBe("on");
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: {
          tenantId: null,
          userId: "admin-1",
          action: "CONFIG_SNAPSHOT_FLAG_CHANGED",
          entityType: "tenant",
          entityId: null,
          meta: { platformAdmin: true, enabled: true, reason: "pilot on the test tenant" },
        },
      });
    });

    it("an audit failure FAILS the flip (it rolls back with the transaction) and the cache does not move", async () => {
      const { svc, prisma, committed } = buildTx({ auditFails: true });
      await expect(svc.setEnabledAudited(true, { userId: "a", reason: "why" })).rejects.toThrow(
        "audit failed",
      );
      expect(committed()).toBe(false);
      // still OFF: the cache was not updated with a value that never committed, so the next read hits the DB
      expect(await svc.isEnabled()).toBe(false);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it("a failed flag write writes no audit row", async () => {
      const { svc, tx } = buildTx({ writeFails: true });
      await expect(svc.setEnabledAudited(false, { userId: "a", reason: "why" })).rejects.toThrow(
        "write failed",
      );
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it("after a committed flip the in-process cache reflects it at once", async () => {
      const { svc, prisma } = buildTx();
      await svc.setEnabledAudited(true, { userId: "a", reason: "why" });
      expect(await svc.isEnabled()).toBe(true);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });
});
