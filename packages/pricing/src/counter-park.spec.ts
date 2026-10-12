import {
  COUNTER_PARK_MAX_LINES,
  COUNTER_PARK_NAME_MAX,
  COUNTER_PARK_NOTE_MAX,
  PARKED_PAYLOAD_RESUME_KEY,
  hasReservedParkKey,
  sanitizeParkedPayload,
  validCustomer,
  validLine,
} from "./counter-park";

const METHODS = ["CASH", "CARD", "CHECK", "ON_ACCOUNT"] as const;
const line = (over: Record<string, unknown> = {}) => ({
  tempId: "t1",
  productId: "p1",
  name: "Sample Cola",
  unitPrice: 2.5,
  qty: 2,
  ...over,
});
const cart = (over: Record<string, unknown> = {}) => ({
  lines: [line()],
  customer: null,
  method: "CASH",
  tendered: "5.00",
  reference: "",
  ...over,
});
const ok = (raw: unknown) => {
  const r = sanitizeParkedPayload(raw, METHODS);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.value;
};
const refusal = (raw: unknown) => {
  const r = sanitizeParkedPayload(raw, METHODS);
  if (r.ok) throw new Error("expected a refusal");
  return r.reason;
};

describe("the server-reserved _resume key", () => {
  it("is named once, and a client payload naming it is detected whatever its value", () => {
    expect(PARKED_PAYLOAD_RESUME_KEY).toBe("_resume");
    for (const v of [{ attemptId: "x" }, null, undefined, 0, ""]) {
      expect(hasReservedParkKey({ ...cart(), _resume: v })).toBe(true);
    }
    expect(hasReservedParkKey(cart())).toBe(false);
    expect(hasReservedParkKey(null)).toBe(false);
    expect(hasReservedParkKey("_resume")).toBe(false);
  });
  it("the whitelist rebuild never copies it, so a stored payload leaves the server without it", () => {
    const stored = cart({ _resume: { attemptId: "a1" } });
    expect(ok(stored)).toEqual(cart());
    expect(JSON.stringify(ok(stored))).not.toContain("_resume");
  });
});

