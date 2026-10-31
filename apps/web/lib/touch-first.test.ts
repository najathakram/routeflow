import { TOUCH_FIRST_QUERY, isTouchFirst } from "./touch-first";

/** SA-1059 MUST 5: touch-first is a media query, and anything short of a clear yes is a desktop till. */
const original = Object.getOwnPropertyDescriptor(window, "matchMedia");
afterEach(() => {
  if (original) Object.defineProperty(window, "matchMedia", original);
  else delete (window as unknown as Record<string, unknown>).matchMedia;
});
const stub = (fn: unknown) =>
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: fn });

describe("isTouchFirst", () => {
  it("asks for no hover AND a coarse pointer", () => {
    expect(TOUCH_FIRST_QUERY).toBe("(hover: none) and (pointer: coarse)");
    const mm = jest.fn().mockReturnValue({ matches: true });
    stub(mm);
    expect(isTouchFirst()).toBe(true);
    expect(mm).toHaveBeenCalledWith("(hover: none) and (pointer: coarse)");
  });

  it("is false when the query does not match (a mouse, or a laptop with a touch screen)", () => {
    stub(jest.fn().mockReturnValue({ matches: false }));
    expect(isTouchFirst()).toBe(false);
  });

  it("is false when matchMedia is missing (jsdom, an old browser)", () => {
    delete (window as unknown as Record<string, unknown>).matchMedia;
    expect(isTouchFirst()).toBe(false);
  });

  it("is false when matchMedia throws", () => {
    stub(() => {
      throw new Error("blocked");
    });
    expect(isTouchFirst()).toBe(false);
  });
});
