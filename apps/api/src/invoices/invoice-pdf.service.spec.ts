/**
 * Unit tests for InvoicePdfService and the PDF's per-line promo helpers — F03
 * ("payment-status truth and invoice documents"), covering T-B97 (R1: the PDF's
 * payment query must be CONFIRMED-basis) and T-B103 (R9: promo/original-price
 * display). Uses the standard createMockPrisma() helper so no real DB is needed.
 *
 * `@react-pdf/renderer` and `./invoice-pdf-template` are globally stubbed in
 * apps/api/package.json's jest.moduleNameMapper (the real react-pdf/ESM pipeline never
 * runs under Jest). This file's own `jest.mock("@react-pdf/renderer", ...)` below takes
 * precedence over that global stub for renderToBuffer, and additionally RECORDS the
 * `invoice` prop of the React element InvoicePdfService hands it.
 *
 * WHAT THAT CAPTURE CAN AND CANNOT PROVE — the service builds the template's props as
 * `{ ...inv, items, tenant, variant, generatedAt, depositAmount }` (invoice-pdf.service.ts
 * :172-179), so any field this file puts INTO the `findUnique` fixture comes back out of
 * the capture unchanged. Asserting such a field back is asserting the fixture against
 * itself and can never fail. Only two things about the payload are genuinely the
 * service's own work and are therefore what this file asserts on:
 *   1. WHICH payment rows the query returns — the mock reproduces the DB by honouring
 *      the `include.payments.where` the service actually passes (T-B97), and
 *   2. fields the service must ADD that no fixture supplies (the tenant's
 *      hide-original-price setting, T-B103).
 * The renderer half of R9 (the "N free" note and the struck original price) is
 * unreachable through this service — the template module is replaced by
 * apps/api/test/__mocks__/invoice-pdf-template.js — so it is proven directly against
 * the pure helpers in ./invoice-pdf-item at the bottom of this file.
 */

let mockCapturedInvoice: any = null;

jest.mock("@react-pdf/renderer", () => ({
  renderToBuffer: jest.fn(async (element: any) => {
    mockCapturedInvoice = element?.props?.invoice ?? null;
    return Buffer.from("");
  }),
}));

import { readFileSync } from "fs";
import { join } from "path";
import { Test, TestingModule } from "@nestjs/testing";
import { InvoicePdfService } from "./invoice-pdf.service";
import { promoNote, qtyCellText, showOriginalPrice } from "./invoice-pdf-item";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

function makeStorage() {
  return {
    upload: jest.fn().mockResolvedValue(undefined),
    download: jest.fn().mockResolvedValue(Buffer.from("")),
    presignedUrl: jest.fn().mockResolvedValue("https://cdn.example.com/invoice-pdfs/inv-1.pdf"),
  } as any;
}

/**
 * SystemConfig is how this repo stores the tenant's invoice display settings
 * (`invoices.service.ts:2963` reads `systemConfig.get("invoice.hideOriginalPrice")`).
 * InvoicePdfService has never needed it, so the service is built through Nest here
 * rather than with `new`: whichever dependency shape the fix picks — injecting
 * SystemConfigService (the house convention) or reading `prisma.systemConfig` — Nest
 * hands it only the constructor params it declares, so this build keeps working
 * instead of passing `undefined` into a newly added third parameter.
 */
async function makeService(prisma: any, storage: any, hideOriginalPrice: string | null) {
  const systemConfig = {
    get: jest.fn(async (key: string) =>
      key === "invoice.hideOriginalPrice" ? hideOriginalPrice : null,
    ),
    set: jest.fn().mockResolvedValue(undefined),
  };
  (prisma.systemConfig.findFirst as jest.Mock).mockResolvedValue(
    hideOriginalPrice == null
      ? null
      : { key: "invoice.hideOriginalPrice", value: hideOriginalPrice },
  );
  (prisma.systemConfig.findMany as jest.Mock).mockResolvedValue(
    hideOriginalPrice == null
      ? []
      : [{ key: "invoice.hideOriginalPrice", value: hideOriginalPrice }],
  );

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      InvoicePdfService,
      { provide: PrismaService, useValue: prisma },
      { provide: StorageService, useValue: storage },
      { provide: SystemConfigService, useValue: systemConfig },
    ],
  }).compile();

  return module.get<InvoicePdfService>(InvoicePdfService);
}

