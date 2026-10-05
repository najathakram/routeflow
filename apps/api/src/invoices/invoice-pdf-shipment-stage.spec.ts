/**
 * F3 (shipping-flow polish): the invoice raised at SHIPMENT is sendable, so its PDF must not be
 * stamped DRAFT. The stage keys on the server's own shipment-invoice answer (not-a-pending-mirror AND
 * settled at shipment), never on order.status === DELIVERED alone. Every other invoice keeps today's
 * stage.
 */
let mockCaptured: any = null;

jest.mock("@react-pdf/renderer", () => ({
  renderToBuffer: jest.fn(async (element: any) => {
    mockCaptured = element?.props?.invoice ?? null;
    return Buffer.from("");
  }),
}));

import { Test } from "@nestjs/testing";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

const SHIPPED_AT = new Date("2026-02-01T10:00:00.000Z");

async function variantFor(opts: {
  mode: string;
  invoiceStatus?: string;
  deliveryBatchId?: string | null;
  order: { status: string; fulfillPath: string; shippedAt?: Date | null } | null;
}): Promise<string> {
  mockCaptured = null;
  const prisma = createMockPrisma();
  prisma.invoice.findUnique.mockResolvedValue({
    id: "inv-1",
    tenantId: "tenant-1",
    orderId: opts.order ? "ord-1" : null,
    deliveryBatchId: opts.deliveryBatchId ?? null,
    invoiceNumber: "INV-1",
    status: opts.invoiceStatus ?? "DRAFT",
    issueDate: new Date("2026-02-01T00:00:00.000Z"),
    dueDate: new Date("2026-03-01T00:00:00.000Z"),
    subtotal: 10,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 10,
    depositPercent: null,
    customer: {
      id: "c1",
      businessName: "Acme Buyer",
      contactName: null,
      phone: null,
      addresses: [],
    },
    items: [],
    payments: [],
    order: opts.order,
  } as any);
  prisma.tenantConfig.findUnique.mockResolvedValue(null as any);
  const module = await Test.createTestingModule({
    providers: [
      InvoicePdfService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: StorageService,
        useValue: {
          upload: jest.fn().mockResolvedValue(undefined),
          presignedUrl: jest.fn().mockResolvedValue("https://cdn.example.com/x.pdf"),
        },
      },
      { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      {
        provide: FeatureConfigService,
        useValue: { getEffectiveMode: jest.fn().mockResolvedValue(opts.mode) },
      },
    ],
  }).compile();
  await module.get(InvoicePdfService).generateAndUpload("inv-1");
  return mockCaptured.variant;
}

describe("InvoicePdfService stage for a shipment invoice (F3)", () => {
  it.each(["ship", "both", "pickup_ship"])(
    "a DRAFT invoice of a shipped SHIP order (%s business) renders FINAL, not DRAFT",
    async (mode) => {
      expect(
        await variantFor({
          mode,
          order: { status: "OUT_FOR_DELIVERY", fulfillPath: "SHIP", shippedAt: SHIPPED_AT },
        }),
      ).toBe("final");
    },
  );

  it("an unmarked shipment (order back to CONFIRMED) is a pending mirror again: DRAFT", async () => {
    expect(
      await variantFor({
        mode: "ship",
        order: { status: "CONFIRMED", fulfillPath: "SHIP", shippedAt: SHIPPED_AT },
      }),
    ).toBe("draft");
  });

  it("unchanged: an unset-mode business keeps DRAFT until delivered", async () => {
    expect(
      await variantFor({
        mode: "unset",
        order: { status: "OUT_FOR_DELIVERY", fulfillPath: "SHIP", shippedAt: SHIPPED_AT },
      }),
    ).toBe("draft");
  });

  it("unchanged: a ROUTE order out for delivery keeps DRAFT", async () => {
    expect(
      await variantFor({
        mode: "ship",
        order: { status: "OUT_FOR_DELIVERY", fulfillPath: "ROUTE", shippedAt: null },
      }),
    ).toBe("draft");
  });

  it("unchanged: a pending mirror (SHIP, not shipped) keeps DRAFT", async () => {
    expect(
      await variantFor({
        mode: "ship",
        order: { status: "CONFIRMED", fulfillPath: "SHIP", shippedAt: null },
      }),
    ).toBe("draft");
  });

  it("unchanged: DELIVERED is FINAL; an issued invoice is FINAL; no order is DRAFT", async () => {
    expect(
      await variantFor({
        mode: "unset",
        order: { status: "DELIVERED", fulfillPath: "ROUTE", shippedAt: null },
      }),
    ).toBe("final");
    expect(
      await variantFor({
        mode: "unset",
        invoiceStatus: "SENT",
        order: { status: "PENDING", fulfillPath: "ROUTE", shippedAt: null },
      }),
    ).toBe("final");
    expect(await variantFor({ mode: "ship", order: null })).toBe("draft");
  });
});
