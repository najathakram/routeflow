import {
  ORDER_SEQ_PATTERN,
  nextOrderNumber,
  nextOrderNumberFor,
  parseOrderSeq,
} from "./order-number";

describe("parseOrderSeq — only `ORD-<1..9 digits>` is part of the sequence", () => {
  it.each([
    ["ORD-00001", 1],
    ["ORD-9", 9],
    ["ORD-00009", 9],
    ["ORD-123456789", 123456789],
  ])("%s -> %i", (n, want) => {
    expect(parseOrderSeq(n)).toBe(want);
  });

  it.each([
    "ORD-SEED-1", // the B587 seed number
    "ORD-SEED",
    "ORD-",
    "ORD",
    "ord-00001", // wrong case
    "ORD-12x",
    "ORD-1-2",
    " ORD-1",
    "ORD-1789012345678", // 13 digits: the template generator's ORD-<epoch ms>
    "ORD-1234567890", // 10 digits: past the cap
    "XYZ-00001",
    "",
    null,
    undefined,
  ])("%p -> null (ignored, never a crash)", (n) => {
    expect(parseOrderSeq(n as never)).toBeNull();
  });
});

describe("nextOrderNumber", () => {
  it.each([
    [null, "ORD-00001"], // a tenant with no orders
    [undefined, "ORD-00001"],
    [0, "ORD-00001"],
    [9, "ORD-00010"], // a tenant at ORD-9 -> ORD-10 (the format pads to 5)
    [99, "ORD-00100"],
    [99999, "ORD-100000"], // grows past the pad
    [BigInt(41), "ORD-00042"], // Prisma returns bigint from a raw MAX
    ["7", "ORD-00008"],
  ])("max %p -> %s", (max, want) => {
    expect(nextOrderNumber(max as never)).toBe(want);
  });

  it("the sequence wall is an explicit RangeError, never a silent ORD-1000000000 that stops matching", () => {
    expect(nextOrderNumber(999_999_998)).toBe("ORD-999999999");
    expect(() => nextOrderNumber(999_999_999)).toThrow(RangeError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -5, "abc"])(
    "a non-numeric/negative max (%p) falls back to ORD-00001 instead of NaN",
    (max) => {
      expect(nextOrderNumber(max as never)).toBe("ORD-00001");
    },
  );
});

describe("nextOrderNumberFor — the query", () => {
  const tx = (rows: unknown) => ({ $queryRaw: jest.fn().mockResolvedValue(rows) });

  it("returns max+1 from the numeric maximum, tenant-scoped, with the conforming-number regex", async () => {
    const t = tx([{ max: BigInt(9) }]);
    await expect(nextOrderNumberFor(t as never, "tenant-1")).resolves.toBe("ORD-00010");
    const [strings, ...values] = t.$queryRaw.mock.calls[0];
    const sql = (strings as TemplateStringsArray).join("?");
    expect(sql).toContain('THEN CAST(substring("orderNumber" from 5) AS bigint)');
    expect(sql).toContain('CASE WHEN "orderNumber" ~'); // the cast is CASE-guarded, whatever the plan
    expect(values).toEqual([ORDER_SEQ_PATTERN, "tenant-1", "tenant-1"]);
  });

  it("a tenant with no conforming order (only ORD-SEED-*) starts at ORD-00001", async () => {
    await expect(nextOrderNumberFor(tx([{ max: null }]) as never, "t")).resolves.toBe("ORD-00001");
  });

  it("an empty result set (no rows at all) also starts at ORD-00001", async () => {
    await expect(nextOrderNumberFor(tx([]) as never, "t")).resolves.toBe("ORD-00001");
  });

  it("a tenant-less caller passes a null tenant (all tenants, as the old lookup did)", async () => {
    const t = tx([{ max: 3 }]);
    await expect(nextOrderNumberFor(t as never, null)).resolves.toBe("ORD-00004");
    expect(t.$queryRaw.mock.calls[0].slice(1)).toEqual([ORDER_SEQ_PATTERN, null, null]);
  });
});