describe("sanitizeParkedPayload", () => {
  it("keeps a line's regulated category and the customer's tax exemption, so a resumed cart's estimate is the receipt's (CQ-01 / CQ-02)", () => {
    const v = ok(
      cart({
        lines: [line({ trackedCategoryId: "cat-1" })],
        customer: { id: "c1", businessName: "Acme", isTaxExempt: true, email: "x@y.test" },
      }),
    );
    expect(v.lines[0].trackedCategoryId).toBe("cat-1");
    expect(v.customer).toEqual({ id: "c1", businessName: "Acme", isTaxExempt: true });
  });

  it("a non-boolean exemption or a non-string category is dropped, not stored", () => {
    const v = ok(
      cart({
        lines: [line({ trackedCategoryId: 5 })],
        customer: { id: "c1", businessName: "Acme", isTaxExempt: "yes" },
      }),
    );
    expect(v.lines[0]).not.toHaveProperty("trackedCategoryId");
    expect(v.customer).toEqual({ id: "c1", businessName: "Acme" });
  });

  it("keeps the cart snapshot fields", () => {
    expect(ok(cart())).toEqual(cart());
  });

  it("DROPS every unknown key, at the payload, line, customer, override and tier level", () => {
    const dirty = cart({
      evil: 1,
      lines: [
        line({
          isAdmin: true,
          __proto__: { polluted: true },
          tierPrices: { priceTier2: 2, secret: "x" },
          override: { mode: "set", value: 3, reason: "r", extra: 1 },
        }),
      ],
      customer: {
        id: "c1",
        businessName: "Acme",
        email: "a@b.co",
        pricingTier: 2,
        fulfillPath: "PICKUP",
        phone: "1",
      },
    });
    const out = ok(dirty);
    expect(out).not.toHaveProperty("evil");
    expect(out.lines[0]).not.toHaveProperty("isAdmin");
    expect(out.lines[0].tierPrices).toEqual({ priceTier2: 2 });
    expect(out.lines[0].override).toEqual({ mode: "set", value: 3, reason: "r" });
    expect(out.customer).toEqual({
      id: "c1",
      businessName: "Acme",
      pricingTier: 2,
      fulfillPath: "PICKUP",
    });
    expect(JSON.stringify(out)).not.toMatch(/a@b\.co|polluted|secret|phone/);
  });

  it("never stores an email, whatever the customer carries", () => {
    const out = ok(
      cart({
        customer: { id: "c1", businessName: "Acme", email: "x@y.zz", contactEmail: "q@r.ss" },
      }),
    );
    expect(JSON.stringify(out.customer)).not.toContain("@");
  });

  it("caps strings: name, note, label-like fields, tender and reference", () => {
    const out = ok(
      cart({
        lines: [
          line({
            name: "n".repeat(500),
            note: "x".repeat(900),
            unit: "u".repeat(100),
            category: "c".repeat(400),
          }),
        ],
        tendered: "9".repeat(60),
        reference: "r".repeat(400),
      }),
    );
    expect(out.lines[0].name).toHaveLength(COUNTER_PARK_NAME_MAX);
    expect(out.lines[0].note).toHaveLength(COUNTER_PARK_NOTE_MAX);
    expect(out.lines[0].unit).toHaveLength(40);
    expect(out.lines[0].category).toHaveLength(100);
    expect(out.tendered).toHaveLength(20);
    expect(out.reference).toHaveLength(100);
  });

  it("never keeps a lone UTF-16 surrogate: Postgres jsonb rejects it (a 500 otherwise)", () => {
    const lone = "\uD83D"; // a high surrogate with no low one
    const out = ok(
      cart({
        lines: [line({ name: `Cola${lone}`, note: `a${"\uDE00"}b` })],
        reference: `ref${lone}`,
        customer: { id: "c1", businessName: `Acme${lone}` },
      }),
    );
    expect(out.lines[0].name).toBe("Cola");
    expect(out.lines[0].note).toBe("ab");
    expect(out.reference).toBe("ref");
    expect(out.customer?.businessName).toBe("Acme");
    // JSON of the rebuilt payload carries no unpaired escape
    expect(JSON.stringify(out)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
  });

  it("a slice that would cut an emoji in half drops the half, not keeps it", () => {
    const emoji = "\u{1F600}"; // two code units
    const name = "x".repeat(COUNTER_PARK_NAME_MAX - 1) + emoji; // the cut lands between the two halves
    const out = ok(cart({ lines: [line({ name })] }));
    expect(out.lines[0].name).toBe("x".repeat(COUNTER_PARK_NAME_MAX - 1));
    // a whole emoji that fits is kept intact
    expect(ok(cart({ lines: [line({ name: `hi ${emoji}` })] })).lines[0].name).toBe(`hi ${emoji}`);
  });

  it("refuses more than the line cap with its own reason, and exactly the cap passes", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => line({ tempId: `t${i}`, productId: `p${i}` }));
    expect(refusal(cart({ lines: many(COUNTER_PARK_MAX_LINES + 1) }))).toBe("TOO_MANY_LINES");
    expect(ok(cart({ lines: many(COUNTER_PARK_MAX_LINES) })).lines).toHaveLength(
      COUNTER_PARK_MAX_LINES,
    );
  });

  it("refuses bad shapes, each as INVALID", () => {
    for (const raw of [
      null,
      "x",
      [],
      {},
      cart({ lines: "x" }),
      cart({ lines: [null] }),
      cart({ lines: [line({ productId: "" })] }),
      cart({ lines: [line({ qty: NaN })] }),
      cart({ lines: [line({ unitPrice: Infinity })] }),
      cart({ lines: [line({ tempId: undefined })] }),
      cart({ lines: [line({ name: undefined })] }),
      cart({ lines: [line({ boxes: "2" })] }),
      cart({ customer: "c1" }),
      cart({ customer: { id: "c1" } }),
      cart({ method: "BITCOIN" }),
      cart({ method: undefined }),
    ]) {
      expect(refusal(raw)).toBe("INVALID");
    }
  });

  it("keeps a customer of null or absent as null", () => {
    expect(ok(cart({ customer: null })).customer).toBeNull();
    const { customer: _c, ...noCustomer } = cart();
    expect(ok(noCustomer).customer).toBeNull();
  });

  it("drops a malformed override instead of keeping it", () => {
    const out = ok(
      cart({
        lines: [
          line({ override: { mode: "bogus", value: 1 } }),
          line({ tempId: "t2", override: { mode: "percent", value: "x" } }),
        ],
      }),
    );
    expect(out.lines[0]).not.toHaveProperty("override");
    expect(out.lines[1]).not.toHaveProperty("override");
  });

  it("is pure: the input object is not changed", () => {
    const raw = cart({ evil: 1 });
    const before = JSON.stringify(raw);
    ok(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe("validLine / validCustomer (moved from the web, behaviour unchanged)", () => {
  it("a line needs a product id and finite qty and unitPrice; boxes/pieces/unitsPerBox optional numbers", () => {
    expect(validLine(line())).toBe(true);
    expect(
      validLine({ productId: "p", qty: 1, unitPrice: 1, boxes: 1, pieces: 2, unitsPerBox: 12 }),
    ).toBe(true);
    expect(validLine({ productId: "", qty: 1, unitPrice: 1 })).toBe(false);
    expect(validLine({ productId: "p", qty: "1", unitPrice: 1 })).toBe(false);
    expect(validLine({ productId: "p", qty: 1, unitPrice: 1, boxes: "2" })).toBe(false);
    expect(validLine(null)).toBe(false);
  });
  it("a customer is absent, or has an id and a business name", () => {
    expect(validCustomer(null)).toBe(true);
    expect(validCustomer(undefined)).toBe(true);
    expect(validCustomer({ id: "c", businessName: "A" })).toBe(true);
    expect(validCustomer({ id: "c" })).toBe(false);
    expect(validCustomer("c")).toBe(false);
  });
});
