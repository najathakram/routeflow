/**
 * #2717 M3 (SA-579 cases 21-23): composed-line sub-lines and the order QR on the invoice PDF payload.
 * The template module is jest-mocked (see invoice-pdf.service.spec.ts), so this records the props the
 * service hands to renderToBuffer and the calls it makes to the barcode encoder.
 */
let mockCapturedInvoice: any = null;

jest.mock("@react-pdf/renderer", () => ({
  renderToBuffer: jest.fn(async (element: any) => {
    mockCapturedInvoice = element?.props?.invoice ?? null;
    return Buffer.from("");
  }),
}));

const mockToBuffer = jest.fn(async (opts: { bcid: string; text: string }) =>
  Buffer.from(`${opts.bcid}:${opts.text}`),
);
jest.mock("bwip-js", () => ({
  __esModule: true,
  default: { toBuffer: (o: any) => mockToBuffer(o) },
}));

import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FeatureConfigService } from "../billing/feature-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { InvoicePdfService } from "./invoice-pdf.service";

const component = (id: string, qty: number, position: number, price: number | null) => ({
  id: `c-${id}`,
  componentProductId: id,
  name: `Name ${id}`,
  qty,
  unitSku: `SKU-${id}`,
  unitBarcode: id === "a" ? "036000291452" : null,
  barcodeSymbology: id === "a" ? "UPC_A" : null,
  displayUnitPrice4: price,
  position,
});

function invoice(o: Record<string, unknown> = {}, components: unknown[] = []) {
  return {
    id: "inv-1",
    tenantId: "tenant-1",
    orderId: "ord-1",
    invoiceNumber: "INV-1",
    status: "SENT",
    issueDate: new Date("2026-01-01T00:00:00.000Z"),
    dueDate: new Date("2026-01-31T00:00:00.000Z"),
    subtotal: 60,
    taxAmount: 6,
    discount: 0,
    shippingFee: 0,
    total: 66,
    depositPercent: null,
    customer: { id: "c", businessName: "Buyer", contactName: null, phone: null, addresses: [] },
    items: [
      {
        id: "item-1",
        description: "Mixed Pack",
        qty: 48,
        unitPrice: 30,
        discount: 0,
        taxRate: 0.1,
        subtotal: 60,
        boxes: 2,
        pieces: 0,
        unitsPerBox: 24,
        product: { id: "p1", name: "Mixed Pack", barcode: null, sku: null, unitSku: null },
        components,
      },
    ],
    payments: [],
    order: { status: "CONFIRMED" },
    ...o,
  };
}

async function make(mode: string, inv: unknown, slug: string | null = "acme") {
  const prisma = createMockPrisma();
  prisma.invoice.findUnique.mockResolvedValue(inv as never);
  prisma.tenantConfig.findUnique.mockResolvedValue(null as never);
  prisma.tenant.findUnique.mockResolvedValue(slug ? ({ slug } as never) : (null as never));
  const module = await Test.createTestingModule({
    providers: [
      InvoicePdfService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: StorageService,
        useValue: {
          upload: jest.fn(),
          download: jest.fn(),
          presignedUrl: jest.fn().mockResolvedValue("https://cdn/x.pdf"),
        },
      },
      { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      {
        provide: FeatureConfigService,
        useValue: { getEffectiveMode: jest.fn().mockResolvedValue(mode) },
      },
    ],
  }).compile();
  return module.get(InvoicePdfService);
}

describe("invoice PDF payload: composed sub-lines (cases 21, 23)", () => {
  const comps = [component("a", 24, 0, 0.625), component("o", 24, 1, null)];
  beforeEach(() => {
    mockCapturedInvoice = null;
    mockToBuffer.mockClear();
    process.env.WEB_URL = "https://app.example.com";
  });

  it("(21) a composed item carries subLines with name, sku, barcode, qty and the frozen price text", async () => {
    const svc = await make("on", invoice({}, comps));
    await svc.generateAndUpload("inv-1");
    const subs = mockCapturedInvoice.items[0].subLines;
    expect(subs).toHaveLength(2);
    expect(subs[0]).toMatchObject({
      name: "Name a",
      unitSku: "SKU-a",
      barcodeText: "036000291452",
      qtyText: "x 24",
      priceText: "$0.63 (included)",
    });
    expect(subs[0].barcodeDataUri).toMatch(/^data:image\/png;base64,/);
    expect(mockToBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ bcid: "upca", text: "036000291452" }),
    );
    expect(subs[1]).toMatchObject({ name: "Name o", barcodeText: null, priceText: "(included)" });
    expect(subs[1].barcodeDataUri).toBeNull();
  });

  it("(21) a legacy item has NO subLines key at all", async () => {
    const svc = await make("on", invoice({}, []));
    await svc.generateAndUpload("inv-1");
    expect(Object.keys(mockCapturedInvoice.items[0])).not.toContain("subLines");
  });

  it("(23) subtotal, tax and total are identical with and without components", async () => {
    const withC = await make("on", invoice({}, comps));
    await withC.generateAndUpload("inv-1");
    const a = mockCapturedInvoice;
    const without = await make("on", invoice({}, []));
    await without.generateAndUpload("inv-1");
    const b = mockCapturedInvoice;
    for (const k of ["subtotal", "taxAmount", "total", "discount", "shippingFee"]) {
      expect(a[k]).toBe(b[k]);
    }
    expect(a.subtotal).toBe(60);
  });
});

describe("invoice PDF payload: the order QR (case 22)", () => {
  beforeEach(() => {
    mockCapturedInvoice = null;
    mockToBuffer.mockClear();
    process.env.WEB_URL = "https://app.example.com";
  });

  it("an order-linked invoice in a mixed_packs tenant gets a QR of the buyer-portal order URL", async () => {
    const svc = await make("on", invoice());
    await svc.generateAndUpload("inv-1");
    expect(mockCapturedInvoice.qrDataUri).toMatch(/^data:image\/png;base64,/);
    const call = mockToBuffer.mock.calls.find(([o]) => o.bcid === "qrcode");
    expect(call?.[0].text).toBe("https://app.example.com/buyer/portal/acme/orders/ord-1");
    expect(call?.[0].text).not.toMatch(/[?#]/);
  });

  it("a manual invoice (no order) has no QR", async () => {
    const svc = await make("on", invoice({ orderId: null }));
    await svc.generateAndUpload("inv-1");
    expect(Object.keys(mockCapturedInvoice)).not.toContain("qrDataUri");
  });

  it("mixed_packs off: no QR, the PDF is unchanged for every existing tenant", async () => {
    const svc = await make("off", invoice());
    await svc.generateAndUpload("inv-1");
    expect(Object.keys(mockCapturedInvoice)).not.toContain("qrDataUri");
    expect(mockToBuffer.mock.calls.some(([o]) => o.bcid === "qrcode")).toBe(false);
  });

  it.each([undefined, "app.example.com"])(
    "WEB_URL %p: no QR, a warn, never a localhost link",
    async (base) => {
      if (base === undefined) delete process.env.WEB_URL;
      else process.env.WEB_URL = base;
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const svc = await make("on", invoice());
      await svc.generateAndUpload("inv-1");
      expect(Object.keys(mockCapturedInvoice)).not.toContain("qrDataUri");
      expect(mockToBuffer.mock.calls.some(([o]) => /localhost/.test(o.text))).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/WEB_URL/));
      warn.mockRestore();
    },
  );
});
