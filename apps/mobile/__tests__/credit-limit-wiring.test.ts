import { readFileSync } from "fs";
import { join } from "path";

// RN screens aren't renderable in this jest lane (pure-logic only), so the wiring is source-pinned:
// each screen that can receive the credit 409 must route it to the guard modal, not a bare toast.
// (parseCreditLimitError itself is covered in credit-limit-error.test.ts.)
describe("CREDIT_LIMIT_EXCEEDED reaches the guard modal", () => {
  it.each([
    "app/(operator)/(tabs)/orders/[id]/edit-items.tsx",
    "app/(operator)/(tabs)/orders/[id].tsx",
  ])("%s", (rel) => {
    const src = readFileSync(join(__dirname, "..", rel), "utf8");
    expect(src).toMatch(/parseCreditLimitError\(\w+\)/);
    expect(src).toMatch(/setCreditBlock\((?!null)\w+\)/);
    expect(src).toMatch(/<CreditLimitGuardModal[\s\S]*?open=\{!!creditBlock\}/);
  });

  it("the order detail parses the credit 409 BEFORE the generic toast fallthrough", () => {
    const src = readFileSync(
      join(__dirname, "..", "app/(operator)/(tabs)/orders/[id].tsx"),
      "utf8",
    );
    const at = src.indexOf("const toastError");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("showToast(", at));
    expect(body).toMatch(/parseCreditLimitError/);
  });
});