const TENANT_CONFIG = {
  businessName: "Acme Distributors",
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  zip: null,
  country: null,
  phone: null,
  website: null,
  customerEmail: null,
  primaryColor: null,
  logoKey: null,
};

/**
 * BOGO/promo fixture per the T-B103 row: qty 6, 1 free unit, $10/unit, $12
 * original (pre-promo) per-unit price, $50 stored subtotal — 10*(6-1), never
 * the naive 10*6 = 60 a re-derive-from-qty bug would produce.
 */
function baseInvoiceFixture(overrides: Record<string, any> = {}) {
  return {
    id: "inv-1",
    tenantId: "tenant-1",
    invoiceNumber: "INV-3001",
    status: "PARTIAL",
    issueDate: new Date("2026-01-01T00:00:00.000Z"),
    dueDate: new Date("2026-01-31T00:00:00.000Z"),
    subtotal: 50,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 50,
    depositPercent: null,
    depositDueDate: null,
    notes: null,
    terms: null,
    shippingCarrier: null,
    shippingTrackingNumber: null,
    customer: {
      id: "cust-1",
      businessName: "Acme Buyer",
      contactName: null,
      phone: null,
      addresses: [],
    },
    items: [
      {
        id: "item-1",
        description: "Widget (BOGO)",
        qty: 6,
        unitPrice: 10,
        discount: 0,
        taxRate: 0,
        subtotal: 50,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        originalPrice: 12,
        priceType: "PROMO",
        promoFreeUnits: 1,
        notes: null,
        // barcode/sku/unitSku all null so invoiceItemCode() returns null and the
        // bwip-js barcode branch (untested, unrelated here) never runs.
        product: { id: "p1", name: "Widget", barcode: null, sku: null, unitSku: null },
      },
    ],
    payments: [],
    order: null,
    ...overrides,
  };
}

/** Does a payment row's status satisfy the Prisma `where.status` condition given? */
const matchesStatus = (value: string, cond: any): boolean => {
  if (cond === undefined) return true;
  if (typeof cond === "string") return value === cond;
  if (cond.equals !== undefined) return value === cond.equals;
  if (cond.not !== undefined) return value !== cond.not;
  if (cond.in !== undefined) return (cond.in as string[]).includes(value);
  return true;
};

describe("InvoicePdfService.generateAndUpload — payment truth (T-B97, R1, REG-B11 / REG-B97)", () => {
  beforeEach(() => {
    mockCapturedInvoice = null;
    jest.clearAllMocks();
  });

  it("REG-B11 (PDF leg, B97): a $500 invoice with $300 PAID + $200 DRAFT shows the customer $300 received — never $500", async () => {
    const prisma = createMockPrisma();
    // The two rows as the DB holds them. `findUnique` below reproduces the DB by
    // honouring whatever `include.payments.where` the service passes, so this
    // assertion pins the resulting NUMBER rather than a query shape: a fix that
    // filters in the query and a fix that filters in memory both satisfy it, and
    // today's `{ status: { not: "VOID" } }` (invoice-pdf.service.ts:63) cannot.
    const paymentRows = [
      { id: "pay-confirmed", amount: 300, status: "PAID", paidAt: new Date(), creditNote: null },
      { id: "pay-draft", amount: 200, status: "DRAFT", paidAt: new Date(), creditNote: null },
    ];
    prisma.invoice.findUnique.mockImplementation(async (args: any) => ({
      ...baseInvoiceFixture({ subtotal: 500, total: 500 }),
      payments: paymentRows.filter((p) => matchesStatus(p.status, args?.include?.payments?.where)),
    }));
    prisma.tenantConfig.findUnique.mockResolvedValue(TENANT_CONFIG as any);

    const service = await makeService(prisma, makeStorage(), null);
    await service.generateAndUpload("inv-1");

    expect(mockCapturedInvoice).not.toBeNull();
    // "Amount paid" as the template will show it: an explicit CONFIRMED total when
    // the service computes one, otherwise the sum of the rows it handed over (which
    // is what the template sums today). Either way it must be the confirmed $300 —
    // leaving the customer-facing Balance Due at the true $200, not $0.
    const rows: any[] = mockCapturedInvoice.payments ?? [];
    const rowSum = rows.reduce((s, p) => s + Number(p.amount), 0);
    const shownPaid =
      mockCapturedInvoice.totalPaid != null ? Number(mockCapturedInvoice.totalPaid) : rowSum;
    expect(shownPaid).toBe(300);
  });

  it("REG-B421: splits a CREDIT_NOTE and ADVANCE payment out of the cash-only totalPaid", async () => {
    const prisma = createMockPrisma();
    // A credit-note application and an advance application both create a real
    // PAID InvoicePayment row — neither is cash the customer paid today, so
    // neither may land in totalPaid (the "Amount Paid" figure).
    const paymentRows = [
      {
        id: "pay-cash",
        amount: 232,
        status: "PAID",
        method: "CASH",
        paidAt: new Date(),
        creditNote: null,
      },
      {
        id: "pay-credit",
        amount: 638,
        status: "PAID",
        method: "CREDIT_NOTE",
        paidAt: new Date(),
        creditNote: { creditNoteNumber: "CN-1042", reason: "Return" },
      },
      {
        id: "pay-advance",
        amount: 100,
        status: "PAID",
        method: "ADVANCE",
        paidAt: new Date(),
        creditNote: null,
      },
    ];
    prisma.invoice.findUnique.mockImplementation(async (args: any) => ({
      ...baseInvoiceFixture({ subtotal: 970, total: 970 }),
      payments: paymentRows.filter((p) => matchesStatus(p.status, args?.include?.payments?.where)),
    }));
    prisma.tenantConfig.findUnique.mockResolvedValue(TENANT_CONFIG as any);

    const service = await makeService(prisma, makeStorage(), null);
    await service.generateAndUpload("inv-1");

    expect(mockCapturedInvoice).not.toBeNull();
    expect(Number(mockCapturedInvoice.totalPaid)).toBe(232);
    expect(Number(mockCapturedInvoice.creditApplied)).toBe(638);
    expect(Number(mockCapturedInvoice.advanceApplied)).toBe(100);
  });
});

