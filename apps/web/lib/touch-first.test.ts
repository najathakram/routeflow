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

  it("sets 16px on input, textarea and select", () => {
    expect(block).toMatch(
      /input:not\([\s\S]*?\),\s+textarea,\s+select\s+\{\s+font-size: 16px !important;/,
    );
  });

  it("leaves out exactly the types that take no typing", () => {
    const excluded = /input:not\(([\s\S]*?)\),/.exec(block)?.[1] ?? "";
    expect([...excluded.matchAll(/\[type="([a-z]+)"\]/g)].map((m) => m[1])).toEqual([
      "checkbox",
      "radio",
      "range",
      "file",
      "color",
      "hidden",
      "button",
      "submit",
      "reset",
    ]);
  });

  it("the invoice line's touch-only classes use the same query", () => {
    const page = fs.readFileSync(
      path.resolve(__dirname, "../app/(dashboard)/invoices/new/page.tsx"),
      "utf8",
    );
    const variant = `[@media${TOUCH_FIRST_QUERY.replace(/: /g, ":").replace(/ /g, "_")}]`;
    expect(page.split(`${variant}:w-11`)).toHaveLength(3); // boxes and pieces
    expect(page).toContain(`${variant}:flex-wrap`);
  });
});
