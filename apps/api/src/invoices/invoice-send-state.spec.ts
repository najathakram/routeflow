jest.mock("./pending-mirror", () => ({ resolvePendingMirror: jest.fn() }));

import { BadRequestException, HttpException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { resolvePendingMirror } from "./pending-mirror";
import {
  FINGERPRINT_VERSION,
  TRACKING_SINCE,
  assertOrderInvoiceUnlockedFor,
  sendFieldsFor,
  SEND_THROTTLE_MAX,
  acquireSendSlot,
  decideSendState,
  guardedEmail,
  invoiceFingerprint,
  invoiceFingerprintOf,
  recordInvoiceEmailed,
  sendLockedByOrder,
  type FingerprintSource,
} from "./invoice-send-state";

/**
 * #2088 - the send state, as pure decisions: the fingerprint is exactly what renders on the customer's PDF /
 * email (a PDF-visible field flips it, an internal-only field does not), it is versioned, the state matrix is
 * never / unchanged / changedSinceSent / sentBeforeTracking, and the per-invoice throttle is a coded 429.
 */
const base = (): FingerprintSource => ({
  invoiceNumber: "INV-1001",
  issueDate: new Date("2026-10-01T12:00:00Z"),
  dueDate: new Date("2026-10-31T12:00:00Z"),
  paymentTermsLabel: "Net 30",
  variant: "final",
  notes: "Thanks!",
  terms: "Pay within 30 days",
  subtotal: "100.00",
  taxAmount: "8.25",
  discount: "0",
  shippingFee: "5",
  total: "113.25",
  customer: {
    businessName: "Acme",
    contactName: "Pat",
    phone: "555-0100",
    addresses: [{ line1: "1 Main St", line2: null, city: "Austin", state: "TX", zip: "78701" }],
  },
  items: [
    {
      description: "Widget",
      qty: "2",
      unitPrice: "50.00",
      discount: "0",
      priceType: "STANDARD",
      taxRate: "0.0825",
      subtotal: "100.00",
      categoryTaxAmount: "0",
      unitLabel: null,
    },
  ],
  payments: [],
});
const fp = (mut?: (s: FingerprintSource) => void) => {
  const s = base();
  mut?.(s);
  return invoiceFingerprint(s);
};

describe("invoiceFingerprint", () => {
  it("is versioned and stable: Decimal vs number vs string, key order and whitespace do not matter", () => {
    const a = invoiceFingerprint(base());
    expect(a).toMatch(new RegExp(`^${FINGERPRINT_VERSION}:[0-9a-f]{64}$`));
    const b = base();
    b.subtotal = 100;
    b.items![0].qty = 2;
    b.items![0].unitPrice = { toString: () => "50" };
    b.notes = "  Thanks!  ";
    expect(invoiceFingerprint(b)).toBe(a);
  });

  it.each<[string, (s: FingerprintSource) => void]>([
    ["a line quantity", (s) => (s.items![0].qty = 3)],
    ["a line price", (s) => (s.items![0].unitPrice = "51.00")],
    ["a line description", (s) => (s.items![0].description = "Widget XL")],
    ["a line note", (s) => (s.items![0].notes = "gift wrap")],
    ["a line unit label", (s) => (s.items![0].unitLabel = "Case")],
    ["a line levy (category tax)", (s) => (s.items![0].categoryTaxAmount = "1.00")],
    [
      "an added line",
      (s) => s.items!.push({ description: "Extra", qty: 1, unitPrice: 1, subtotal: 1 }),
    ],
    ["the total", (s) => (s.total = "114.25")],
    ["the discount", (s) => (s.discount = "2")],
    ["the shipping fee", (s) => (s.shippingFee = "6")],
    ["the invoice number", (s) => (s.invoiceNumber = "INV-1002")],
    ["the issue date", (s) => (s.issueDate = new Date("2026-10-02T12:00:00Z"))],
    ["the due date", (s) => (s.dueDate = new Date("2026-11-01T12:00:00Z"))],
    [
      "the DRAFT / FINAL stage (a final after a proforma is a different document)",
      (s) => (s.variant = "draft"),
    ],
    ["the bill-to phone", (s) => (s.customer!.phone = "555-0199")],
    [
      "a payment row listed on the PDF (even an unconfirmed one)",
      (s) => (s.payments = [{ amount: "5", method: "CASH", status: "DRAFT" }]),
    ],
    [
      "the printed item code (barcode / SKU)",
      (s) => (s.items![0].product = { barcode: "0123456789012" }),
    ],
    ["the customer notes", (s) => (s.notes = "Thanks a lot!")],
    ["the terms text", (s) => (s.terms = "Pay within 15 days")],
    ["the bill-to name", (s) => (s.customer!.businessName = "Acme Inc")],
    ["the bill-to address", (s) => (s.customer!.addresses![0].zip = "78702")],
    [
      "a confirmed payment (the Amount Paid / Balance Due the email shows)",
      (s) => (s.payments = [{ amount: "20", method: "CASH", status: "PAID" }]),
    ],
  ])("%s flips the fingerprint (it renders on the PDF / email)", (_name, mut) => {
    expect(fp(mut)).not.toBe(fp());
  });

  it("ignores internal-only fields: internal notes, override reasons, cost, margin, updatedAt", () => {
    const withInternal = base() as FingerprintSource & Record<string, unknown>;
    withInternal.referenceNumber = "PO-77"; // renders on neither the PDF nor the email
    withInternal.subject = "October order";
    withInternal.internalNotes = "customer is difficult";
    withInternal.updatedAt = new Date();
    (withInternal.items![0] as Record<string, unknown>).overrideReason = "manager ok";
    (withInternal.items![0] as Record<string, unknown>).averageCost = 12;
    (withInternal.items![0] as Record<string, unknown>).updatedAt = new Date();
    expect(invoiceFingerprint(withInternal)).toBe(fp());
  });
});

describe("decideSendState", () => {
  const cur = fp();
  const row = (fingerprint: string | null, to: string | null = "ap@acme.test") => ({
    createdAt: new Date("2026-10-02T15:00:00Z"),
    meta: { fp: fingerprint, to },
  });

  it("never: no row and no legacy sentAt", () => {
    expect(decideSendState(null, cur, null)).toEqual({
      state: "never",
      lastSentAt: null,
      lastSentTo: null,
    });
  });

  it("unchanged: the newest row carries the same fingerprint; the date and recipient come from the row", () => {
    expect(decideSendState(row(cur), cur, new Date("2026-10-02T15:00:00Z"))).toEqual({
      state: "unchanged",
      lastSentAt: "2026-10-02T15:00:00.000Z",
      lastSentTo: "ap@acme.test",
    });
  });

  it("changedSinceSent: the same version, a different fingerprint", () => {
    const changed = fp((s) => (s.items![0].qty = 5));
    expect(decideSendState(row(cur), changed, null).state).toBe("changedSinceSent");
  });

  it("a different or missing fingerprint VERSION reads as sentBeforeTracking, never as changed", () => {
    expect(decideSendState(row("v0:abc"), cur, null).state).toBe("sentBeforeTracking");
    expect(decideSendState(row(null), cur, null).state).toBe("sentBeforeTracking");
    expect(decideSendState(row("v2:" + "a".repeat(64)), cur, null).state).toBe(
      "sentBeforeTracking",
    );
  });

  it("sentBeforeTracking: a sentAt BEFORE the tracking cutover with no tracked row (may have been emailed)", () => {
    expect(decideSendState(null, null, new Date("2026-09-01T10:00:00Z"))).toEqual({
      state: "sentBeforeTracking",
      lastSentAt: "2026-09-01T10:00:00.000Z",
      lastSentTo: null,
    });
    expect(decideSendState(null, null, new Date(TRACKING_SINCE.getTime() - 1)).state).toBe(
      "sentBeforeTracking",
    );
  });

  it("markedSentNotEmailed: a sentAt ON/AFTER the cutover with no row (Mark as Sent, counter sale, pickup hand-over)", () => {
    expect(decideSendState(null, null, TRACKING_SINCE)).toEqual({
      state: "markedSentNotEmailed",
      lastSentAt: TRACKING_SINCE.toISOString(),
      lastSentTo: null,
    });
    expect(decideSendState(null, null, new Date("2027-01-05T10:00:00Z")).state).toBe(
      "markedSentNotEmailed",
    );
  });

  it("a tracked row always wins over the cutover: a post-cutover send WITH a row is unchanged / changed", () => {
    const after = {
      createdAt: new Date("2027-01-05T10:00:00Z"),
      meta: { fp: cur, to: "x@y.test" },
    };
    expect(decideSendState(after, cur, new Date("2027-01-05T10:00:00Z")).state).toBe("unchanged");
  });
});

describe("recordInvoiceEmailed", () => {
  const prismaWith = (create: jest.Mock) =>
    ({ getTenantId: () => "t-1", forTenant: () => ({ auditLog: { create } }) }) as never;

  it("writes one invoice.emailed row with the tenant, sender, recipient and fingerprint", async () => {
    const create = jest.fn().mockResolvedValue({});
    await recordInvoiceEmailed(prismaWith(create), {
      id: "inv-1",
      actorId: "u-1",
      to: "ap@acme.test",
      fingerprint: "v1:abc",
      variant: "final",
    });
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      tenantId: "t-1",
      userId: "u-1",
      action: AUDIT_ACTIONS.INVOICE_EMAILED,
      entityType: "invoice",
      entityId: "inv-1",
    });
    expect(data.meta).toMatchObject({ to: "ap@acme.test", fp: "v1:abc", variant: "final" });
  });

  it("a failed audit write is logged and NEVER thrown (the email already went)", async () => {
    const create = jest.fn().mockRejectedValue(new Error("db down"));
    await expect(
      recordInvoiceEmailed(prismaWith(create), {
        id: "inv-1",
        actorId: null,
        to: "x@y.test",
        fingerprint: null,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("the per-invoice throttle", () => {
  const dbWith = (count: number) => ({ auditLog: { count: jest.fn().mockResolvedValue(count) } });

  it(`allows up to ${SEND_THROTTLE_MAX - 1} recent emails and refuses the ${SEND_THROTTLE_MAX}th with a coded 429`, async () => {
    const release = await acquireSendSlot(dbWith(SEND_THROTTLE_MAX - 1), "t-1", "inv-a");
    release();
    const err = await acquireSendSlot(dbWith(SEND_THROTTLE_MAX), "t-1", "inv-b").catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(429);
    expect(err.getResponse()).toMatchObject({ code: "EMAIL_SEND_THROTTLED" });
  });

  it("counts only the window, only this invoice and this tenant", async () => {
    const db = dbWith(0);
    const now = new Date("2026-10-14T12:00:00Z");
    (await acquireSendSlot(db, "t-1", "inv-c", now))();
    const where = db.auditLog.count.mock.calls[0][0].where;
    expect(where).toMatchObject({
      tenantId: "t-1",
      entityType: "invoice",
      entityId: "inv-c",
      action: AUDIT_ACTIONS.INVOICE_EMAILED,
    });
    expect(where.createdAt.gte.toISOString()).toBe("2026-10-14T11:45:00.000Z");
  });

  it("a second send for the same invoice while one is in flight is a 429; the slot frees afterwards", async () => {
    const prisma = { getTenantId: () => "t-1", forTenant: () => dbWith(0) } as never;
    let finish!: () => void;
    const first = guardedEmail(
      prisma,
      "inv-d",
      () => new Promise<string>((r) => (finish = () => r("sent"))),
    );
    await new Promise((r) => setImmediate(r));
    await expect(guardedEmail(prisma, "inv-d", async () => "x")).rejects.toMatchObject({
      status: 429,
    });
    finish();
    await expect(first).resolves.toBe("sent");
    await expect(guardedEmail(prisma, "inv-d", async () => "again")).resolves.toBe("again");
  });

  it("the slot is freed when the delivery throws", async () => {
    const prisma = { getTenantId: () => "t-1", forTenant: () => dbWith(0) } as never;
    await expect(
      guardedEmail(prisma, "inv-e", async () => Promise.reject(new Error("smtp"))),
    ).rejects.toThrow("smtp");
    await expect(guardedEmail(prisma, "inv-e", async () => "ok")).resolves.toBe("ok");
  });
});

describe("sendLockedByOrder - the ONE pre-delivery predicate", () => {
  const featureConfig = { getEffectiveMode: jest.fn().mockResolvedValue("on") };
  const deps = { featureConfig, tenantId: "t-1" };
  const order = { status: "PENDING", fulfillPath: "ROUTE" };

  it("only an order-linked DRAFT with no delivery batch can be locked", async () => {
    const draft = { orderId: "o-1", status: InvoiceStatus.DRAFT, deliveryBatchId: null };
    await expect(sendLockedByOrder(deps, { ...draft, orderId: null }, order)).resolves.toBe(false);
    await expect(
      sendLockedByOrder(deps, { ...draft, status: InvoiceStatus.SENT }, order),
    ).resolves.toBe(false);
    await expect(
      sendLockedByOrder(deps, { ...draft, deliveryBatchId: "b-1" }, order),
    ).resolves.toBe(false);
    await expect(sendLockedByOrder(deps, draft, null)).resolves.toBe(false);
  });
});

describe("the refusal and the read share ONE predicate (sendLocked == what the server refuses)", () => {
  const draft = {
    id: "inv-1",
    sentAt: null,
    orderId: "o-1",
    status: InvoiceStatus.DRAFT,
    deliveryBatchId: null,
  };
  const prismaWith = (order: unknown) =>
    ({
      getTenantId: () => "t-1",
      forTenant: () => ({
        order: { findFirst: jest.fn().mockResolvedValue(order) },
        auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
      }),
    }) as never;
  const order = { status: "PENDING", orderNumber: "ORD-9", fulfillPath: "ROUTE" };

  it.each([true, false])(
    "pending mirror = %s: the guard throws iff the read reports sendLocked",
    async (mirror) => {
      (resolvePendingMirror as jest.Mock).mockResolvedValue(mirror);
      const refused = await assertOrderInvoiceUnlockedFor(prismaWith(order), {}, draft).then(
        () => false,
        (e) => e instanceof BadRequestException,
      );
      const fields = await sendFieldsFor(prismaWith(order), {}, draft, order);
      expect(refused).toBe(mirror);
      expect(fields.sendLocked).toEqual(mirror ? { reason: "SENDS_AFTER_DELIVERY" } : null);
      expect(fields.sendState.state).toBe("never");
    },
  );

  it("allowPreDelivery (the deposit-at-order issuance) bypasses only the refusal", async () => {
    (resolvePendingMirror as jest.Mock).mockResolvedValue(true);
    await expect(
      assertOrderInvoiceUnlockedFor(prismaWith(order), {}, draft, { allowPreDelivery: true }),
    ).resolves.toBeUndefined();
  });
});

describe("the bill-to address is ONE ordering for the PDF and the fingerprint", () => {
  it("both read the customer's addresses with BILL_TO_ADDRESS_ORDER (default, oldest, id) and take the first", () => {
    const { BILL_TO_ADDRESS_ORDER } = jest.requireActual("./invoice-bill-to");
    expect(BILL_TO_ADDRESS_ORDER).toEqual([
      { isDefault: "desc" },
      { createdAt: "asc" },
      { id: "asc" },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { FINGERPRINT_INCLUDE } = require("./invoice-send-state");
    expect(FINGERPRINT_INCLUDE.customer.select.addresses).toEqual({
      orderBy: BILL_TO_ADDRESS_ORDER,
      take: 1,
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdf = require("fs").readFileSync(
      require("path").join(__dirname, "invoice-pdf.service.ts"),
      "utf8",
    );
    expect(pdf).toContain("addresses: { orderBy: BILL_TO_ADDRESS_ORDER }");
  });
});

describe("invoiceFingerprintOf - the stage is part of the fingerprint", () => {
  const inv = { id: "inv-1", ...base(), order: null };
  const prisma = (found: unknown) =>
    ({
      getTenantId: () => "t-1",
      forTenant: () => ({ invoice: { findUnique: jest.fn().mockResolvedValue(found) } }),
    }) as never;

  it("an explicit stage is used as given; no stage resolves the plain-send default like the PDF", async () => {
    const draft = await invoiceFingerprintOf(prisma(inv), {}, "inv-1", "draft");
    const final = await invoiceFingerprintOf(prisma(inv), {}, "inv-1", "final");
    expect(draft).not.toBe(final);
    // a SENT invoice sends FINAL by default (deriveInvoiceVariant), so the default equals the explicit final
    expect(await invoiceFingerprintOf(prisma({ ...inv, status: "SENT" }), {}, "inv-1")).toBe(final);
    expect(await invoiceFingerprintOf(prisma(null), {}, "inv-1")).toBeNull();
  });
});
