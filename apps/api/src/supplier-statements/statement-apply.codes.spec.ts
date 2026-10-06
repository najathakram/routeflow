import * as fs from "fs";
import * as path from "path";
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { StatementApplyService } from "./statement-apply.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * B987-E1 (a), SA-634: every bill-specific refusal of applyStatement carries a CODE and the structured fields the web needs to
 * show fixed copy. Status (400), message text and the point at which each is thrown are unchanged; the numbers are the same
 * rounded values the message interpolates. billId on DUPLICATE_BILL is an explicit REQUEST ECHO (the caller sent it); every
 * other billId / billNumber comes from the bill row the tenant-scoped transaction loaded, and another tenant's bill id is the
 * uncoded 404, never a coded 400 carrying its fields.
 */
const D = (n: number | string) => new Prisma.Decimal(n);

const scanRow = (o: Record<string, unknown> = {}) => ({
  id: "scan-1",
  tenantId: "tenant-1",
  supplierId: "sup-1",
  status: "SCANNED",
  extractedPayload: { lines: [] },
  appliedPaymentGroupId: null,
  appliedAt: null,
  appliedById: null,
  ...o,
});
const vendorBill = (o: Record<string, unknown> = {}) => ({
  id: "bill-1",
  billNumber: "BILL-2026-0001",
  supplierId: "sup-1",
  status: "RECEIVED",
  supplierInvoiceNumber: "INV-1001",
  totalOwed: D(100),
  totalPaid: D(0),
  billDate: new Date("2026-08-01"),
  payments: [] as { amount: Prisma.Decimal }[],
  ...o,
});
const line = (o: Record<string, unknown> = {}) => ({
  date: "2026-08-01",
  kind: "INVOICE",
  refNumber: "INV-1001",
  amount: 100,
  runningBalance: 0,
  ...o,
});

