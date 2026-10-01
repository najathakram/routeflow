import { shouldDecode } from "./scan-mode";

describe("shouldDecode", () => {
  it("always decodes in continuous mode, held or not", () => {
    expect(shouldDecode("continuous", false)).toBe(true);
    expect(shouldDecode("continuous", true)).toBe(true);
  });

  it("only decodes in hold mode while the button is held", () => {
    expect(shouldDecode("hold", true)).toBe(true);
    expect(shouldDecode("hold", false)).toBe(false);
  });
});
