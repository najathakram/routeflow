/**
 * Opus review (PR-1c BLOCK, HIGH-3): the controller used to bind approve's body as a bare
 * `{ amount?: number }` TYPE (erased at runtime, so `ValidationPipe` never validated it) — a
 * non-numeric or garbage `amount` (e.g. `"abc"`, which `roundMoney` turns into `NaN` → `0`)
 * sailed through, silently approving the hold for $0.00. This pins that `class-validator`
 * actually rejects the shapes that used to slip past.
 */
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ApproveInlineReturnDto } from "./approve-inline-return.dto";

async function errorsFor(payload: unknown) {
  const dto = plainToInstance(ApproveInlineReturnDto, payload);
  return validate(dto);
}

describe("ApproveInlineReturnDto (HIGH-3)", () => {
  it("accepts an omitted amount (approve the full held amount)", async () => {
    expect(await errorsFor({})).toHaveLength(0);
  });

  it("accepts a valid positive amount", async () => {
    expect(await errorsFor({ amount: 15.5 })).toHaveLength(0);
  });

  it("REJECTS a non-numeric amount — the exact HIGH-3 defect (a string that used to coerce to NaN→0)", async () => {
    const errors = await errorsFor({ amount: "abc" });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("amount");
  });

  it("REJECTS amount: 0 — a zero-dollar 'approval' must go through reject() instead", async () => {
    const errors = await errorsFor({ amount: 0 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("REJECTS a negative amount", async () => {
    const errors = await errorsFor({ amount: -5 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("REJECTS NaN explicitly (not just string coercion)", async () => {
    const errors = await errorsFor({ amount: NaN });
    expect(errors.length).toBeGreaterThan(0);
  });
});
