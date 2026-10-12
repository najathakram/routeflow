import {
  AUTO_LOCK_KINDS,
  AUTO_LOCK_SKIP_AUDIT_ACTION,
  autoLockAllowed,
  autoLockKindOfMilestone,
  recordAutoLockSkip,
  type AutoLockKind,
} from "./auto-lock-gate";

const sw = (paused: boolean) => ({ isPaused: jest.fn().mockResolvedValue(paused) });

describe("autoLockAllowed: the class x paused matrix", () => {
  const classes = ["PRODUCTION", "DEMO", "TEST", "INTERNAL"] as const;
  it.each(AUTO_LOCK_KINDS.flatMap((k) => classes.map((c) => [k, c] as const)))(
    "%s / %s",
    async (kind: AutoLockKind, cls) => {
      // paused: only PRODUCTION is held
      expect(await autoLockAllowed(sw(true), { id: "t", class: cls }, kind)).toBe(
        cls !== "PRODUCTION",
      );
      // unpaused: everything locks as today
      expect(await autoLockAllowed(sw(false), { id: "t", class: cls }, kind)).toBe(true);
    },
  );

  it("does not even read the switch for a non-PRODUCTION tenant", async () => {
    const s = sw(true);
    await autoLockAllowed(s, { id: "t", class: "TEST" }, "trial_expired");
    expect(s.isPaused).not.toHaveBeenCalled();
  });

  it("an unwired switch (a bare unit spec) and a missing class both allow", async () => {
    expect(
      await autoLockAllowed(undefined, { id: "t", class: "PRODUCTION" }, "trial_expired"),
    ).toBe(true);
    expect(await autoLockAllowed(sw(true), { id: "t", class: undefined }, "trial_expired")).toBe(
      true,
    );
  });
});

describe("autoLockKindOfMilestone", () => {
  it("round-trips every kind and rejects foreign milestones", () => {
    for (const k of AUTO_LOCK_KINDS) {
      expect(autoLockKindOfMilestone(`AUTO_LOCK_PAUSED:${k}`)).toBe(k);
    }
    expect(autoLockKindOfMilestone("TRIAL_ENDING_7D")).toBeNull();
    expect(autoLockKindOfMilestone("AUTO_LOCK_PAUSED:nope")).toBeNull();
  });
});

/** A tiny in-memory stand-in for the two tables the recorder touches (ON CONFLICT DO NOTHING semantics). */
function memoryClient() {
  const claims = new Set<string>();
  const audits: any[] = [];
  const tx: any = {
    billingNotificationLog: {
      createMany: jest.fn(async ({ data }: any) => {
        let count = 0;
        for (const d of data) {
          const k = `${d.tenantId}|${d.milestone}|${d.key}`;
          if (!claims.has(k)) {
            claims.add(k);
            count++;
          }
        }
        return { count };
      }),
    },
    auditLog: { create: jest.fn(async ({ data }: any) => void audits.push(data)) },
  };
  const client: any = { ...tx, $transaction: jest.fn(async (fn: any) => fn(tx)) };
  return { client, tx, claims, audits };
}

describe("recordAutoLockSkip", () => {
  const skip = {
    tenantId: "t1",
    kind: "trial_expired" as const,
    key: "2026-10-01T00:00:00.000Z",
    wouldHaveSet: { status: "READ_ONLY", readOnlyReason: "trial_expired" },
  };

  it("one claim and ONE audit row, however many hourly passes meet the same case (x3)", async () => {
    const { client, claims, audits } = memoryClient();
    const results = [
      await recordAutoLockSkip(client, skip),
      await recordAutoLockSkip(client, skip),
      await recordAutoLockSkip(client, skip),
    ];
    expect(results).toEqual([true, false, false]);
    expect([...claims]).toEqual(["t1|AUTO_LOCK_PAUSED:trial_expired|2026-10-01T00:00:00.000Z"]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenantId: "t1",
      action: AUTO_LOCK_SKIP_AUDIT_ACTION,
      entityType: "Tenant",
      entityId: "t1",
      userId: null,
    });
    expect(audits[0].meta).toMatchObject({
      kind: "trial_expired",
      wouldHaveSet: skip.wouldHaveSet,
      reason: "paused by rollout switch",
    });
  });

  it("a new key (an EXTENDED trial) or a new kind is a new case", async () => {
    const { client, audits } = memoryClient();
    await recordAutoLockSkip(client, skip);
    await recordAutoLockSkip(client, { ...skip, key: "2026-11-01T00:00:00.000Z" });
    await recordAutoLockSkip(client, { ...skip, kind: "trial_cancelled" });
    expect(audits).toHaveLength(3);
  });

  it("writes the actor's user id for a held tenant click, and nothing else about people", async () => {
    const { client, audits } = memoryClient();
    await recordAutoLockSkip(client, { ...skip, kind: "trial_cancelled", actorId: "u9" });
    expect(audits[0].userId).toBe("u9");
    expect(JSON.stringify(audits[0].meta)).not.toMatch(/email|name/i);
  });

  it("joins an open transaction client (no nested $transaction)", async () => {
    const { tx, audits } = memoryClient();
    expect(await recordAutoLockSkip(tx, skip)).toBe(true);
    expect(audits).toHaveLength(1);
  });

  it("never throws: a failing write is logged and reported as not recorded", async () => {
    const { client, tx } = memoryClient();
    tx.billingNotificationLog.createMany.mockRejectedValueOnce(new Error("boom"));
    const warn = jest.fn();
    expect(await recordAutoLockSkip(client, skip, { warn })).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skip_record_failed"));
  });
});
