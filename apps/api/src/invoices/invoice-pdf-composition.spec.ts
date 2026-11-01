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

async function make(
  mode: string,
  inv: unknown,
  slug: string | null = "acme",
  cfg: Record<string, string> = {},
) {
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
      {
        provide: SystemConfigService,
        useValue: { get: jest.fn(async (k: string) => cfg[k] ?? null) },
      },
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

/**
 * SA-1031: a tenant can turn the product barcodes off the invoice PDF (`invoice.hideBarcodes`; absent = shown). Off means
 * no line Code128 and no code under it, and no piece barcode image or digits; a piece keeps its "SKU ..." text; the order QR
 * (not a product barcode) stays.
 */
describe("invoice PDF payload: invoice.hideBarcodes (SA-1031)", () => {
  const KEY = "invoice.hideBarcodes";
  const comps = [component("a", 24, 0, 0.625), component("o", 24, 1, null)];
  const plainLine = () =>
    invoice({
      items: [
        {
          ...invoice().items[0],
          product: {
            id: "p1",
            name: "Soda",
            barcode: "012345678905",
            sku: "S-1",
            unitSku: "UNIT-1",
          },
        },
      ],
    });
  const code128 = () => mockToBuffer.mock.calls.filter(([o]) => o.bcid === "code128");
  beforeEach(() => {
    mockCapturedInvoice = null;
    mockToBuffer.mockClear();
    process.env.WEB_URL = "https://app.example.com";
  });

  it("B-R1: key 'true': a plain line has no barcode image and no code text, and no Code128 is drawn", async () => {
    const svc = await make("off", plainLine(), "acme", { [KEY]: "true" });
    await svc.generateAndUpload("inv-1");
    const item = mockCapturedInvoice.items[0];
    expect(item.barcodeDataUri).toBeUndefined();
    expect(item.barcodeText).toBeUndefined();
    expect(code128()).toHaveLength(0);
  });

  it("B-R2: key 'true': a piece has no barcode image and no digits, keeps its SKU, and no piece barcode is drawn", async () => {
    const svc = await make("off", invoice({}, comps), "acme", { [KEY]: "true" });
    await svc.generateAndUpload("inv-1");
    const subs = mockCapturedInvoice.items[0].subLines;
    expect(subs).toHaveLength(2);
    expect(subs[0]).toMatchObject({
      name: "Name a",
      unitSku: "SKU-a",
      barcodeText: null,
      barcodeDataUri: null,
      priceText: "$0.63 (included)",
    });
    expect(mockToBuffer.mock.calls.some(([o]) => o.bcid === "upca")).toBe(false);
  });

  it.each([[undefined], ["false"], ["yes"], [""]])(
    "B-G1/B-G2: key %p: the line barcode renders exactly as before",
    async (raw) => {
      const svc = await make("off", plainLine(), "acme", raw === undefined ? {} : { [KEY]: raw });
      await svc.generateAndUpload("inv-1");
      const item = mockCapturedInvoice.items[0];
      expect(item.barcodeText).toBe("UNIT-1");
      expect(item.barcodeDataUri).toMatch(/^data:image\/png;base64,/);
      expect(code128()).toHaveLength(1);
    },
  );

  it("B-G3: key 'true' leaves the order QR (it is not a product barcode)", async () => {
    const svc = await make("on", invoice(), "acme", { [KEY]: "true" });
    await svc.generateAndUpload("inv-1");
    expect(mockCapturedInvoice.qrDataUri).toMatch(/^data:image\/png;base64,/);
    expect(mockToBuffer.mock.calls.some(([o]) => o.bcid === "qrcode")).toBe(true);
  });
});

/**
 * SA-1031 r2: a mixed-pack line prints ONE barcode source, the box (the line's Code128) or the pieces, never both. "The
 * tenant used the box" = the pack product has a scan code (`unitSku ?? barcode`); the item number `sku` alone does not count.
 */
describe("invoice PDF payload: one barcode source on a mixed-pack line (SA-1031 r2)", () => {
  const pieceB = {
    ...component("b", 24, 1, 0.625),
    unitBarcode: "012345678905",
    barcodeSymbology: "UPC_A",
  };
  const packOf = (product: Record<string, unknown>, components: unknown[]) =>
    invoice(
      {
        items: [
          {
            ...invoice({}, components).items[0],
            product: {
              id: "p1",
              name: "Mixed Pack",
              barcode: null,
              sku: null,
              unitSku: null,
              ...product,
            },
          },
        ],
      },
      components,
    );
  const code128 = () => mockToBuffer.mock.calls.filter(([o]) => o.bcid === "code128");
  const pieceDraws = () => mockToBuffer.mock.calls.filter(([o]) => o.bcid === "upca");
  beforeEach(() => {
    mockCapturedInvoice = null;
    mockToBuffer.mockClear();
    process.env.WEB_URL = "https://app.example.com";
  });

  it("MP-R1: no pack code (only the item number): the line prints no Code128, the pieces keep theirs", async () => {
    const svc = await make(
      "off",
      packOf({ sku: "PACK-1" }, [component("a", 24, 0, 0.625), pieceB]),
    );
    await svc.generateAndUpload("inv-1");
    const item = mockCapturedInvoice.items[0];
    expect(item.barcodeDataUri).toBeUndefined();
    expect(item.barcodeText).toBeUndefined();
    expect(code128()).toHaveLength(0);
    for (const s of item.subLines) {
      expect(s.barcodeText).toEqual(expect.any(String));
      expect(s.barcodeDataUri).toMatch(/^data:image\/png;base64,/);
    }
    expect(pieceDraws()).toHaveLength(2);
  });

  it("MP-R2: the pack has a box barcode: the line prints it, no piece prints a barcode, the SKU text stays", async () => {
    const svc = await make(
      "off",
      packOf({ barcode: "BOX-123" }, [component("a", 24, 0, 0.625), pieceB]),
    );
    await svc.generateAndUpload("inv-1");
    const item = mockCapturedInvoice.items[0];
    expect(item.barcodeText).toBe("BOX-123");
    expect(item.barcodeDataUri).toMatch(/^data:image\/png;base64,/);
    expect(code128()).toHaveLength(1);
    expect(pieceDraws()).toHaveLength(0);
    for (const s of item.subLines) {
      expect(s.barcodeText).toBeNull();
      expect(s.barcodeDataUri).toBeNull();
    }
    expect(item.subLines[0].unitSku).toBe("SKU-a");
  });

  it("MP-R3: the pack has only a unit code: the line prints it, the pieces print none", async () => {
    const svc = await make(
      "off",
      packOf({ unitSku: "UNIT-9" }, [component("a", 24, 0, 0.625), pieceB]),
    );
    await svc.generateAndUpload("inv-1");
    const item = mockCapturedInvoice.items[0];
    expect(item.barcodeText).toBe("UNIT-9");
    expect(code128()).toHaveLength(1);
    expect(pieceDraws()).toHaveLength(0);
    expect(
      item.subLines.every((s: any) => s.barcodeText === null && s.barcodeDataUri === null),
    ).toBe(true);
  });

  it("MP-G1: pin (21)'s fixture (no pack code; piece a has a barcode, piece o none) is unchanged", async () => {
    const svc = await make(
      "off",
      invoice({}, [component("a", 24, 0, 0.625), component("o", 24, 1, null)]),
    );
    await svc.generateAndUpload("inv-1");
    const item = mockCapturedInvoice.items[0];
    expect(item.barcodeDataUri).toBeUndefined();
    expect(item.subLines[0].barcodeText).toBe("036000291452");
    expect(item.subLines[1].barcodeText).toBeNull();
  });

  it("MP-G2: no pack code and no piece barcode: the line prints the item number, as today", async () => {
    const svc = await make(
      "off",
      packOf({ sku: "PACK-1" }, [component("o", 24, 0, null), component("p", 24, 1, null)]),
    );
    await svc.generateAndUpload("inv-1");
    const item = mockCapturedInvoice.items[0];
    expect(item.barcodeText).toBe("PACK-1");
    expect(item.barcodeDataUri).toMatch(/^data:image\/png;base64,/);
    expect(item.subLines.every((s: any) => s.barcodeText === null)).toBe(true);
  });

  it("MP-G3: a plain line still prints its code", async () => {
    const svc = await make("off", packOf({ unitSku: "UNIT-1", sku: "S-1" }, []));
    await svc.generateAndUpload("inv-1");
    expect(mockCapturedInvoice.items[0].barcodeText).toBe("UNIT-1");
    expect(code128()).toHaveLength(1);
  });

  it("MP-G4: key 'true' prints neither the line nor the pieces", async () => {
    const svc = await make(
      "off",
      packOf({ barcode: "BOX-123" }, [component("a", 24, 0, 0.625), pieceB]),
      "acme",
      { "invoice.hideBarcodes": "true" },
    );
    await svc.generateAndUpload("inv-1");
    expect(mockCapturedInvoice.items[0].barcodeDataUri).toBeUndefined();
    expect(mockToBuffer.mock.calls.some(([o]) => o.bcid === "code128" || o.bcid === "upca")).toBe(
      false,
    );
  });
});
