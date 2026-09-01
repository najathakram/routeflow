import { plainToInstance } from "class-transformer";
import { validateSync, ValidationError } from "class-validator";
import { CompleteWithPaymentDto } from "./complete-with-payment.dto";

/**
 * T-B148a / R3 / REG-B148 — the global ValidationPipe (main.ts:180-186) runs
 * `whitelist: true, forbidNonWhitelisted: true`. Mobile sends `productId` on
 * every delivery line (payment.tsx:196-223; short-pick.ts:91-107) but
 * `RunDeliveryDto` never declared it, so class-validator's own whitelist
 * recursion strips/rejects it on every at-door completion. This replicates
 * exactly what the pipe runs — plainToInstance + validateSync with the same
 * options — against the real DTO classes, no mocking.
 */
describe("CompleteWithPaymentDto — deliveries[].productId whitelisting (T-B148a / R3 / REG-B148)", () => {
  const VALIDATE_OPTS = { whitelist: true, forbidNonWhitelisted: true };

  // A realistic mobile at-door payload: driver note, POD-adjacent fields
  // omitted (optional), two delivered lines each carrying productId, and a
  // CASH payment — the exact shape payment.tsx posts today.
  const realisticPayload = () => ({
    driverNote: "Left at front door",
    deliveries: [
      { orderItemId: "oi-1", productId: "prod-1", type: "DELIVERED", quantityDelivered: 3 },
      { orderItemId: "oi-2", productId: "prod-2", type: "DELIVERED", quantityDelivered: 1 },
    ],
    payment: { amount: 42.5, method: "CASH" },
  });

  /** Flatten class-validator's nested ValidationError tree to leaf property names. */
  const leafProperties = (errors: ValidationError[]): string[] => {
    const props: string[] = [];
    for (const e of errors) {
      if (e.constraints) props.push(e.property);
      if (e.children && e.children.length > 0) props.push(...leafProperties(e.children));
    }
    return props;
  };

  it("REG-B148: a realistic mobile payload with deliveries[].productId produces ZERO validation errors", () => {
    const dto = plainToInstance(CompleteWithPaymentDto, realisticPayload());

    const errors = validateSync(dto, VALIDATE_OPTS);

    // Today: RunDeliveryDto has no productId, so whitelist strips it and
    // forbidNonWhitelisted rejects it — this is red until R3 lands.
    expect(errors).toHaveLength(0);
  });

  it("REG-B148: an actually-unknown key on a delivery is still rejected — the fix does not widen the guard", () => {
    const payload = realisticPayload();
    (payload.deliveries[0] as any).bogus = "nope";
    const dto = plainToInstance(CompleteWithPaymentDto, payload);

    const errors = validateSync(dto, VALIDATE_OPTS);
    const flagged = leafProperties(errors);

    // Today BOTH "productId" and "bogus" are flagged (productId isn't whitelisted
    // yet), so the "productId absent" half of this assertion is what's red now.
    // Post-fix only "bogus" — a real unknown key — should ever be flagged.
    expect(flagged).toContain("bogus");
    expect(flagged).not.toContain("productId");
  });
});
