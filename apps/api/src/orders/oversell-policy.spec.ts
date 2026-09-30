import {
  backorderQtyForLine,
  orderableAndBackorder,
  parseOversellPolicy,
  resolveOversellAllowed,
  type OversellPolicyReader,
  type OversellRole,
  type OversellSource,
} from "./oversell-policy";

function fakeReader(value: unknown | (() => unknown)) {
  const read = jest.fn(async () =>
    typeof value === "function" ? (value as () => unknown)() : value,
  );
  return { reader: { read } as OversellPolicyReader, read };
}

describe("parseOversellPolicy", () => {
  it('yields "backorder" only for the exact string', () => {
    expect(parseOversellPolicy("backorder")).toBe("backorder");
  });

  it.each(["off", "yes", "BACKORDER", "allow", "", null, undefined, 1, {}, " backorder"])(
    "fails closed to off for %p",
    (raw) => {
      expect(parseOversellPolicy(raw)).toBe("off");
    },
  );
});

describe("resolveOversellAllowed", () => {
  const policies: unknown[] = ["off", "backorder", undefined, "garbage"];
  const base = { tenantId: "t1", source: "staff_entry" as OversellSource };

  it.each(["TENANT_ADMIN", "OPERATOR", "SUPER_ADMIN"] as OversellRole[])(
    "staff role %s is allowed without reading the policy",
    async (role) => {
      for (const p of policies) {
        const { reader, read } = fakeReader(p);
        await expect(resolveOversellAllowed(reader, { ...base, role })).resolves.toBe(true);
        expect(read).not.toHaveBeenCalled();
      }
    },
  );

  it("DRIVER is never allowed and never reads, even under backorder", async () => {
    const { reader, read } = fakeReader("backorder");
    await expect(resolveOversellAllowed(reader, { ...base, role: "DRIVER" })).resolves.toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it("template_cron is allowed under off without reading: current behaviour (pending Q6)", async () => {
    const { reader, read } = fakeReader("off");
    await expect(
      resolveOversellAllowed(reader, { ...base, role: "CUSTOMER", source: "template_cron" }),
    ).resolves.toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([["off"], [undefined], [null], ["garbage"], [42]])(
    "CUSTOMER is denied for policy %p",
    async (p) => {
      const { reader } = fakeReader(p);
      await expect(
        resolveOversellAllowed(reader, { ...base, role: "CUSTOMER", source: "buyer" }),
      ).resolves.toBe(false);
    },
  );

  it("CUSTOMER is denied when the reader throws, and never rejects", async () => {
    const { reader } = fakeReader(() => {
      throw new Error("boom");
    });
    await expect(
      resolveOversellAllowed(reader, { ...base, role: "CUSTOMER", source: "buyer" }),
    ).resolves.toBe(false);
  });

  it("CUSTOMER is allowed under backorder, reading exactly once with customerId passed through", async () => {
    const { reader, read } = fakeReader("backorder");
    await expect(
      resolveOversellAllowed(reader, {
        ...base,
        role: "CUSTOMER",
        source: "buyer",
        customerId: "c1",
      }),
    ).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ tenantId: "t1", customerId: "c1" });
  });

  it("customer-scope override is the reader's job: backorder only for c1", async () => {
    const read = jest.fn(async (a: { tenantId: string; customerId?: string | null }) =>
      a.customerId === "c1" ? "backorder" : "off",
    );
    const reader: OversellPolicyReader = { read };
    const args = { tenantId: "t1", role: "CUSTOMER", source: "buyer" as OversellSource };
    await expect(resolveOversellAllowed(reader, { ...args, customerId: "c1" })).resolves.toBe(true);
    await expect(resolveOversellAllowed(reader, { ...args, customerId: "c2" })).resolves.toBe(
      false,
    );
  });

  it("tenant-level backorder with a customer-level off for c2", async () => {
    const read = jest.fn(async (a: { tenantId: string; customerId?: string | null }) =>
      a.customerId === "c2" ? "off" : "backorder",
    );
    const reader: OversellPolicyReader = { read };
    const args = { tenantId: "t1", role: "CUSTOMER", source: "buyer" as OversellSource };
    await expect(resolveOversellAllowed(reader, { ...args, customerId: "c1" })).resolves.toBe(true);
    await expect(resolveOversellAllowed(reader, { ...args, customerId: "c2" })).resolves.toBe(
      false,
    );
  });
});

describe("backorderQtyForLine", () => {
  it.each([
    [6, 5, true, 1],
    [5, 5, true, 0],
    [6, -2, true, 6],
    [6, 5, false, 0],
    [3, 5, true, 0],
    [2.5, 1, true, 1.5],
  ])("requested %p available %p allow %p -> %p", (requested, available, allowOversell, want) => {
    expect(backorderQtyForLine({ requested, available, allowOversell })).toBe(want);
  });

  it("rounds to 3 decimals", () => {
    expect(backorderQtyForLine({ requested: 0.3, available: 0.1, allowOversell: true })).toBe(0.2);
  });
});

describe("orderableAndBackorder", () => {
  it.each([
    [10, true, { orderable: true, backorder: false }],
    [3, false, { orderable: true, backorder: false }],
    [0, true, { orderable: true, backorder: true }],
    [0, false, { orderable: false, backorder: false }],
    [-1, true, { orderable: true, backorder: true }],
    [-1, false, { orderable: false, backorder: false }],
    [10, false, { orderable: true, backorder: false }],
    [3, true, { orderable: true, backorder: false }],
  ])("stock %p allow %p", (stock, allowOversell, want) => {
    expect(orderableAndBackorder({ stock, allowOversell })).toEqual(want);
  });
});
