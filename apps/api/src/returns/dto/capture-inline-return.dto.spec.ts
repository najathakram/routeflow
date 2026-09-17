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
  items: [{ productId: "prod-1", qty: 1 }],
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
