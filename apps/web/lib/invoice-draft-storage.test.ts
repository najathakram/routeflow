import {
  INVOICE_DRAFT_MAX_AGE_MS,
  INVOICE_DRAFT_VERSION,
  clearInvoiceDraft,
  invoiceDraftKey,
  isPristineSnapshot,
  readInvoiceDraft,
  sanitizeSnapshot,
  writeInvoiceDraft,
} from "./invoice-draft-storage";

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const KEY = invoiceDraftKey("acme", "user-1")!;

function form(over: Record<string, unknown> = {}) {
  return {
    basis: "standalone",
    customer: { id: "cust-1", businessName: "Acme Co", pricingTier: 2 },
    reference: "PO-1",
    subject: "",
    terms: "Net 30",
    issueDate: "2026-10-13",
    dueDate: "2026-11-12",
    dueDateEdited: false,
    termsText: "Pay on time",
    notes: "Thanks",
    deliveredNow: true,
    deliveredOn: "2026-10-13",
    depositOpen: false,
    depositPercent: null,
    depositDueDate: "",
    adjustment: -5,
    lines: [
      {
        productId: "p-1",
        description: "Widget",
        qty: 3,
        unitPrice: 10,
        discount: 0,
        taxable: true,
      },
    ],
    ...over,
  };
}

describe("invoiceDraftKey", () => {
  it("scopes per tenant and per user", () => {
    expect(invoiceDraftKey("acme", "u1")).not.toBe(invoiceDraftKey("acme", "u2"));
    expect(invoiceDraftKey("acme", "u1")).not.toBe(invoiceDraftKey("globex", "u1"));
    expect(invoiceDraftKey("acme", "u1")).toBe(invoiceDraftKey("acme", "u1"));
  });
  it("is null when the tenant or the user is missing", () => {
    expect(invoiceDraftKey(null, "u1")).toBeNull();
    expect(invoiceDraftKey("acme", undefined)).toBeNull();
    expect(invoiceDraftKey("  ", "u1")).toBeNull();
  });
  it("cannot be spoofed by a colon in a part", () => {
    expect(invoiceDraftKey("a:b", "c")).not.toBe(invoiceDraftKey("a", "b:c"));
  });
});

