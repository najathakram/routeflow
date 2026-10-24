/**
 * #3295 contract: the app-wide ValidationPipe is whitelist + transform + forbidNonWhitelisted (main.ts), so a field the DTO
 * does not declare is a 400. The web sends `resolution` on the capture and { tender, expectedAmount, reason } on the refund:
 * pinned here through the REAL pipe with the app's own options.
 */
import "reflect-metadata";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { CaptureInlineReturnDto } from "./dto/capture-inline-return.dto";
import { RefundInlineReturnDto } from "./dto/refund-inline-return.dto";
import { ProcessRefundDto } from "./dto/process-refund.dto";
import { QuoteInlineReturnDto } from "./dto/quote-inline-return.dto";

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const run = (type: any, value: unknown) => pipe.transform(value, { type: "body", metatype: type });

const CAPTURE = {
  customerId: "c1",
  orderId: "o1",
  items: [{ productId: "p1", boxes: 0, pieces: 2 }],
  returnKey: "k1",
};

describe("CaptureInlineReturnDto through the app's ValidationPipe (forbidNonWhitelisted)", () => {
  it.each(["STORE_CREDIT", "REFUND"])("accepts resolution %s", async (resolution) => {
    const out: any = await run(CaptureInlineReturnDto, { ...CAPTURE, resolution });
    expect(out.resolution).toBe(resolution);
  });
  it("accepts an omitted resolution (today's behaviour)", async () => {
    const out: any = await run(CaptureInlineReturnDto, CAPTURE);
    expect(out.resolution).toBeUndefined();
  });
  it.each(["CASH", "refund", "", 1])("rejects resolution %p with a 400", async (resolution) => {
    await expect(run(CaptureInlineReturnDto, { ...CAPTURE, resolution })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it("still forbids an undeclared field", async () => {
    await expect(run(CaptureInlineReturnDto, { ...CAPTURE, bogus: 1 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("RefundInlineReturnDto through the app's ValidationPipe", () => {
  it("accepts {tender, expectedAmount, reason?}", async () => {
    const out: any = await run(RefundInlineReturnDto, {
      tender: "CARD",
      expectedAmount: 12.5,
      reason: "  changed mind ",
    });
    expect(out).toMatchObject({ tender: "CARD", expectedAmount: 12.5, reason: "changed mind" });
    await expect(
      run(RefundInlineReturnDto, { tender: "CASH", expectedAmount: 1 }),
    ).resolves.toBeDefined();
  });
  it.each([
    { tender: "WIRE", expectedAmount: 1 },
    { tender: "CASH" },
    { tender: "CASH", expectedAmount: 0 },
    { tender: "CASH", expectedAmount: 1.005 },
    { tender: "CASH", expectedAmount: "1" },
    { tender: "CASH", expectedAmount: 1, extra: true },
    { tender: "CASH", expectedAmount: 1, reason: "x".repeat(201) },
  ])("rejects %j with a 400", async (body) => {
    await expect(run(RefundInlineReturnDto, body)).rejects.toBeInstanceOf(BadRequestException);
  });
});

// SA-740: the source sale rides on the quote and the capture, and the STANDARD refund takes an optional tender.
describe("SA-740 DTO fields through the app's ValidationPipe", () => {
  const QUOTE = { customerId: "c1", items: [{ productId: "p1", boxes: 0, pieces: 2 }] };

  it("capture and quote accept an optional sourceOrderId, and reject an empty or non-string one", async () => {
    expect(
      ((await run(CaptureInlineReturnDto, { ...CAPTURE, sourceOrderId: "o9" })) as any)
        .sourceOrderId,
    ).toBe("o9");
    expect(
      ((await run(QuoteInlineReturnDto, { ...QUOTE, sourceOrderId: "o9" })) as any).sourceOrderId,
    ).toBe("o9");
    expect(((await run(QuoteInlineReturnDto, QUOTE)) as any).sourceOrderId).toBeUndefined();
    for (const bad of ["", 7]) {
      await expect(
        run(CaptureInlineReturnDto, { ...CAPTURE, sourceOrderId: bad }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        run(QuoteInlineReturnDto, { ...QUOTE, sourceOrderId: bad }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("ProcessRefundDto accepts method + an optional tender (CASH | CARD | CHECK) and the legacy restock flag", async () => {
    for (const tender of ["CASH", "CARD", "CHECK"]) {
      const out: any = await run(ProcessRefundDto, { method: "EXTERNAL_REFUND", tender });
      expect(out.tender).toBe(tender);
    }
    expect(
      ((await run(ProcessRefundDto, { method: "EXTERNAL_REFUND" })) as any).tender,
    ).toBeUndefined();
    await expect(run(ProcessRefundDto, { restock: true })).resolves.toBeDefined();
  });

  it.each(["ACH", "CREDIT_NOTE", "CREDIT_CARD", "cash", "", 1])(
    "ProcessRefundDto rejects tender %p with a 400",
    async (tender) => {
      await expect(
        run(ProcessRefundDto, { method: "EXTERNAL_REFUND", tender }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
});