describe("applyStatement: coded, structured refusals (B987-E1 a)", () => {
  let service: StatementApplyService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let scanModel: { findUnique: jest.Mock; update: jest.Mock };
  const user = { sub: "user-1" };

  beforeEach(async () => {
    prisma = createMockPrisma();
    scanModel = {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    };
    (prisma as any).supplierStatementScan = scanModel;
    (prisma.forTenant() as any).supplierStatementScan = scanModel;
    const module: TestingModule = await Test.createTestingModule({
      providers: [StatementApplyService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(StatementApplyService);
  });

  const refusal = async (dto: any) => {
    const err: any = await service.applyStatement("scan-1", dto, user).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getStatus()).toBe(400);
    return err.getResponse() as Record<string, unknown>;
  };

  it("DISCARDED, NOT_MATCHED and NOTHING carry a code and no fields", async () => {
    scanModel.findUnique.mockResolvedValue(scanRow({ status: "DISCARDED" }));
    expect(await refusal({ confirmed: [] })).toEqual({
      code: "STATEMENT_APPLY_DISCARDED",
      message: "This statement was discarded and cannot be applied.",
    });
    scanModel.findUnique.mockResolvedValue(scanRow({ supplierId: null }));
    expect(await refusal({ confirmed: [] })).toEqual({
      code: "STATEMENT_APPLY_NOT_MATCHED",
      message: "This statement has not been matched to a supplier yet.",
    });
    scanModel.findUnique.mockResolvedValue(scanRow());
    expect(await refusal({ confirmed: [] })).toEqual({
      code: "STATEMENT_APPLY_NOTHING",
      message: "Nothing to apply.",
    });
  });

  it("DUPLICATE_BILL echoes the billId the caller sent (the documented request-echo exception)", async () => {
    scanModel.findUnique.mockResolvedValue(scanRow());
    expect(
      await refusal({
        confirmed: [
          { billId: "bill-9", amount: 10 },
          { billId: "bill-9", amount: 5 },
        ],
      }),
    ).toEqual({
      code: "STATEMENT_APPLY_DUPLICATE_BILL",
      message:
        "The same bill was confirmed on more than one statement line — a bill can only be settled once per apply.",
      billId: "bill-9",
    });
  });

  describe("per-bill refusals", () => {
    beforeEach(() => {
      scanModel.findUnique.mockResolvedValue(scanRow({ extractedPayload: { lines: [line()] } }));
    });
    const confirm = (amount = 100) => ({ confirmed: [{ billId: "bill-1", amount }] });
    const implied = { confirmed: [], impliedPaid: { billIds: ["bill-1"] } };

    it("WRONG_SUPPLIER names the bill and which loop refused it", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(vendorBill({ supplierId: "other" }));
      const msg = "Bill BILL-2026-0001 does not belong to this statement's supplier.";
      expect(await refusal(confirm())).toEqual({
        code: "STATEMENT_APPLY_WRONG_SUPPLIER",
        message: msg,
        billId: "bill-1",
        billNumber: "BILL-2026-0001",
        line: "CONFIRMED",
      });
      expect(await refusal(implied)).toEqual({
        code: "STATEMENT_APPLY_WRONG_SUPPLIER",
        message: msg,
        billId: "bill-1",
        billNumber: "BILL-2026-0001",
        line: "IMPLIED_PAID",
      });
    });

    it("BILL_VOID keeps each loop's own sentence and says which loop", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(vendorBill({ status: "VOID" }));
      expect(await refusal(confirm())).toEqual({
        code: "STATEMENT_APPLY_BILL_VOID",
        message: "Bill BILL-2026-0001 is void and cannot be paid.",
        billId: "bill-1",
        billNumber: "BILL-2026-0001",
        line: "CONFIRMED",
      });
      expect(await refusal(implied)).toEqual({
        code: "STATEMENT_APPLY_BILL_VOID",
        message: "Bill BILL-2026-0001 is void and cannot be marked paid.",
        billId: "bill-1",
        billNumber: "BILL-2026-0001",
        line: "IMPLIED_PAID",
      });
    });

    it("BILL_DRAFT keeps each loop's own sentence and says which loop", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(vendorBill({ status: "DRAFT" }));
      expect(await refusal(confirm())).toEqual({
        code: "STATEMENT_APPLY_BILL_DRAFT",
        message:
          "Bill BILL-2026-0001 is still a draft — receive it before settling it off a statement.",
        billId: "bill-1",
        billNumber: "BILL-2026-0001",
        line: "CONFIRMED",
      });
      expect(await refusal(implied)).toEqual({
        code: "STATEMENT_APPLY_BILL_DRAFT",
        message: "Bill BILL-2026-0001 is still a draft and cannot be marked paid.",
        billId: "bill-1",
        billNumber: "BILL-2026-0001",
        line: "IMPLIED_PAID",
      });
    });

    it("NO_BACKING_LINE names the bill", async () => {
      scanModel.findUnique.mockResolvedValue(scanRow({ extractedPayload: { lines: [] } }));
      prisma.vendorBill.findUnique.mockResolvedValue(vendorBill());
      expect(await refusal(confirm())).toEqual({
        code: "STATEMENT_APPLY_NO_BACKING_LINE",
        message: "No line on this statement backs the confirmed amount for bill BILL-2026-0001.",
        billId: "bill-1",
        billNumber: "BILL-2026-0001",
      });
    });

    it("OVER_LINE carries the confirmed amount and the statement line's amount as numbers", async () => {
      prisma.vendorBill.findMany.mockResolvedValue([vendorBill({ totalOwed: D(500) })]);
      prisma.vendorBill.findUnique.mockResolvedValue(vendorBill({ totalOwed: D(500) }));
      expect(await refusal(confirm(150))).toEqual({
        code: "STATEMENT_APPLY_OVER_LINE",
        message:
          "Confirmed amount 150.00 for bill BILL-2026-0001 exceeds the statement's own line of 100.00.",
        billId: "bill-1",
        billNumber: "BILL-2026-0001",
        amount: 150,
        lineAmount: 100,
      });
    });

    it("OVER_BALANCE carries the confirmed amount and the remaining balance as numbers", async () => {
      prisma.vendorBill.findMany.mockResolvedValue([vendorBill()]);
      prisma.vendorBill.findUnique.mockResolvedValue(vendorBill({ payments: [{ amount: D(60) }] }));
      expect(await refusal(confirm(90))).toEqual({
        code: "STATEMENT_APPLY_OVER_BALANCE",
        message:
          "Confirmed amount 90.00 for bill BILL-2026-0001 exceeds its remaining balance of 40.00.",
        billId: "bill-1",
        billNumber: "BILL-2026-0001",
        amount: 90,
        remaining: 40,
      });
    });

    it("another tenant's (or any unknown) bill id is the UNCODED 404, never a coded 400 carrying its fields", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(null);
      for (const dto of [confirm(), implied]) {
        const err: any = await service.applyStatement("scan-1", dto, user).catch((e) => e);
        expect(err).toBeInstanceOf(NotFoundException);
        const body = err.getResponse() as Record<string, unknown>;
        expect(body).not.toHaveProperty("code");
        expect(body).not.toHaveProperty("billNumber");
        expect(JSON.stringify(body)).toBe(
          JSON.stringify({ message: "Bill bill-1 not found", error: "Not Found", statusCode: 404 }),
        );
      }
    });
  });

  it("source order pin: in both loops the not-found 404 is thrown BEFORE any coded refusal reads the bill", () => {
    const src = fs.readFileSync(path.join(__dirname, "statement-apply.service.ts"), "utf8");
    const notFound = [...src.matchAll(/if \(!bill\) throw new NotFoundException/g)].map(
      (m) => m.index!,
    );
    const coded = [
      ...src.matchAll(
        /STATEMENT_APPLY_(?:WRONG_SUPPLIER|BILL_VOID|BILL_DRAFT|NO_BACKING_LINE|OVER_LINE|OVER_BALANCE)/g,
      ),
    ].map((m) => m.index!);
    expect(notFound.length).toBe(2);
    expect(coded.length).toBeGreaterThanOrEqual(8);
    expect(Math.min(...coded)).toBeGreaterThan(notFound[0]);
    // the second loop's refusals (after the second not-found) exist too
    expect(coded.some((i) => i > notFound[1])).toBe(true);
  });

  it("the request-echo billId on DUPLICATE_BILL is commented as such in the source", () => {
    const src = fs.readFileSync(path.join(__dirname, "statement-apply.service.ts"), "utf8");
    expect(src).toMatch(
      /REQUEST ECHO[\s\S]{0,300}STATEMENT_APPLY_DUPLICATE_BILL|STATEMENT_APPLY_DUPLICATE_BILL[\s\S]{0,300}REQUEST ECHO/,
    );
  });
});
