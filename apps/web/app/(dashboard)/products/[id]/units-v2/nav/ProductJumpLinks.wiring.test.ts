import * as fs from "fs";
import * as path from "path";

/**
 * The page mounts the jump strip only on the v2 surface (flag on, not a family), and stays inside its
 * size-ratchet cap. This is the "flag off renders nothing" proof for the page-level mount.
 */
const PAGE = path.resolve(__dirname, "../../page.tsx");
const src = fs.readFileSync(PAGE, "utf8");

describe("products/[id]/page.tsx jump-links mount", () => {
  it("imports and mounts ProductJumpLinks exactly once", () => {
    expect(src.match(/<ProductJumpLinks\b/g)).toHaveLength(1);
    expect(src).toMatch(/from "\.\/units-v2\/nav\/ProductJumpLinks"/);
  });

  it("mounts it only behind the v2 condition, never for a family", () => {
    expect(src).toMatch(/\{v2 && product\.kind !== "FAMILY" \? <ProductJumpLinks \/> : null\}/);
  });

  it("stays under the size-ratchet cap of 2967 lines", () => {
    expect(src.split("\n").length).toBeLessThanOrEqual(2967);
  });
});
