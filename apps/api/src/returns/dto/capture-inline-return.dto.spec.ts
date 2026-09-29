/**
 * Re-review LOW: `returnKey` is now REQUIRED on `CaptureInlineReturnDto` — no client calls
 * `POST /returns/inline/capture` yet, so every capture must be replay-safe from day one
 * rather than an unkeyed capture ever being possible to opt out of.
 */
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CaptureInlineReturnDto } from "./capture-inline-return.dto";

const VALID_BASE = {
  customerId: "cust-1",
  orderId: "ord-1",
  items: [{ productId: "prod-1", qty: 1, boxes: 0, pieces: 5 }],
  returnKey: "nonce-1",
};

async function errorsFor(payload: unknown) {
  const dto = plainToInstance(CaptureInlineReturnDto, payload);
  return validate(dto);
}

describe("CaptureInlineReturnDto — returnKey is required", () => {
  it("accepts a payload with returnKey present", async () => {
    expect(await errorsFor(VALID_BASE)).toHaveLength(0);
  });

  it("REJECTS a payload with returnKey omitted", async () => {
    const { returnKey: _omit, ...withoutKey } = VALID_BASE;
    const errors = await errorsFor(withoutKey);
    expect(errors.some((e) => e.property === "returnKey")).toBe(true);
  });

  it("REJECTS an empty-string returnKey", async () => {
    const errors = await errorsFor({ ...VALID_BASE, returnKey: "" });
    expect(errors.some((e) => e.property === "returnKey")).toBe(true);
  });
});

describe("CaptureInlineReturnDto — SA-128/B814: boxes/pieces required, bare qty retired", () => {
  it("REJECTS a bare-qty item ({ productId, qty: 5 }), naming boxes and pieces", async () => {
    const errors = await errorsFor({
      ...VALID_BASE,
      items: [{ productId: "prod-1", qty: 5 }],
    });
    const itemErrors = errors.find((e) => e.property === "items")?.children?.[0]?.children ?? [];
    const properties = itemErrors.map((e) => e.property);
    expect(properties).toEqual(expect.arrayContaining(["boxes", "pieces"]));
  });

  it("REJECTS { boxes: 0, pieces: 0 } (nothing to return)", async () => {
    const errors = await errorsFor({
      ...VALID_BASE,
      items: [{ productId: "prod-1", qty: 1, boxes: 0, pieces: 0 }],
    });
    const itemErrors = errors.find((e) => e.property === "items")?.children?.[0]?.children ?? [];
    expect(itemErrors.some((e) => e.constraints?.requireBoxesOrPiecesPositive)).toBe(true);
  });

  it("accepts { boxes: 0, pieces: 5 } — pieces-only is a legitimate split", async () => {
    const errors = await errorsFor({
      ...VALID_BASE,
      items: [{ productId: "prod-1", qty: 1, boxes: 0, pieces: 5 }],
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts { boxes: 1, pieces: 0 } — pack resolution is a service-level (409) concern, not a DTO one", async () => {
    const errors = await errorsFor({
      ...VALID_BASE,
      items: [{ productId: "prod-1", qty: 1, boxes: 1, pieces: 0 }],
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts a bare-qty item's qty being omitted entirely, once boxes/pieces are present", async () => {
    const errors = await errorsFor({
      ...VALID_BASE,
      items: [{ productId: "prod-1", boxes: 0, pieces: 5 }],
    });
    expect(errors).toHaveLength(0);
  });
});

describe("#2695: the credit price override fields", () => {
  const withOverride = (item: Record<string, unknown>) => ({
    ...VALID_BASE,
    items: [{ ...VALID_BASE.items[0], ...item }],
  });

  it("accepts whole-cent prices that are inexact in floats (19.99, 1.10, 0.07)", async () => {
    for (const creditUnitPrice of [19.99, 1.1, 0.07, 0]) {
      expect(await errorsFor(withOverride({ creditUnitPrice, overrideReason: "x" }))).toHaveLength(
        0,
      );
    }
  });

  it("trims the reason BEFORE the 200-char limit, and stores it trimmed", async () => {
    const padded = `  ${"x".repeat(200)}  `;
    expect(
      await errorsFor(withOverride({ creditUnitPrice: 1, overrideReason: padded })),
    ).toHaveLength(0);
    expect(
      await errorsFor(withOverride({ creditUnitPrice: 1, overrideReason: "x".repeat(201) })),
    ).not.toHaveLength(0);
    const dto = plainToInstance(
      CaptureInlineReturnDto,
      withOverride({ creditUnitPrice: 1, overrideReason: " dented " }),
    );
    expect((dto.items[0] as { overrideReason?: string }).overrideReason).toBe("dented");
  });
});
