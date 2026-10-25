import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { CustomerPriceHistoryService } from "./customer-price-history.service";

/** Row 607 (#3202 follow-ups): the price-summary chip scan reads lines in a fixed order and never prices an unknown unit. */
describe("CustomerPriceHistoryService.getPriceSummary (row 607)", () => {
  let service: CustomerPriceHistoryService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.customer.findFirst.mockResolvedValue({ id: "c1" });
    const mod = await Test.createTestingModule({
      providers: [CustomerPriceHistoryService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(CustomerPriceHistoryService);
    prisma.getTenantId.mockReturnValue("t1");
  });

  const sum = () => service.getPriceSummary("c1", "p1", { role: UserRole.OPERATOR });
  const item = (o: Record<string, unknown>) => ({
    id: "ii",
    productId: "p1",
    qty: 1,
    unitPrice: 10,
    priceType: "STANDARD",
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitLabel: null,
    product: { unit: "Each", unitsPerBox: 24 },
    ...o,
  });

  it("reads the invoice's lines in a fixed order (newest line first, id breaks ties)", async () => {
    prisma.invoice.findMany.mockResolvedValue([]);
    await sum();
    const args = prisma.invoice.findMany.mock.calls[0][0];
    expect(args.select.items.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("an unsplit legacy box line (no snapshot, product boxed today) is NOT a chip price", async () => {
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "i1",
        issueDate: new Date("2026-09-01"),
        items: [item({ id: "legacy", unitPrice: 24 })],
      },
    ]);
    const out = await sum();
    expect(out.p1).toEqual({
      last3: [],
      low: null,
      high: null,
      unitLabel: null,
      unitsPerBox: null,
    });
  });

  it("GUARD: a piece-priced line of a never-boxed product still is", async () => {
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "i1",
        issueDate: new Date("2026-09-01"),
        items: [item({ unitPrice: 2, product: { unit: "Each", unitsPerBox: null } })],
      },
    ]);
    const out = await sum();
    expect(out.p1.low).toBe(2);
    expect(out.p1.last3).toHaveLength(1);
  });

  it("GUARD: a split boxed line with its snapshot still is, and an unknown line beside it does not move low/high", async () => {
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "i1",
        issueDate: new Date("2026-09-01"),
        items: [
          item({
            id: "boxed",
            unitPrice: 24,
            boxes: 1,
            pieces: 0,
            unitsPerBox: 24,
            unitLabel: "Box",
          }),
          item({ id: "legacy", unitPrice: 1 }),
        ],
      },
    ]);
    const out = await sum();
    expect(out.p1.low).toBe(24);
    expect(out.p1.high).toBe(24);
    expect(out.p1.unitsPerBox).toBe(24);
  });
});
