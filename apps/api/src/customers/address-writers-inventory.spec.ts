import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * F4 — every write of a `CustomerAddress.state` derives `stateCode` / `stateNeedsReview` with
 * `addressStateFields`. The restrictions engine reads ONLY `stateCode`, so a writer that stores a
 * state without deriving it leaves the customer INDETERMINATE, and one that edits `state` without
 * recomputing leaves the customer resolving to the state they left (a ban in the new state never
 * binds — a fail-open). This walks the tree so a NEW `customerAddress` write fails until somebody
 * classifies it: STATE (its call must derive the state) or EXEMPT (it must not write a state).
 */

// ─── the static inventory ───────────────────────────────────────────────────────────────────────

const SRC_ROOT = path.resolve(__dirname, "..");
const VERBS = new Set(["create", "createMany", "update", "updateMany", "upsert"]);

type Write = { key: string; text: string };

/** Every `<x>.customerAddress.<write>(…)` call in one source text, keyed file::method::verb#n. */
export function addressWrites(source: string, file = "x.ts"): Write[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const seen = new Map<string, number>();
  const out: Write[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const verb = n.expression.name.text;
      const target = n.expression.expression;
      if (
        VERBS.has(verb) &&
        ts.isPropertyAccessExpression(target) &&
        target.name.text === "customerAddress"
      ) {
        let method = "<module>";
        for (let c: ts.Node | undefined = n.parent; c; c = c.parent) {
          if ((ts.isMethodDeclaration(c) || ts.isFunctionDeclaration(c)) && c.name) {
            method = c.name.getText(sf);
            break;
          }
        }
        const base = `${file}::${method}::${verb}`;
        const i = seen.get(base) ?? 0;
        seen.set(base, i + 1);
        out.push({ key: `${base}#${i}`, text: n.getText(sf) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** What is wrong with one classified write, or null. */
export function writeProblem(
  kind: "STATE" | "EXEMPT" | "RESTORE",
  callText: string,
): string | null {
  // RESTORE (bulk-state undo only): puts back the three columns captured from the row moments earlier, and
  // nothing else. It must go through `restoredStateFields(<snapshot>)` and never write a fresh state.
  if (kind === "RESTORE")
    return /data:\s*\{\s*\.\.\.restoredStateFields\(\s*[\w.]+\s*\)\s*\}/.test(callText)
      ? null
      : "restores a state but not only through restoredStateFields(<snapshot>)";
  // STATE: the helper must be fed the STATE (`addressStateFields(dto.zip)` is not a derivation).
  if (kind === "STATE")
    return /addressStateFields\(\s*[\w.?!]*[sS]tate\b/.test(callText)
      ? null
      : "writes a state but never derives it with addressStateFields(<state>)";
  // EXEMPT: coordinates / flags / the tenant only. A `state` key, a derived column, ANY spread
  // (a DTO can carry one) or `data` built by a call (`data: build(dto)`) each could carry a state.
  return /\bstate\s*:|\bstateCode\b|\bstateNeedsReview\b|\.\.\.|data:\s*[\w.]+\(/.test(callText)
    ? "is EXEMPT but may write a state (a state key, a spread, or data built by a call)"
    : null;
}

const NESTED = new Set([
  "create",
  "createMany",
  "connectOrCreate",
  "upsert",
  "update",
  "updateMany",
]);

/** Nested address writes (`addresses: { create: … }` inside another model's data): the call scan cannot see them. */
export function nestedAddressWrites(source: string, file = "x.ts"): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isPropertyAssignment(n) &&
      n.name.getText(sf) === "addresses" &&
      ts.isObjectLiteralExpression(n.initializer) &&
      n.initializer.properties.some((p) => p.name && NESTED.has(p.name.getText(sf)))
    )
      out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const S = { kind: "STATE" } as const;
const R = { kind: "RESTORE" } as const;
const E = (why: string) => ({ kind: "EXEMPT", why }) as const;
const TABLE: Record<
  string,
  { kind: "STATE" } | { kind: "RESTORE" } | { kind: "EXEMPT"; why: string }
> = {
  "customers/customers.service.ts::create::createMany#0": S,
  "customers/customers.service.ts::addAddress::create#0": S,
  "customers/address-state-writes.ts::setChosenAddressState::updateMany#0": S,
  "customers/address-state-writes.ts::createMinimalAddresses::createMany#0": S,
  "customers/address-state-writes.ts::restoreAddressState::updateMany#0": R,
  "customers/customers.service.ts::updateAddress::update#0": S,
  "customers/customers.service.ts::addAddress::updateMany#0": E("clears the isDefault flag"),
  "customers/customers.service.ts::addAddress::updateMany#1": E(
    "demotes a blank-street placeholder default",
  ),
  "customers/customers.service.ts::updateAddress::updateMany#0": E("clears the isDefault flag"),
  "customers/customers.service.ts::updateAddress::update#1": E("async geocode: coordinates only"),
  "customers/customers.service.ts::geocodeAllAddresses::update#0": E("geocode: coordinates only"),
  "customers/customers.service.ts::deleteAddress::update#0": E(
    "promotes another address to default",
  ),
  "route-optimization/route-optimization.service.ts::loadRouteStops::update#0": E(
    "geocode: coordinates only",
  ),
  "route-optimization/route-optimization.service.ts::optimizeRoute::update#0": E(
    "geocode: coordinates only",
  ),
  "import/import.service.ts::importContacts::create#0": S,
  "import/import.service.ts::importContacts::create#1": S,
  "import/import.service.ts::importContacts::create#2": S,
  "import/import.service.ts::importContacts::create#3": S,
  "import/import.service.ts::importInvoices::create#0": S,
  "import/import.service.ts::adoptOrphanedContacts::updateMany#0": E(
    "adopts orphaned rows into a tenant",
  ),
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
for (const file of walk(SRC_ROOT)) {
  const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
  const text = fs.readFileSync(file, "utf8");
  for (const w of addressWrites(text, rel)) scanned.set(w.key, w);
  nested.push(...nestedAddressWrites(text, rel));
}
// Keys are ordinals: a write inserted EARLIER in a method renumbers the later ones, so a failure
// shows each call, not only its key.
const show = (k: string) => `${k}  ${scanned.get(k)?.text.replace(/\s+/g, " ").slice(0, 110)}`;

describe("every CustomerAddress write is classified (F4)", () => {
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
    expect(scanned.size).toBeGreaterThan(8);
  });

  it("no nested `addresses: { create … }` write exists (the idiomatic form the call scan cannot see)", () => {
    expect(nested).toEqual([]);
  });

  it("every write is what its row says: STATE calls the helper, EXEMPT writes no state", () => {
    const problems = Object.entries(TABLE).flatMap(([key, row]) => {
      const p = writeProblem(row.kind, scanned.get(key)?.text ?? "");
      return p ? [`${key} ${p}`] : [];
    });
    expect(problems).toEqual([]);
  });

  describe("the detector itself can fail", () => {
    const src = (body: string) => `class A { m(dto) { ${body} } }`;

    it("finds direct, tx and forTenant() writes, numbers repeats, and ignores reads and other models", () => {
      const found = addressWrites(
        src(`
          this.prisma.forTenant().customerAddress.create({ data: {} });
          tx.customerAddress.create({ data: {} });
          tx.customerAddress.updateMany({});
          this.prisma.customerAddress.findMany({});
          this.prisma.customer.update({});`),
      ).map((w) => w.key);
      expect(found).toEqual(["x.ts::m::create#0", "x.ts::m::create#1", "x.ts::m::updateMany#0"]);
    });

    it("flags a STATE write that skips the helper (or feeds it something else), and an EXEMPT write that may carry a state", () => {
      const state = (text: string) => writeProblem("STATE", text);
      expect(state("tx.customerAddress.create({ data: { state: dto.state } })")).toMatch(
        /never derives/,
      );
      expect(
        state("x.customerAddress.create({ data: { ...addressStateFields(dto.zip) } })"),
      ).toMatch(/never derives/);
      expect(
        state("x.customerAddress.create({ data: { ...addressStateFields(billingState) } })"),
      ).toBeNull();
      expect(
        state("tx.customerAddress.create({ data: { ...addressStateFields(dto.state) } })"),
      ).toBeNull();
      for (const text of [
        "x.customerAddress.update({ data: { state: 'CA' } })",
        "x.customerAddress.update({ data: { stateCode: 'CA' } })",
        "x.customerAddress.update({ data: { ...dto } })",
        "x.customerAddress.update({ data: { ...body } })",
        "x.customerAddress.update({ data: buildAddressData(dto) })",
      ])
        expect(writeProblem("EXEMPT", text)).toMatch(/EXEMPT but may write a state/);
      for (const text of [
        "x.customerAddress.update({ where: { id }, data: coords })",
        "x.customerAddress.update({ where: { id }, data: { isDefault: true } })",
        "x.customerAddress.updateMany({ where: {}, data: { tenantId } })",
      ])
        expect(writeProblem("EXEMPT", text)).toBeNull();
    });

    it("RESTORE passes only a data object that is exactly the restoredStateFields spread", () => {
      const restore = (text: string) => writeProblem("RESTORE", text);
      expect(
        restore(
          "tx.customerAddress.updateMany({ where, data: { ...restoredStateFields(prior) } })",
        ),
      ).toBeNull();
      for (const text of [
        "tx.customerAddress.updateMany({ where, data: { state: prior.state } })",
        "tx.customerAddress.updateMany({ where, data: { ...restoredStateFields(prior), state: 'CA' } })",
        "tx.customerAddress.updateMany({ where, data: { ...addressStateFields(dto.state) } })",
      ])
        expect(restore(text)).toMatch(/restoredStateFields/);
    });

    it("flags a nested address write and ignores nested reads", () => {
      const nestedOf = (data: string) =>
        nestedAddressWrites(`db.customer.create({ data: ${data} });`);
      expect(nestedOf("{ addresses: { create: [a] } }")).toHaveLength(1);
      expect(nestedOf("{ addresses: { connectOrCreate: { where, create } } }")).toHaveLength(1);
      expect(nestedOf("{ addresses: { orderBy: { isDefault: 'desc' } } }")).toEqual([]);
      expect(nestedOf("{ tags: { create: [t] } }")).toEqual([]);
    });
  });
});
