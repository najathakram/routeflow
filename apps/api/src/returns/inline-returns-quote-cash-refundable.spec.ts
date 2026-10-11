/**
 * SA-749r2 item C: the inline-return QUOTE exposes `cashRefundable` per source sale (cash applied less earlier cash refunds),
 * computed by the SAME function the 409 cap uses (`cashRefundRooms` in cash-refund-cap.ts), so the quote and the cap agree.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Test } from "@nestjs/testing";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { assertCashRefundWithinCap } from "./cash-refund-cap";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("./inline-return-refund", () => ({
  ...jest.requireActual("./inline-return-refund"),
  loadSourceInvoicesState: jest.fn(async () => ({
    paidInFull: true,
    paidMethods: ["CASH"],
    paidWithStoreCredit: false,
  })),
  sourcesAreRefundable: jest.fn(() => true),
}));

const OPERATOR = { sub: "op-1", role: "OPERATOR", tenantId: "t1" } as never;
const chunk = (sourceOrderId: string | null, subtotal: number) => ({
  sourceOrderId,
  sourceInvoiceItemId: sourceOrderId ? `ii-${sourceOrderId}` : null,
  sourceOrderItemId: null,
  productId: "p1",
  pieces: 1,
  subtotal,
  taxAmount: 0,
  categoryTax: 0,
  priceSource: "INVOICE",
  unitPrice: subtotal,
});

describe("InlineReturnsQuoteService: cashRefundable (one function with the 409 cap)", () => {
  let service: InlineReturnsQuoteService;
  let db: any;

  /** Sale o1: cash 50 applied, 20 already refunded in cash; sale o2: card only (no cash). */
  const seed = () => {
    db.customer.findFirst.mockResolvedValue({ isWalkIn: true });
    db.invoicePayment.findMany.mockResolvedValue([{ amount: 50, invoice: { orderId: "o1" } }]);
    db.returnItem.findMany.mockResolvedValue([
      { sourceOrderId: "o1", subtotal: 20, taxAmount: 0, categoryTax: 0 },
    ]);
    db.return.findMany.mockResolvedValue([]);
  };

  beforeEach(async () => {
    const prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        InlineReturnsQuoteService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();
    service = mod.get(InlineReturnsQuoteService);
    db = prisma.forTenant();
    seed();
    jest.spyOn(service, "priceInlineReturn").mockResolvedValue({
      chunks: [chunk("o1", 31), chunk("o2", 5), chunk(null, 1)],
      subtotal: 37,
      taxAmount: 0,
      categoryTax: 0,
      total: 37,
      productBreakdown: {},
    } as never);
  });

  const quote = () =>
    service.quote({ customerId: "c1", items: [{ productId: "p1", qty: 1 }] } as never, OPERATOR);

  it("per source sale: cash applied less earlier cash refunds; a sale with no cash reads 0; a no-sale chunk is not a key", async () => {
    const q = await quote();
    expect(q.cashRefundable).toEqual({ o1: 30, o2: 0 });
  });

  it("the quote's figure IS the maxCashRefund the 409 returns for the same sale (31 over 30 -> 409 carrying 30; 30 passes)", async () => {
    const q = await quote();
    const attempt = (amount: number) =>
      assertCashRefundWithinCap(db, {
        returnId: "ret-new",
        tender: "CASH",
        perOrder: new Map([["o1", amount]]),
      }).then(
        () => null,
        (e: any) => e.getResponse(),
      );
    expect(await attempt(q.cashRefundable.o1)).toBeNull();
    const refused = await attempt(31);
    expect(refused).toMatchObject({ code: "REFUND_EXCEEDS_CASH_PAID", maxCashRefund: 30 });
    expect(refused.maxCashRefund).toBe(q.cashRefundable.o1);
  });

  it("IMPORT PIN: the quote service and the cap both go through cashRefundRooms (one implementation)", () => {
    const quoteSrc = readFileSync(join(__dirname, "inline-returns-quote.service.ts"), "utf8");
    const capSrc = readFileSync(join(__dirname, "cash-refund-cap.ts"), "utf8");
    expect(quoteSrc).toMatch(/import \{ cashRefundRooms \} from "\.\/cash-refund-cap";/);
    expect(quoteSrc).toMatch(/cashRefundRooms\(db,/);
    // the cap reads its room from the shared function, and holds no cash-applied query of its own
    const assertBody = capSrc.slice(
      capSrc.indexOf("export async function assertCashRefundWithinCap"),
    );
    expect(assertBody).toMatch(/cashRefundRooms\(tx,/);
    expect(assertBody).not.toMatch(/invoicePayment\.findMany/);
  });
});
