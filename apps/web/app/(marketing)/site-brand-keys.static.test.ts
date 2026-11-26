/**
 * @jest-environment node
 */
// SA-1178 A2 K4: the keys whose target does not exist yet (the addresses, the mark files and the legal
// entity) are byte-identical to their value at the lane base, and the two name keys are back on today's name (the new one is the `site` overlay). It fails
// if a lane moves an address or a mark early. The switch commit deletes this test with the key changes.
import { execFileSync } from "child_process";
import * as path from "path";
import { BRAND } from "@routeflow/types/brand";

const BASE = "c8690bbb1f";
const REPO = path.resolve(__dirname, "../../../..");

const base = JSON.parse(
  execFileSync("git", ["show", `${BASE}:packages/types/brand/brand.json`], {
    cwd: REPO,
    encoding: "utf8",
  }),
) as Record<string, unknown>;

/** Dotted paths of every leaf in the brand object. */
function leaves(value: unknown, prefix = ""): Array<[string, unknown]> {
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, value]];
}
const pick = (obj: unknown, dotted: string): unknown =>
  dotted.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);

const HELD = [
  "origin",
  "oldOrigin",
  "email",
  "securityEmail",
  "legalEntity",
  "symbol",
  "symbolOnDark",
  "emailLogo",
  "emailLogoWidth",
  "emailLogoHeight",
  ...leaves(base.logo, "logo").map(([k]) => k),
  ...leaves(base.icon, "icon").map(([k]) => k),
];

describe("brand keys held until switch day", () => {
  it("reads a base file with every held key present", () => {
    expect(HELD.length).toBe(17);
    for (const key of HELD) expect(pick(base, key)).toBeDefined();
  });

  it.each(HELD)("%s is byte-identical to the base", (key) => {
    expect(pick(BRAND, key)).toBe(pick(base, key));
  });

  // SA-1253 C3: the two name keys are back on today's value at the top level; the new name lives in
  // the `site` overlay (site-overlay.static.test.ts pins it).
  it.each(["name", "officialName"])("%s is today's name at the top level", (key) => {
    expect(pick(BRAND, key)).toBe(pick(base, "name"));
  });

  it("formerly holds the base name, so the structured data can list it", () => {
    expect(BRAND.formerly).toBe(base.name);
  });
});
