import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { QuoteInlineReturnDto } from "./quote-inline-return.dto";

const VALID_BASE = {
  customerId: "cust-1",
  items: [{ productId: "prod-1", qty: 1, boxes: 0, pieces: 5 }],
};

async function errorsFor(payload: unknown) {
  const dto = plainToInstance(QuoteInlineReturnDto, payload);
  return validate(dto);
}

describe("QuoteInlineReturnDto — SA-128/B814: boxes/pieces required, bare qty retired", () => {
  it("accepts a well-formed payload", async () => {
    expect(await errorsFor(VALID_BASE)).toHaveLength(0);
  });

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

  it("accepts qty omitted entirely, once boxes/pieces are present", async () => {
    const errors = await errorsFor({
      ...VALID_BASE,
      items: [{ productId: "prod-1", boxes: 0, pieces: 5 }],
    });
    expect(errors).toHaveLength(0);
  });

  it("REJECTS negative boxes/pieces", async () => {
    const errors = await errorsFor({
      ...VALID_BASE,
      items: [{ productId: "prod-1", boxes: -1, pieces: 5 }],
    });
    const itemErrors = errors.find((e) => e.property === "items")?.children?.[0]?.children ?? [];
    expect(itemErrors.some((e) => e.property === "boxes")).toBe(true);
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
      QuoteInlineReturnDto,
      withOverride({ creditUnitPrice: 1, overrideReason: " dented " }),
    );
    expect((dto.items[0] as { overrideReason?: string }).overrideReason).toBe("dented");
  });
});
