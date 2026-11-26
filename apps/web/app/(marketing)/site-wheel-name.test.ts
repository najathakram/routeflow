/**
 * @jest-environment jsdom
 */
// Lane 2.2 fix round (S7): the wheel script takes its name from the page's og:site_name. A name with markup in
// it is escaped before it goes into the wheel's markup, and a page with no name leaves its own still alone
// (the script never builds "in , start to finish"). The script is run for real against a jsdom page.
import * as fs from "fs";
import * as path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../public/site/graphics/rf-wheel-up.js"),
  "utf8",
);

type Wheel = { staticHTML(): string; mount(el: HTMLElement): unknown };

/** Runs the script on a fresh page whose og:site_name is `name` (null: no meta tag at all). */
function load(name: string | null): Wheel {
  document.head.innerHTML = name === null ? "" : `<meta property="og:site_name" content="">`;
  if (name !== null) {
    document.head.querySelector("meta")!.setAttribute("content", name);
  }
  document.body.innerHTML = "";
  delete (window as unknown as { RFWheel?: Wheel }).RFWheel;
  new Function(SRC).call(window);
  const w = (window as unknown as { RFWheel?: Wheel }).RFWheel;
  if (!w) throw new Error("rf-wheel-up.js did not register RFWheel");
  return w;
}

describe("the wheel's name: escaped, and never empty in a sentence", () => {
  it("a name with markup in it is escaped in the still's sub line and the dial's label", () => {
    const html = load(`A<b>&"'x`).staticHTML();
    expect(html).not.toContain("<b>");
    expect(html).toContain("A&lt;b&gt;&amp;&quot;&#39;x");
    // every attribute the name sits in is still well formed: the aria-label holds the escaped name, once
    expect(html.match(/aria-label="The A&lt;b&gt;&amp;&quot;&#39;x wheel:/g)).toHaveLength(1);
  });

  it("a plain name comes through unchanged", () => {
    const html = load("Acme").staticHTML();
    expect(html).toContain("You do every step in Acme, start to finish.");
  });

  it.each([
    ["an empty og:site_name", ""],
    ["no og:site_name", null],
  ])("%s: mount leaves the page's own still as it was", (_label, name) => {
    const w = load(name);
    const el = document.createElement("div");
    el.setAttribute("data-scene", "wheel");
    el.className = "rfw rfw--static";
    el.innerHTML = "<p>the page's still</p>";
    document.body.appendChild(el);
    expect(() => w.mount(el)).not.toThrow();
    expect(el.innerHTML).toBe("<p>the page's still</p>");
    expect(el.className).toBe("rfw rfw--static");
  });
});
