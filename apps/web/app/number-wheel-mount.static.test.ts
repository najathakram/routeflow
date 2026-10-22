import { readFileSync } from "fs";
import { join } from "path";

/**
 * Row 697 guard: the wheel block is mounted ONCE, in the shell every route renders through, so a new
 * <input type="number"> anywhere in the app is covered with no per-component wiring. If this fails, someone
 * unmounted the helper (or bypassed Providers in the root layout) and every number input is silently wheel-
 * editable again.
 */
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("number-input wheel block is mounted in the root shell (row 697)", () => {
  it("the root layout renders every route inside <Providers>", () => {
    const layout = read("app/layout.tsx");
    expect(layout).toMatch(/import \{ Providers \} from "\.\/providers"/);
    expect(layout).toMatch(/<Providers>\{children\}<\/Providers>/);
  });

  it("Providers imports and renders <NoWheelNumberInputs />", () => {
    const providers = read("app/providers.tsx");
    expect(providers).toMatch(
      /import \{ NoWheelNumberInputs \} from "@\/components\/NoWheelNumberInputs"/,
    );
    expect(providers).toMatch(/<NoWheelNumberInputs \/>/);
  });

  it("the helper listens in the CAPTURE phase, non-passive, on the document", () => {
    const src = read("components/NoWheelNumberInputs.tsx");
    expect(src).toMatch(/document\.addEventListener\(\s*"wheel"/);
    expect(src).toMatch(/passive:\s*false/);
    expect(src).toMatch(/capture:\s*true/);
    expect(src).toMatch(/preventDefault\(\)/);
  });
});
