import * as fs from "fs";
import * as path from "path";
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

/** SA-1071 A-2: the iOS zoom rule in `globals.css` keys on the same query, so the two can't drift. */
describe("the 16px field rule", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");
  const block = css.slice(css.indexOf("iOS zooms into a focused field"));

  it("sits under TOUCH_FIRST_QUERY", () => {
    expect(block).toContain(`@media ${TOUCH_FIRST_QUERY} {`);
  });

  it("sets 16px on every text field, and leaves the controls that take no typing", () => {
    expect(block).toMatch(/textarea,\s+select\s+\{\s+font-size: 16px !important;/);
    for (const type of ["checkbox", "radio", "range", "file", "color", "hidden"])
      expect(block).toContain(`[type="${type}"]`);
  });
});
