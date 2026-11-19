/**
 * SA-1141 / W-989 PR-2, case 14 (R4): an invoice converted from an estimate takes the ESTIMATE's discount tax base, so the
 * customer's quoted tax does not move at the cutover. The cutover is set to a past instant here; production stays null (dark).
 */
let mockFrom: Date | null = null;
jest.mock("@routeflow/pricing", () => ({
  ...jest.requireActual("@routeflow/pricing"),
  get DISCOUNT_PRE_TAX_FROM() {
    return mockFrom;
  },
}));

import { Test } from "@nestjs/testing";
import { EstimatesService } from "./estimates.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

const CUTOVER = new Date("2026-12-01T00:00:00Z");

describe("EstimatesService.convertToInvoice: the estimate's own discount tax base (SA-1141 R4)", () => {
  let service: EstimatesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    mockFrom = CUTOVER;
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") },
        },
        {
          provide: RegulatedLedgerService,
          useValue: { writeSaleEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    service = mod.get(EstimatesService);
    prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({
        id: "inv-1",
        ...args.data,
        issueDate: new Date("2026-12-10T00:00:00Z"),
        items: (args.data.items.create as any[]).map((c, i) => ({ id: `ii-${i}`, ...c })),
        customer: {},
      }),
    );
  });
  afterAll(() => {
    mockFrom = null;
  });

  /** A 100 @10% quote with 20 off; `createdAt` decides its mode. */
  const arm = (createdAt: Date) => {
    (prisma as any).systemConfig.findFirst.mockResolvedValue({ value: "10" });
    prisma.estimate.findUnique.mockResolvedValue({
      id: "est-1",
      status: "ACCEPTED",
      customerId: "cust-1",
      customer: { isTaxExempt: false },
      createdAt,
      subtotal: 100,
      taxAmount: 10,
      discount: 20,
      total: 90,
      notes: null,
      terms: null,
      items: [
        {
          description: "Widget",
          productId: null,
          qty: 1,
          unitPrice: 100,
          subtotal: 100,
          boxes: null,
          pieces: null,
          unitLabel: null,
          unitsPerBox: null,
        },
      ],
    });
    prisma.product.findMany.mockResolvedValue([]);
    prisma.trackedCategory.findMany.mockResolvedValue([]);
  };
  const created = () => prisma.invoice.create.mock.calls[0][0].data;

  it("14: a quote made BEFORE the cutover converts after it with its quoted tax (10 / 90)", async () => {
    arm(new Date("2026-11-20T12:00:00Z"));
    await service.convertToInvoice("est-1");
    expect({ tax: created().taxAmount, total: created().total }).toEqual({ tax: 10, total: 90 });
  });

  it("14b: a quote made AFTER the cutover converts with the discount off the tax base (8 / 88)", async () => {
    arm(new Date("2026-12-05T12:00:00Z"));
    await service.convertToInvoice("est-1");
    expect({ tax: created().taxAmount, total: created().total }).toEqual({ tax: 8, total: 88 });
  });

  it("R7 wire field: the estimate detail carries its own mode (PRE_TAX after the cutover, LEGACY before)", async () => {
    prisma.estimate.findUnique.mockResolvedValueOnce({
      id: "e1",
      createdAt: new Date("2026-12-05T12:00:00Z"),
      items: [],
    });
    expect((await service.findOne("e1")).discountTaxBase).toBe("PRE_TAX");
    prisma.estimate.findUnique.mockResolvedValueOnce({
      id: "e2",
      createdAt: new Date("2026-11-20T12:00:00Z"),
      items: [],
    });
    expect((await service.findOne("e2")).discountTaxBase).toBe("LEGACY_POST_TAX");
  });
});
