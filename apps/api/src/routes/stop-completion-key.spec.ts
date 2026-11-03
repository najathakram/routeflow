import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { stopCompletionRequestHash } from "./stop-completion-key";

const line = (over: Record<string, unknown> = {}) => ({
  orderItemId: "a",
  type: "DELIVERED",
  quantityDelivered: 10,
  ...over,
});
const dto = (over: Record<string, unknown> = {}) =>
  ({
    deliveries: [line(), line({ orderItemId: "b", quantityDelivered: 4 })],
    payment: { amount: 120, method: "CASH" },
    ...over,
  }) as never;

describe("stopCompletionRequestHash (SA-953 S1)", () => {
  const base = stopCompletionRequestHash(dto());

  it.each([
    ["a changed quantity", { deliveries: [line({ quantityDelivered: 7 })] }],
    ["a changed type", { deliveries: [line({ type: "REFUSED" }), line({ orderItemId: "b" })] }],
    ["a quantity moved to another line", { deliveries: [line(), line({ orderItemId: "c" })] }],
    ["a changed product", { deliveries: [line({ productId: "p2" }), line({ orderItemId: "b" })] }],
    ["a changed amount", { payment: { amount: 120.01, method: "CASH" } }],
    ["a changed method", { payment: { amount: 120, method: "CHECK" } }],
    ["a changed invoice", { payment: { amount: 120, method: "CASH", invoiceId: "i" } }],
    ["no payment", { payment: undefined }],
  ])("%s is a different request", (_name, over) => {
    expect(stopCompletionRequestHash(dto(over))).not.toBe(base);
  });

  it.each([
    [
      "the lines in another order",
      { deliveries: [line({ orderItemId: "b", quantityDelivered: 4 }), line()] },
    ],
    ["the method in another case", { payment: { amount: 120, method: "cash" } }],
    ["the same cents written differently", { payment: { amount: 120.0, method: "CASH" } }],
    ["a driver note", { driverNote: "left at the side door" }],
    ["a signature", { signatureUrl: "data:image/png;base64,AAAA" }],
    ["photos", { podPhotoUrls: ["data:image/png;base64,AAAA"] }],
    ["a safe drop", { safeDropEnabled: true }],
    ["age and ID evidence", { ageVerified: true, identityVerified: true, identityType: "DL" }],
    ["the key", { idempotencyKey: "another" }],
  ])("%s is the same request", (_name, over) => {
    expect(stopCompletionRequestHash(dto(over))).toBe(base);
  });

  it("a line's note is the same request", () => {
    const noted = dto({
      deliveries: [line({ note: "dented" }), line({ orderItemId: "b", quantityDelivered: 4 })],
    });
    expect(stopCompletionRequestHash(noted)).toBe(base);
  });

  it("no deliveries and an empty list are the same request", () => {
    expect(stopCompletionRequestHash({ deliveries: [] } as never)).toBe(
      stopCompletionRequestHash({} as never),
    );
  });

  it("amounts compare in cents, so a float's tail is the same request", () => {
    expect(stopCompletionRequestHash(dto({ payment: { amount: 0.1 + 0.2, method: "CASH" } }))).toBe(
      stopCompletionRequestHash(dto({ payment: { amount: 0.3, method: "CASH" } })),
    );
  });
});

describe("I-5 Pin. One model: RoutesService keeps no key code of its own (SA-953 S2)", () => {
  it("the private trio is gone", () => {
    const src = readFileSync(resolve(__dirname, "routes.service.ts"), "utf8");
    expect(existsSync(resolve(__dirname, "route-idempotency.ts"))).toBe(false);
    expect(src).not.toMatch(/route-idempotency|check\w*IdempotencyKey|save\w*IdempotencyKey/);
    expect(src).not.toMatch(/createHash\(|"IdempotencyKey"/);
    expect(src).toMatch(/from "\.\/stop-completion-key"/);
  });
});
