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

describe("no-JS hero width", () => {
  const hero =
    css.split("\n").find((l) => l.includes("html:not(.js-motion) .hx-up{display:grid")) ?? "";

  it("is capped at the content width, with fixed padding", () => {
    expect(hero).toContain("width:min(1200px,100% - 48px)");
    expect(hero).not.toContain("1640px");
    expect(/padding:([^;]+);/.exec(hero)?.[1] ?? "").not.toContain("%");
  });

  it("no site stylesheet pads with a percentage half-gap, (100% - Npx)/2", () => {
    const dir = path.resolve(__dirname, "../../public/site");
    for (const f of ["css", "graphics"]) {
      for (const name of fs.readdirSync(path.join(dir, f)).filter((n) => n.endsWith(".css"))) {
        const text = fs.readFileSync(path.join(dir, f, name), "utf8");
        expect(`${f}/${name}: ${/padding[^;{}]*\(100%\s*-[^;{}]*\)\s*\/\s*2/.test(text)}`).toBe(
          `${f}/${name}: false`,
        );
      }
    }
  });
});
