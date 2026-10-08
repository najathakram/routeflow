/**
 * #3295 contract: the app-wide ValidationPipe is whitelist + transform + forbidNonWhitelisted (main.ts), so a field the DTO
 * does not declare is a 400. The web sends `resolution` on the capture and { tender, expectedAmount, reason } on the refund:
 * pinned here through the REAL pipe with the app's own options.
 */
import "reflect-metadata";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { CaptureInlineReturnDto } from "./dto/capture-inline-return.dto";
import { RefundInlineReturnDto } from "./dto/refund-inline-return.dto";

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