describe("InvoicePdfService.generateAndUpload — hide-original-price setting (T-B103, R9, REG-B103)", () => {
  beforeEach(() => {
    mockCapturedInvoice = null;
    jest.clearAllMocks();
  });

  it("REG-B103: passes the tenant's invoice.hideOriginalPrice setting through to the template", async () => {
    const prisma = createMockPrisma();
    prisma.invoice.findUnique.mockResolvedValue(baseInvoiceFixture() as any);
    prisma.tenantConfig.findUnique.mockResolvedValue(TENANT_CONFIG as any);

    const service = await makeService(prisma, makeStorage(), "true");
    await service.generateAndUpload("inv-1");

    expect(mockCapturedInvoice).not.toBeNull();
    // RED today: invoice-pdf.service.ts never reads the setting at all, so neither
    // shape below is ever populated. Without it the renderer cannot honour R9's
    // "respecting the tenant hide-original setting" — the promo/original-price
    // decision itself is proven against the helper below.
    const hideOriginalPrice =
      mockCapturedInvoice.hideOriginalPrice === true ||
      mockCapturedInvoice.tenant?.hideOriginalPrice === true;
    expect(hideOriginalPrice).toBe(true);
  });
});

/**
 * R9's renderer half. `./invoice-pdf-template` is swapped out wholesale by
 * apps/api/package.json's moduleNameMapper, so the .tsx never executes under Jest and
 * no markup assertion is possible here; the two display DECISIONS the requirement is
 * about live in ./invoice-pdf-item (a contract stub today) and are asserted directly.
 *
 * Reference behaviour = the web invoice detail renderer,
 * apps/web/app/(dashboard)/invoices/[id]/page.tsx :2408-2481 ("{N} free" note; struck
 * original price for SPECIAL / DISCOUNTED / PROMO / adjusted-down MANUAL lines, hidden
 * when the tenant hid original prices, and never shown for a MANUAL upsell).
 */
