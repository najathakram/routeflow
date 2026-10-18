/**
 * B1036 / SA-814 R4-1 — ONE predicate chooses whose edit lines resolve the customer's tier and
 * customer-typed layer: `linesPriceAtCustomerTier(user)` (driver-line-price.ts: staff or DRIVER). A role
 * test (`isStaffEdit ? tier : 1`) beside it is how a DRIVER's line silently billed LIST for years, and how
 * the next gate would drift again. Only the right to TYPE a price stays a staff test, so those gates
 * (`isStaffEdit && item.unitPrice != null ? Number(...) : null`) are deliberately allowed.
 *
 * The scan reads every non-spec source under orders/**, strips comments, and for each staff-role flag finds
 * the ternary that flag opens (stopping at the statement's `;`, `{` or `}`); it is a violation when that
 * ternary's branches name a tier or a layer.
 */
import * as fs from "fs";
import * as path from "path";

const STAFF_FLAG = /\b(isStaffEdit|isStaffCaller|isStaffRole|isStaff)\b/g;
// a real ternary `?`, not `?.` / `??` / the second half of `??`
const TERNARY_Q = /(?<![?])\?(?![?.])/;

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Each staff-role ternary whose branches choose a tier or a layer. */
export function staffTernariesChoosingTierOrLayer(source: string): string[] {
  const src = stripComments(source);
  const found: string[] = [];
  for (const m of src.matchAll(STAFF_FLAG)) {
    const rest = src.slice(m.index);
    const end = rest.search(/[;{}]/);
    const stmt = end === -1 ? rest : rest.slice(0, end);
    const q = stmt.search(TERNARY_Q);
    if (q === -1) continue;
    const branches = stmt.slice(q);
    if (/tier|layer/i.test(branches)) found.push(stmt.replace(/\s+/g, " ").trim());
  }
  return found;
}

function sourcesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) return sourcesUnder(abs);
    return /\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name) ? [abs] : [];
  });
}

const ORDERS_DIR = __dirname;
const read = (rel: string) => fs.readFileSync(path.join(ORDERS_DIR, rel), "utf8");

describe("B1036: only linesPriceAtCustomerTier chooses a tier or a layer in orders/**", () => {
  it("the detector flags a role-chosen tier / layer and ignores the typed-price gate (it can see)", () => {
    expect(
      staffTernariesChoosingTierOrLayer(
        "const tierForProduct = isStaffEdit ? (cp.get(id) ?? operatorDefaultTier) : 1;",
      ),
    ).toHaveLength(1);
    expect(
      staffTernariesChoosingTierOrLayer(
        "const layerSub = isStaffCaller ? operatorPc.layer(product) : null;",
      ),
    ).toHaveLength(1);
    expect(
      staffTernariesChoosingTierOrLayer(
        "const tierForProduct =\n isStaffEdit && li.productId\n ? operatorCpMap.get(li.productId)\n : 1;",
      ),
    ).toHaveLength(1);
    expect(
      staffTernariesChoosingTierOrLayer(
        "const overridePrice = isStaffEdit && item.unitPrice != null ? Number(item.unitPrice) : null;\n" +
          "const layerSub = tierCaller ? operatorPc.layer(product) : null;",
      ),
    ).toEqual([]);
    expect(
      staffTernariesChoosingTierOrLayer(
        "const applied = isStaffRole ? dto.appliedCreditNotes : undefined;",
      ),
    ).toEqual([]);
  });

  it("no staff-role ternary under orders/** chooses a tier or a layer", () => {
    const offenders = sourcesUnder(ORDERS_DIR).flatMap((abs) =>
      staffTernariesChoosingTierOrLayer(fs.readFileSync(abs, "utf8")).map(
        (stmt) => `${path.relative(ORDERS_DIR, abs)}: ${stmt}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("the edit-items gates read the predicate: updateOrderItems, the replace-all builder and priceReplacedLine", () => {
    const service = read("orders.service.ts");
    expect(service).toContain("const tierCaller = linesPriceAtCustomerTier(user);");
    expect(service).not.toMatch(/\bisStaffCaller\b/);
    // the diff add, the substitute, the qty-edit layer and the staff replace-all builder all read it
    expect(service.match(/\btierCaller\b/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
    const builder = read("replace-all-line-build.ts");
    expect(builder).not.toMatch(/\bisStaffEdit\b/);
    expect(builder).toMatch(/ctx\.atCustomerTier/);
    expect(read("buyer-replace-keep.ts")).toMatch(/linesPriceAtCustomerTier\(a\.user\)/);
  });

  it("the predicate itself is staff or DRIVER and nothing else (a buyer / carrier / no principal is not)", () => {
    const { linesPriceAtCustomerTier } = jest.requireActual("./driver-line-price");
    expect(linesPriceAtCustomerTier({ role: "OPERATOR" })).toBe(true);
    expect(linesPriceAtCustomerTier({ role: "TENANT_ADMIN" })).toBe(true);
    expect(linesPriceAtCustomerTier({ role: "DRIVER" })).toBe(true);
    expect(linesPriceAtCustomerTier({ role: "CUSTOMER" })).toBe(false);
    expect(linesPriceAtCustomerTier(undefined)).toBe(false);
  });
});
