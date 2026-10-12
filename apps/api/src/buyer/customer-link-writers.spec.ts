import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * SA-776 GAP-2: a buyer-initiated change to what a buyer is linked to follows the seller's workspace status through
 * ONE rule (`buyer/seller-status-gate.ts` `sellerAcceptsBuyerWrite`). This walks the source tree with the compiler API
 * and classifies every write to the `customerLink` model: GATED (the method must call the shared function) or
 * ALLOWED with a reason. A NEW writer fails until somebody classifies it, so a new path that links a buyer to a seller
 * cannot ship without choosing between the shared rule and a written reason.
 */

const SRC_ROOT = path.resolve(__dirname, "..");
const VERBS = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);
/** Nested forms inside another model's data (`customerLink: { connect: ... }`): the writes plus relation edits. */
const NESTED_VERBS = new Set([...VERBS, "connect", "connectOrCreate", "set", "disconnect"]);
const GATE_FN = "sellerAcceptsBuyerWrite";

type Write = {
  key: string;
  method: string;
  callText: string;
  /** Start offsets (within the file) of every gate call in the enclosing method, and of this write. */
  gatePositions: number[];
  writePos: number;
};

/** Names a file binds to the customerLink delegate: `const l = db.customerLink`, `const { customerLink } = tx`. */
function delegateAliases(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const isDelegate = (e: ts.Expression | undefined): boolean =>
    !!e &&
    ((ts.isPropertyAccessExpression(e) && e.name.text === "customerLink") ||
      (ts.isNonNullExpression(e) && isDelegate(e.expression)) ||
      (ts.isParenthesizedExpression(e) && isDelegate(e.expression)));
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n)) {
      if (ts.isIdentifier(n.name) && isDelegate(n.initializer)) names.add(n.name.text);
      if (ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) {
          const source = (el.propertyName ?? el.name).getText(sf);
          if (source === "customerLink" && ts.isIdentifier(el.name)) names.add(el.name.text);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

/** Every `<x>.customerLink.<write>(...)` call (or one on an alias of the delegate), keyed file::method::verb#n. */
export function customerLinkWrites(source: string, file = "x.ts"): Write[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const aliases = delegateAliases(sf);
  const seen = new Map<string, number>();
  const out: Write[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const verb = n.expression.name.text;
      const target = n.expression.expression;
      const onDelegate =
        (ts.isPropertyAccessExpression(target) && target.name.text === "customerLink") ||
        (ts.isIdentifier(target) && (target.text === "customerLink" || aliases.has(target.text)));
      if (VERBS.has(verb) && onDelegate) {
        let method = "<module>";
        let scope: ts.Node = sf;
        for (let c: ts.Node | undefined = n.parent; c; c = c.parent) {
          if ((ts.isMethodDeclaration(c) || ts.isFunctionDeclaration(c)) && c.name) {
            method = c.name.getText(sf);
            scope = c;
            break;
          }
        }
        const gatePositions: number[] = [];
        const findGates = (g: ts.Node) => {
          if (
            ts.isCallExpression(g) &&
            ts.isIdentifier(g.expression) &&
            g.expression.text === GATE_FN
          )
            gatePositions.push(g.getStart(sf));
          ts.forEachChild(g, findGates);
        };
        findGates(scope);
        const base = `${file}::${method}::${verb}`;
        const i = seen.get(base) ?? 0;
        seen.set(base, i + 1);
        out.push({
          key: `${base}#${i}`,
          method,
          callText: n.getText(sf),
          gatePositions,
          writePos: n.getStart(sf),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Nested link writes (`customerLink: { create ... }` / `customerLinks: { ... }` inside another model's data). */
export function nestedCustomerLinkWrites(source: string, file = "x.ts"): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isPropertyAssignment(n) &&
      ["customerLink", "customerLinks"].includes(n.name.getText(sf)) &&
      ts.isObjectLiteralExpression(n.initializer) &&
      n.initializer.properties.some((p) => p.name && NESTED_VERBS.has(p.name.getText(sf)))
    )
      out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** What is wrong with one classified write, or null. */
export function writeProblem(
  row: Row,
  w: Pick<Write, "gatePositions" | "writePos">,
): string | null {
  if (row.kind === "GATED") {
    if (w.gatePositions.length === 0)
      return "is GATED but its method never calls sellerAcceptsBuyerWrite";
    return Math.min(...w.gatePositions) < w.writePos
      ? null
      : "is GATED but the gate call comes AFTER the write";
  }
  return row.why.trim().length > 0 ? null : "is ALLOWED without a reason";
}

type Row = { kind: "GATED" } | { kind: "ALLOWED"; why: string };
const G: Row = { kind: "GATED" };
const A = (why: string): Row => ({ kind: "ALLOWED", why });

const STAFF = A(
  "the seller's own staff acting on their own customer through a staff-JWT route (read-only registry / TenantStatusGuard governs it); not a buyer write",
);
const PLATFORM = A(
  "SUPER_ADMIN operator action on the platform-admin controller; not a buyer write",
);
const LEAVES = A(
  "the buyer ends or moves their OWN links (reduces access, never adds one); must stay possible whatever the seller's state",
);

const TABLE: Record<string, Row> = {
  // GATED: the buyer (or the buyer's sign-in) links itself to a seller.
  "auth/google-oauth.service.ts::acceptInviteToken::update#0": G,
  "buyer/buyer.service.ts::acceptInvite::update#0": G,
  "buyer/buyer.service.ts::requestSeller::upsert#0": G,
  "buyer/buyer.service.ts::requestSeller::update#0": G,
  "buyer/buyer.service.ts::requestSeller::upsert#1": G,
  // ALLOWED: the buyer leaves / merges their own accounts.
  "buyer/buyer.service.ts::disconnectSelf::update#0": LEAVES,
  "buyer/buyer-auth.service.ts::deleteAccount::updateMany#0": LEAVES,
  "buyer/buyer-merge.service.ts::executeMerge::updateMany#0": A(
    "re-points the buyer's EXISTING links from a merged secondary account to the primary (same person; no new seller access)",
  ),
  "buyer/buyer-merge.service.ts::executeMerge::updateMany#1": LEAVES,
  // ALLOWED: the seller's own staff.
  "buyer/buyer.service.ts::disconnectPortal::update#0": STAFF,
  "buyer/buyer.service.ts::approveBuyerRequest::update#0": STAFF,
  "customers/customers.service.ts::sendPortalInvite::upsert#0": STAFF,
  "customers/customers.service.ts::disconnectPortal::update#0": STAFF,
  "customers/customers.service.ts::approveBuyerRequest::update#0": STAFF,
  "customers/customers.service.ts::declineBuyerRequest::update#0": STAFF,
  "customers/customers.service.ts::declineBuyerRequest::delete#0": STAFF,
  "customers/customers.service.ts::mergeCustomers::updateMany#0": STAFF,
  "customers/customers.service.ts::mergeCustomers::deleteMany#0": STAFF,
  "customers/customers.service.ts::runImportedCustomersCleanup::deleteMany#0": A(
    "tenant-scoped cleanup of imported customers that have no ACTIVE buyer; env-gated, no controller reaches it; removes links only",
  ),
  // ALLOWED: the platform operator.
  "buyer/buyer-admin.service.ts::addBuyerLink::update#0": PLATFORM,
  "buyer/buyer-admin.service.ts::addBuyerLink::create#0": PLATFORM,
  "buyer/buyer-admin.service.ts::removeLink::update#0": PLATFORM,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") walk(full, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

const scanned = new Map<string, Write>();
const nested: string[] = [];
const rawSql: string[] = [];
for (const file of walk(SRC_ROOT)) {
  const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
  if (rel.startsWith("testing/")) continue; // the Prisma test double, not a writer
  const text = fs.readFileSync(file, "utf8");
  for (const w of customerLinkWrites(text, rel)) scanned.set(w.key, w);
  nested.push(...nestedCustomerLinkWrites(text, rel));
  if (/(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?CustomerLink"?/i.test(text)) rawSql.push(rel);
}
const show = (k: string) => `${k}  ${scanned.get(k)?.callText.replace(/\s+/g, " ").slice(0, 100)}`;

describe("every CustomerLink write is gated by the shared seller-status rule or classified (SA-776)", () => {
  it("the inventory equals the table, both directions", () => {
    expect({
      unclassified: [...scanned.keys()]
        .filter((k) => !TABLE[k])
        .sort()
        .map(show),
    }).toEqual({ unclassified: [] });
    expect({
      stale: Object.keys(TABLE)
        .filter((k) => !scanned.has(k))
        .sort(),
    }).toEqual({
      stale: [],
    });
  });

  it("the scan is not empty (a renamed model must not report green)", () => {
    expect(scanned.size).toBeGreaterThan(15);
  });

  it("no nested customerLink write and no raw-SQL write exists (the forms the call scan cannot see)", () => {
    expect(nested).toEqual([]);
    expect(rawSql).toEqual([]);
  });

  it("every GATED write sits in a method that calls the shared function BEFORE the write; every ALLOWED row has a reason", () => {
    const problems = Object.entries(TABLE).flatMap(([key, row]) => {
      const w = scanned.get(key);
      const p = w ? writeProblem(row, w) : null;
      return p ? [`${key} ${p}`] : [];
    });
    expect(problems).toEqual([]);
  });

  it("the gate value is read only by the shared rule and the capability flag that mirrors its verdict", () => {
    // A third reader would be a second copy of the rule. The capability controller is the one reviewed mirror: it
    // answers the UI's `acceptingOrders` boolean without logging a would-deny line on a read.
    const readers = walk(SRC_ROOT)
      .map((f) => path.relative(SRC_ROOT, f).split(path.sep).join("/"))
      .filter((rel) =>
        /sellerReadOnlyBuyerGate\(|env\.SELLER_READ_ONLY_BUYER_GATE|env\[["']SELLER_READ_ONLY_BUYER_GATE/.test(
          fs.readFileSync(path.join(SRC_ROOT, rel), "utf8"),
        ),
      )
      .sort();
    expect(readers).toEqual([
      "buyer/buyer-capabilities.controller.ts",
      "buyer/seller-status-gate.ts",
    ]);
  });

  describe("the detector itself can fail", () => {
    const src = (body: string) => `class A { m(dto) { ${body} } }`;

    it("finds direct, tx and forTenant() writes, numbers repeats, and ignores reads and other models", () => {
      const found = customerLinkWrites(
        src(`
          this.prisma.customerLink.update({});
          tx.customerLink.updateMany({});
          this.prisma.forTenant().customerLink.upsert({});
          this.prisma.customerLink.update({});
          this.prisma.customerLink.findFirst({});
          this.prisma.customer.update({});`),
      ).map((w) => w.key);
      expect(found).toEqual([
        "x.ts::m::update#0",
        "x.ts::m::updateMany#0",
        "x.ts::m::upsert#0",
        "x.ts::m::update#1",
      ]);
    });

    it("finds a write through a delegate alias or a destructured delegate", () => {
      const found = customerLinkWrites(
        `class A {
          m(tx) {
            const links = tx.customerLink;
            links.updateMany({});
            const { customerLink } = tx;
            customerLink.create({});
            const { customerLink: cl } = this.prisma;
            cl.delete({});
            const other = tx.customer;
            other.update({});
          }
        }`,
      ).map((w) => w.key);
      expect(found).toEqual(["x.ts::m::updateMany#0", "x.ts::m::create#0", "x.ts::m::delete#0"]);
    });

    it("flags a GATED row whose method never asks the shared function, one that asks AFTER the write, and an ALLOWED row with no reason", () => {
      const [bare] = customerLinkWrites(src(`this.prisma.customerLink.update({});`));
      expect(writeProblem(G, bare)).toMatch(/never calls sellerAcceptsBuyerWrite/);
      const [late] = customerLinkWrites(
        src(`this.prisma.customerLink.update({}); sellerAcceptsBuyerWrite({});`),
      );
      expect(writeProblem(G, late)).toMatch(/comes AFTER the write/);
      const [gated] = customerLinkWrites(
        src(`sellerAcceptsBuyerWrite({}); this.prisma.customerLink.update({});`),
      );
      expect(writeProblem(G, gated)).toBeNull();
      expect(writeProblem(A("  "), gated)).toMatch(/without a reason/);
    });

    it("flags a nested link write and ignores nested reads", () => {
      const nestedOf = (data: string) =>
        nestedCustomerLinkWrites(`db.customer.update({ data: ${data} });`);
      expect(nestedOf("{ customerLink: { create: { tenantId } } }")).toHaveLength(1);
      expect(nestedOf("{ customerLinks: { updateMany: { where, data } } }")).toHaveLength(1);
      expect(nestedOf("{ customerLink: { connect: { id } } }")).toHaveLength(1);
      expect(nestedOf("{ customerLink: { connectOrCreate: { where, create } } }")).toHaveLength(1);
      expect(nestedOf("{ customerLinks: { set: [{ id }] } }")).toHaveLength(1);
      expect(nestedOf("{ customerLink: { select: { id: true } } }")).toEqual([]);
    });
  });
});