describe("invoice draft storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips a snapshot", () => {
    expect(writeInvoiceDraft(KEY, form(), NOW)).toBe(true);
    const got = readInvoiceDraft(KEY, NOW + 60_000);
    expect(got?.savedAt).toBe(NOW);
    expect(got?.snapshot.customer?.id).toBe("cust-1");
    expect(got?.snapshot.lines[0]).toMatchObject({ productId: "p-1", qty: 3, unitPrice: 10 });
    expect(got?.snapshot.adjustment).toBe(-5);
  });

  it("never stores a total, subtotal or tax, even when the form or a line carries one", () => {
    const f = form({
      total: 999,
      subtotal: 888,
      tax: 77,
      grandTotal: 1,
      lines: [
        {
          productId: "p-1",
          description: "Widget",
          qty: 3,
          unitPrice: 10,
          discount: 0,
          taxable: true,
          lineTotal: 30,
          total: 31,
          subtotal: 32,
          tax: 33,
        },
      ],
    });
    expect(writeInvoiceDraft(KEY, f, NOW)).toBe(true);
    const json = window.localStorage.getItem(KEY)!;
    expect(json).not.toMatch(/total|subtotal|grand/i);
    expect(json).not.toMatch(/"tax"/);
    expect(json).not.toMatch(/999|888/);
    // The tax-exempt flag is an input and stays.
    expect(json).toContain('"taxable":true');
  });

  it("does not write a pristine form", () => {
    const pristine = form({
      customer: null,
      reference: "",
      adjustment: 0,
      lines: [{ description: "", qty: 1, unitPrice: 0, discount: 0, taxable: false }],
    });
    expect(writeInvoiceDraft(KEY, pristine, NOW)).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(isPristineSnapshot(sanitizeSnapshot(pristine)!)).toBe(true);
  });

  it("does not write without a key", () => {
    expect(writeInvoiceDraft(null, form(), NOW)).toBe(false);
    expect(window.localStorage.length).toBe(0);
  });

  it("ignores and clears a draft older than the age cap", () => {
    writeInvoiceDraft(KEY, form(), NOW);
    expect(readInvoiceDraft(KEY, NOW + INVOICE_DRAFT_MAX_AGE_MS - 1000)).not.toBeNull();
    expect(readInvoiceDraft(KEY, NOW + INVOICE_DRAFT_MAX_AGE_MS + 1000)).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it.each([
    ["wrong version", JSON.stringify({ v: INVOICE_DRAFT_VERSION + 1, savedAt: NOW, data: form() })],
    ["not JSON", "{oops"],
    ["not an object", "42"],
    ["bad basis", JSON.stringify({ v: 1, savedAt: NOW, data: form({ basis: "existing" }) })],
    ["lines not an array", JSON.stringify({ v: 1, savedAt: NOW, data: form({ lines: "x" }) })],
    [
      "a line with a string qty",
      JSON.stringify({ v: 1, savedAt: NOW, data: form({ lines: [{ qty: "3", unitPrice: 1 }] }) }),
    ],
    ["missing savedAt", JSON.stringify({ v: 1, data: form() })],
  ])("ignores and clears %s", (_n, raw) => {
    window.localStorage.setItem(KEY, raw);
    expect(readInvoiceDraft(KEY, NOW)).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("clearInvoiceDraft removes the entry", () => {
    writeInvoiceDraft(KEY, form(), NOW);
    clearInvoiceDraft(KEY);
    expect(readInvoiceDraft(KEY, NOW)).toBeNull();
  });

  it("a different user or tenant key does not see the draft", () => {
    writeInvoiceDraft(KEY, form(), NOW);
    expect(readInvoiceDraft(invoiceDraftKey("acme", "user-2"), NOW)).toBeNull();
    expect(readInvoiceDraft(invoiceDraftKey("globex", "user-1"), NOW)).toBeNull();
    expect(readInvoiceDraft(KEY, NOW)).not.toBeNull();
  });

  it("drops a draft that is too large instead of writing it", () => {
    const big = Array.from({ length: 200 }, () => ({
      description: "x".repeat(500),
      qty: 1,
      unitPrice: 1,
      discount: 0,
      taxable: false,
      overrideReason: "y".repeat(500),
      unit: "z".repeat(80),
    }));
    expect(writeInvoiceDraft(KEY, form({ lines: big }), NOW)).toBe(false);
  });

  describe("storage that is broken never throws", () => {
    afterEach(() => jest.restoreAllMocks());

    it("setItem throwing (quota)", () => {
      jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
      expect(() => writeInvoiceDraft(KEY, form(), NOW)).not.toThrow();
      expect(writeInvoiceDraft(KEY, form(), NOW)).toBe(false);
    });
    it("getItem throwing", () => {
      jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      expect(() => readInvoiceDraft(KEY, NOW)).not.toThrow();
      expect(readInvoiceDraft(KEY, NOW)).toBeNull();
    });
    it("removeItem throwing", () => {
      jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      expect(() => clearInvoiceDraft(KEY)).not.toThrow();
    });
    it("window.localStorage itself throwing on access", () => {
      jest.spyOn(window, "localStorage", "get").mockImplementation(() => {
        throw new Error("SecurityError");
      });
      expect(() => writeInvoiceDraft(KEY, form(), NOW)).not.toThrow();
      expect(() => readInvoiceDraft(KEY, NOW)).not.toThrow();
      expect(() => clearInvoiceDraft(KEY)).not.toThrow();
      expect(readInvoiceDraft(KEY, NOW)).toBeNull();
    });
  });
});
