/**
 * @jest-environment node
 */
// The founder card must be as wide as the page content (1200px) and its padding must not use a
// percentage: a % padding resolves against the parent's width, so on a wide screen it squeezed the
// grid columns to ~380px each inside a 1640px card.
import * as fs from "fs";
import * as path from "path";

const css = fs.readFileSync(path.resolve(__dirname, "../../public/site/css/home-up.css"), "utf8");
const rule = css.split("\n").find((l) => l.startsWith("#founder .fd-in{")) ?? "";

describe("founder card width", () => {
  it("is capped at the content width and centred", () => {
    expect(rule).toContain("width:min(1200px,100% - 48px)");
    expect(rule).toContain("margin-inline:auto");
    expect(rule).not.toContain("1640px");
  });

  it("pads with a fixed clamp, never a percentage of the parent", () => {
    const pad = /padding:([^;]+);/.exec(rule)?.[1] ?? "";
    expect(pad).not.toContain("%");
  });
});
