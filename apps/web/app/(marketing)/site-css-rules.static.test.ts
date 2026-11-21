/**
 * @jest-environment node
 */
// The shared site CSS reader (SA-1203 A20): what it reads, what it refuses, and the inventory of the other
// hand-written CSS rule readers that still exist (R9).
import * as fs from "fs";
import * as path from "path";
import { KNOWN_AT_RULES, readCss, readStyleAttr } from "./site-css-rules";

describe("site-css-rules: one postcss reader that fails closed", () => {
  it("knows exactly five at-rules, and every other one is a problem with its file:line", () => {
    expect([...KNOWN_AT_RULES]).toEqual(["media", "supports", "keyframes", "font-face", "charset"]);
    for (const at of ["@layer x{.a{color:red}}", "@import 'a.css';", "@scope (.a){.b{color:red}}"])
      expect(readCss(at, "f.css").problems.join()).toMatch(/unknown at-rule @\w+ at f\.css:1/);
  });

  it("keeps the at-rule chain, and keys a keyframe by its name and frame", () => {
    const r = readCss(
      "@media (min-width: 1px) { @supports (display:grid) { .a { color: red } } }" +
        "@keyframes k { 50% { color: blue } }",
      "f.css",
    );
    expect(r.decls.map((d) => [d.at, d.selectors.join(), d.prop])).toEqual([
      ["@media (min-width: 1px) > @supports (display:grid)", ".a", "color"],
      ["@keyframes k", "50%", "color"],
    ]);
  });

  it("reads a value with a ; inside a string, !important, and a repeated property in one rule", () => {
    const r = readCss('.a{background:url("a;b.png");color:red!important;color:blue}', "f.css");
    expect(r.decls.map((d) => [d.prop, d.value, d.important])).toEqual([
      ["background", 'url("a;b.png")', false],
      ["color", "red", true],
      ["color", "blue", false],
    ]);
    expect(r.rules).toHaveLength(2);
  });

  it("reads @font-face as one rule, allows @charset, and refuses a nested rule", () => {
    expect(
      readCss('@charset "utf-8"; @font-face{src:url(a.woff)}', "f.css").rules[0].selectors,
    ).toEqual(["@font-face"]);
    expect(readCss(".a{.b{color:red}}", "f.css").problems.join()).toContain(
      "nested rule at f.css:1",
    );
  });

  it("reads a style attribute as one rule", () => {
    expect(readStyleAttr("fill:red; stroke:blue", "p.html").rules[0].decls).toEqual({
      fill: "red",
      stroke: "blue",
    });
  });

  it("reports a syntax error instead of throwing", () => {
    expect(readCss(".a{color:red", "f.css").problems.join()).toContain("css syntax error at f.css");
  });
});

// R9: the other hand-written CSS rule readers. They are not moved in this lane; their number only goes down.
const declaresRulesOf = (text: string) => /(?:const|let|function)\s+rulesOf\b/.test(text);

describe("site-css-rules: the hand-written rule readers that remain (SA-1203 A20 R9)", () => {
  const dir = __dirname;
  const inventory = () =>
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => declaresRulesOf(fs.readFileSync(path.join(dir, f), "utf8")))
      .sort();

  it("exactly three files declare their own reader, and a fourth is red", () => {
    expect(inventory()).toEqual([
      "site-home-w3.static.test.ts",
      "site-landing-seam.static.test.ts",
      "site-w2-css.static.test.ts",
    ]);
  });

  it("X9: a file that declares a fourth reader is found", () => {
    expect(declaresRulesOf("const " + "rulesOf = (css: string) => []")).toBe(true);
    expect(declaresRulesOf("function " + "rulesOf(css) {}")).toBe(true);
    expect(declaresRulesOf("const cssRulesOf = readCss")).toBe(false);
  });
});

describe("site-css-rules: an escape beside a /* is still found (SA-1203 A24 M1)", () => {
  // inside an unquoted url(...) a /* is plain text to a browser, so it must never hide an escape
  const forms = [
    ".zz{background:url(x/*) var(\\2d\\2drf-copper)}",
    ".zz{background:url(x/*) var(\\2d\\2drf-copper) url(y*/)}",
    '.zz{background:url("x/*") var(\\2d\\2drf-copper)}',
  ];
  it.each(forms)("%s is red", (css) => {
    expect(readCss(css, "f.css").problems.join()).toContain("rule=escape-outside-string");
  });
  it("a comment with a quote and no escape is green, and a quoted escape is green", () => {
    expect(readCss('.zz{color:var(/*"*/--x)}', "f.css").problems).toEqual([]);
    expect(readCss('.zz::after{content:"\\201C"}', "f.css").problems).toEqual([]);
  });
});
