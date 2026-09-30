/**
 * WP6 T26: the acme state at the pinned clock renders byte-for-byte to fixtures/acme/golden/index.html.
 * The golden is generated once by the implementer with UPDATE_GOLDEN=1 and reviewed against ux-spec §3/§4.
 * Until then this spec is RED (file missing, renderer absent).
 */
import * as fs from "fs";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-explicit-any */
const GOLDEN = path.join(__dirname, "fixtures/acme/golden/index.html");
const state = (): any =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/acme/state.json"), "utf8"));

describe("T26 golden home page", () => {
  it("matches fixtures/acme/golden/index.html byte-for-byte", () => {
    const { renderPage } = require("../src/render/page");
    const html: string = renderPage(state(), { now: "2026-01-12T10:00:00Z" });
    if (process.env.UPDATE_GOLDEN === "1") {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, html);
    }
    expect(fs.existsSync(GOLDEN)).toBe(true);
    expect(html).toBe(fs.readFileSync(GOLDEN, "utf8"));
  });
  it("golden is non-trivial and contains all 12 panels", () => {
    expect(fs.existsSync(GOLDEN)).toBe(true);
    const g = fs.readFileSync(GOLDEN, "utf8");
    expect((g.match(/data-panel="/g) ?? []).length).toBe(12);
    expect(g).toContain("acme".charAt(0) === "a" ? "Acme invoice date fixes" : "");
  });
});