describe("invoice-pdf-item — BOGO/promo line display (T-B103, R9, REG-B103)", () => {
  const bogoLine = {
    qty: 6,
    unitPrice: 10,
    originalPrice: 12,
    priceType: "PROMO",
    promoFreeUnits: 1,
  };

  it('REG-B103: promoNote names the free units ("1 free") and is null on a line with none', () => {
    // Without the note, a BOGO line's reduced subtotal ($50 for 6 units, not $60)
    // reads to the customer as a pricing error.
    expect(promoNote(bogoLine)).toBe("1 free");
    expect(promoNote({ ...bogoLine, promoFreeUnits: 0 })).toBeNull();
    expect(promoNote({ qty: 6, unitPrice: 10, priceType: "MANUAL" })).toBeNull();
  });

  it("REG-B103: showOriginalPrice strikes the pre-promo price, obeys the tenant hide setting, and never exposes an upsell's lower base", () => {
    expect(showOriginalPrice(bogoLine, false)).toBe(true);
    // The tenant turned original prices off — the strike must disappear with it.
    expect(showOriginalPrice(bogoLine, true)).toBe(false);
    // Nothing to strike.
    expect(showOriginalPrice({ ...bogoLine, originalPrice: null }, false)).toBe(false);
    // MANUAL upsell: charged ABOVE the base price — the web renderer deliberately
    // shows no strikethrough, so the buyer never sees the lower base.
    expect(
      showOriginalPrice({ unitPrice: 15, originalPrice: 12, priceType: "MANUAL" }, false),
    ).toBe(false);
    // MANUAL adjusted DOWN keeps the strike (the "Adjusted" branch of the reference).
    expect(showOriginalPrice({ unitPrice: 9, originalPrice: 12, priceType: "MANUAL" }, false)).toBe(
      true,
    );
  });
});

describe("invoice-pdf-item — qty cell text (B653)", () => {
  it('REG-B653-pdf: a units_v1 line (boxes = unit count, pieces = 0, unitLabel "Case") reads "N Case(s)", never "N boxes"', () => {
    expect(qtyCellText({ qty: 36, boxes: 3, pieces: 0, unitLabel: "Case" })).toBe("3 Cases");
    // Singular stays unpluralized — same rule formatQtySplit already applies to boxLabel.
    expect(qtyCellText({ qty: 12, boxes: 1, pieces: 0, unitLabel: "Case" })).toBe("1 Case");
  });

  it('REG-B653-pdf: a factor-1 units_v1 line (boxes AND pieces null) names its unit — "5 Bag", never a bare "5"', () => {
    // buildInvoiceUnitLine: factor === 1 stores boxes: null, pieces: null (a
    // factor-1 unit is per-piece and snapshots as such). qtyCellText now shares
    // invoiceLineQtyText (@routeflow/pricing) with web and mobile, which reads the
    // unit off `unitLabel` directly when there's no split to attach a boxLabel to —
    // web parity (apps/web/lib/invoice-line-unit.ts), review follow-up to B653.
    expect(qtyCellText({ qty: 5, boxes: null, pieces: null, unitLabel: "Bag" })).toBe("5 Bag");
  });

  it('REG-B653-pdf: an ordinary boxed line (no unitLabel) is unchanged — still "boxes"/"pcs"', () => {
    expect(qtyCellText({ qty: 27, boxes: 2, pieces: 3 })).toBe("2 boxes + 3 pcs");
    expect(qtyCellText({ qty: 27, boxes: 2, pieces: 3, unitLabel: null })).toBe("2 boxes + 3 pcs");
  });

  it("REG-B653-pdf: a plain non-boxed line is unaffected", () => {
    expect(qtyCellText({ qty: 5, boxes: null, pieces: null })).toBe("5");
  });
});

// `./invoice-pdf-template` is replaced wholesale by apps/api/test/__mocks__/invoice-pdf-template.js
// under Jest (see this file's header), so the real .tsx renderer never executes and no assertion
// above can prove it actually WIRES unitLabel into qtyCellText — only that qtyCellText itself is
// correct. Source-pinned instead (readFileSync pattern per
// apps/mobile/__tests__/credit-limit-wiring.test.ts): today the template could revert to
// `qtyCellText({ qty, boxes, pieces })` with no unitLabel and every other B653 test would stay
// green.
describe("invoice-pdf-template — qtyCellText wiring (B653)", () => {
  it("the qty column's qtyCellText call passes unitLabel: item.unitLabel", () => {
    const src = readFileSync(join(__dirname, "invoice-pdf-template.tsx"), "utf8");
    const at = src.indexOf("qtyCellText({");
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, src.indexOf("})", at) + 2);
    expect(call).toMatch(/unitLabel:\s*item\.unitLabel/);
  });
});
