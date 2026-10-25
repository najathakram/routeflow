import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * 681 (R5-5, SA-936 MUST 6): the tenant-ref inventory. Every code path that WRITES a caller-supplied id of a tenant-scoped
 * row into a guarded field is classified, and the table must EQUAL the source both ways: a NEW writer fails until it is
 * classified, and a row whose method is gone (or no longer writes the field) is stale and fails.
 *
 *   GUARDED - the method (or the named caller in `via`, for a proof hoisted to the pre-transaction section) calls
 *             `assertRefsInTenant` with each listed kind. AST proof: a comment or a string never counts.
 *   PENDING - a PR B site (run / stop ids). A ratchet: PENDING_BASELINE may only go DOWN; PR B takes it to 0.
 *   EXEMPT  - stores no caller-supplied id (re-points rows already in the tenant, copies a loaded row's own id, ...).
 *
 * Detection: a Prisma write (`<x>.<model>.create|createMany|update|updateMany|upsert`) of a listed model whose first
 * argument holds a property named like a guarded field. A writer that builds its data in a variable the scan cannot
 * see is listed with `seen: false`; it is still checked for existence and for its proof call.
 */
type Kind = "customerIds" | "productIds" | "trackedCategoryIds";
type Row =
  | { kind: "GUARDED"; kinds: Kind[]; via?: string; seen?: boolean }
  | { kind: "PENDING"; step: string }
  | { kind: "EXEMPT"; why: string };

const G = (kinds: Kind[], opts: { via?: string; seen?: boolean } = {}): Row => ({
  kind: "GUARDED",
  kinds,
  ...opts,
});
const P = (step: string): Row => ({ kind: "PENDING", step });
const X = (why: string): Row => ({ kind: "EXEMPT", why });

const FIELDS: Record<string, string[]> = {
  customerPrice: ["customerId", "productId"],
  invoice: ["productId"],
  invoiceItem: ["productId"],
  estimate: ["customerId", "productId"],
  estimateItem: ["productId"],
  recurringInvoice: ["customerId", "productId"],
  recurringInvoiceItem: ["productId"],
  promotionProduct: ["productId"],
  productMapping: ["productId"],
  advancePayment: ["customerId"],
  saleDraft: ["customerId"],
  product: ["trackedCategoryId"],
  // PR B kinds:
  order: ["routeRunId", "routeRunStopId"],
  message: ["runId"],
  return: ["routeRunStopId"],
  driverLocation: ["runId"],
};
const WRITE_OPS = new Set(["create", "createMany", "update", "updateMany", "upsert"]);
const PR_B = "PR B (dispatch): routeRunIds / routeRunStopIds proof";

const f = (file: string, fn: string) => `${file}::${fn}`;
const TABLE: Record<string, Row> = {
  // ── PR A: guarded ────────────────────────────────────────────────────────────────────────────
  [f("customers/customers.service.ts", "CustomersService.upsertCustomerPrice")]: G([
    "customerIds",
    "productIds",
  ]),
  [f("invoices/invoices.service.ts", "InvoicesService.create")]: G(["productIds"], { seen: false }),
  [f("invoices/invoices.service.ts", "InvoicesService.update")]: G(["productIds"], { seen: false }),
  [f("estimates/estimates.service.ts", "EstimatesService.create")]: G([
    "customerIds",
    "productIds",
  ]),
  [f("recurring-invoices/recurring-invoices.service.ts", "RecurringInvoicesService.create")]: G([
    "customerIds",
    "productIds",
  ]),
  [f("recurring-invoices/recurring-invoices.service.ts", "RecurringInvoicesService.update")]: G([
    "productIds",
  ]),
  [f("promotions/promotions.service.ts", "PromotionsService.create")]: G(["productIds"]),
  [f("promotions/promotions.service.ts", "PromotionsService.update")]: G(["productIds"]),
  [f("vendor-bills/vendor-bills.service.ts", "VendorBillsService.saveProductMapping")]: G([
    "productIds",
  ]),
  [f("invoices/invoices.service.ts", "InvoicesService.writeStandalonePayment")]: G(["customerIds"]),
  [f("drafts/drafts.service.ts", "DraftsService.create")]: G(["customerIds"]),
  [f("drafts/drafts.service.ts", "DraftsService.update")]: G(["customerIds"], { seen: false }),
  [f("products/products.service.ts", "ProductsService.create")]: G(["trackedCategoryIds"]),
  [f("products/products.service.ts", "ProductsService.update")]: G(["trackedCategoryIds"], {
    seen: false,
  }),

  // ── PR A: exempt (no caller-supplied id is stored) ───────────────────────────────────────────
  [f("customers/customers.service.ts", "CustomersService.mergeCustomers")]: X(
    "re-points existing estimate / recurring / advance rows from a loaded source customer to a loaded target customer; both come from tenant-scoped reads",
  ),
  [f("invoices/invoices.service.ts", "InvoicesService.recordDeliveryPaymentInTx")]: X(
    "the customer is read off the delivered order the route already loaded, never from a request body",
  ),
  [f("inventory/inventory.service.ts", "InventoryService.createVariantRowInTx")]: X(
    "copies the loaded parent product's own trackedCategoryId",
  ),
  [f(
    "tracked-categories/tracked-categories.service.ts",
    "TrackedCategoriesService.assignProducts",
  )]: X(
    "the category is loaded through findOne (404 across tenants); movers are selected tenant-scoped under the row locks",
  ),
  [f(
    "tracked-categories/tracked-categories.service.ts",
    "TrackedCategoriesService.unassignProducts",
  )]: X("only clears the column (null) on tenant-scoped products"),

  // ── PR B: pending (run / stop ids; 681 PR B takes this to 0) ─────────────────────────────────
  [f("drivers/drivers.service.ts", "DriversService.recordLocation")]: P(PR_B),
  [f("messages/messages.service.ts", "MessagesService.create")]: P(PR_B),
  [f("messaging/messaging.service.ts", "MessagingService.sendMessage")]: P(PR_B),
  [f("orders/orders.service.ts", "OrdersService.create")]: P(PR_B),
  [f("orders/order-lifecycle.ts", "updateFulfillPathImpl")]: P(PR_B),
  [f("orders/counter-sale/complete-at-counter-run.ts", "takeOrderOffRun")]: P(PR_B),
  [f("returns/inline-returns.service.ts", "InlineReturnsService.captureInTx")]: P(PR_B),
  [f("routes/routes.service.ts", "RoutesService.createRun")]: P(PR_B),
  [f("routes/routes.service.ts", "RoutesService.deleteRun")]: P(PR_B),
  [f("routes/routes.service.ts", "RoutesService.deleteRoute")]: P(PR_B),
  [f("routes/routes.service.ts", "RoutesService.releaseUndeliveredOrders")]: P(PR_B),
};

/** Down-only. PR A lists PR B's sites; PR B takes it to 0. */
const PENDING_BASELINE = 11;

const SRC = path.join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e.name) && !/\.spec\.ts$|\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

type Fn = { key: string; node: ts.Node };

function functionsOf(sf: ts.SourceFile, rel: string): Fn[] {
  const fns: Fn[] = [];
  const visit = (node: ts.Node, cls: string | null) => {
    if (ts.isClassDeclaration(node)) {
      node.members.forEach((m) => visit(m, node.name?.text ?? null));
      return;
    }
    if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) {
      const name = node.name && ts.isIdentifier(node.name) ? node.name.text : "?";
      fns.push({ key: `${rel}::${cls ? cls + "." : ""}${name}`, node });
      return;
    }
    ts.forEachChild(node, (n) => visit(n, cls));
  };
  visit(sf, null);
  return fns;
}

/** Guarded fields written by Prisma writes inside `fn` (model.field). */
export function guardedWrites(fn: ts.Node): string[] {
  const hits = new Set<string>();
  const walkNode = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      WRITE_OPS.has(n.expression.name.text) &&
      ts.isPropertyAccessExpression(n.expression.expression)
    ) {
      const model = n.expression.expression.name.text;
      const fields = FIELDS[model];
      if (fields && n.arguments[0]) {
        const inArg = (m: ts.Node) => {
          if (
            (ts.isPropertyAssignment(m) || ts.isShorthandPropertyAssignment(m)) &&
            fields.includes(m.name.getText())
          ) {
            hits.add(`${model}.${m.name.getText()}`);
          }
          ts.forEachChild(m, inArg);
        };
        inArg(n.arguments[0]);
      }
    }
    ts.forEachChild(n, walkNode);
  };
  walkNode(fn);
  return [...hits].sort();
}

/** Kinds proven by `assertRefsInTenant(...)` calls inside `fn` (object-literal keys of the 2nd argument). */
export function provenKinds(fn: ts.Node): Set<string> {
  const kinds = new Set<string>();
  const walkNode = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "assertRefsInTenant" &&
      n.arguments[1] &&
      ts.isObjectLiteralExpression(n.arguments[1])
    ) {
      for (const p of n.arguments[1].properties) {
        if (p.name) kinds.add(p.name.getText());
      }
    }
    ts.forEachChild(n, walkNode);
  };
  walkNode(fn);
  return kinds;
}

const parse = (rel: string, text: string) =>
  functionsOf(ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true), rel);

const ALL: Map<string, ts.Node> = new Map();
const DETECTED: Map<string, string[]> = new Map();
beforeAll(() => {
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    if (!/\.(create|createMany|update|updateMany|upsert)\(/.test(text)) continue;
    for (const fn of parse(rel, text)) {
      ALL.set(fn.key, fn.node);
      const w = guardedWrites(fn.node);
      if (w.length) DETECTED.set(fn.key, w);
    }
  }
});

describe("tenant-ref writers inventory (681, SA-936 MUST 6)", () => {
  it("every detected writer of a guarded field is classified (a new writer fails until it is)", () => {
    const unlisted = [...DETECTED.keys()].filter((k) => !(k in TABLE)).sort();
    expect(unlisted).toEqual([]);
  });

  it("no row is stale: each method exists, and a seen row still writes a guarded field", () => {
    const missing: string[] = [];
    const notDetected: string[] = [];
    for (const [key, row] of Object.entries(TABLE)) {
      if (!ALL.has(key)) {
        // A method with no Prisma write call at all is not parsed above; check the file directly.
        const [rel, fnName] = key.split("::");
        const text = fs.readFileSync(path.join(SRC, rel), "utf8");
        const fn = parse(rel, text).find((x) => x.key === key);
        if (!fn) missing.push(`${rel}::${fnName}`);
        else ALL.set(key, fn.node);
      }
      const expectSeen = row.kind === "GUARDED" ? row.seen !== false : true;
      if (expectSeen && ALL.has(key) && !DETECTED.has(key)) notDetected.push(key);
    }
    expect(missing).toEqual([]);
    expect(notDetected).toEqual([]);
  });

  it("every GUARDED row proves its kinds before the write (in the method, or in the named caller)", () => {
    const unproven: string[] = [];
    for (const [key, row] of Object.entries(TABLE)) {
      if (row.kind !== "GUARDED") continue;
      const holder = row.via ?? key;
      const [rel] = holder.split("::");
      const node =
        ALL.get(holder) ??
        parse(rel, fs.readFileSync(path.join(SRC, rel), "utf8")).find((x) => x.key === holder)
          ?.node;
      const proven = node ? provenKinds(node) : new Set<string>();
      for (const k of row.kinds) if (!proven.has(k)) unproven.push(`${key} -> ${k}`);
    }
    expect(unproven).toEqual([]);
  });

  it("PENDING is a down-only ratchet (PR B takes it to 0)", () => {
    const pending = Object.values(TABLE).filter((r) => r.kind === "PENDING").length;
    expect(pending).toBeLessThanOrEqual(PENDING_BASELINE);
    // Equal today: lowering the baseline in the PR that flips a row is what forces the constant down.
    expect(pending).toBe(PENDING_BASELINE);
  });

  it("every EXEMPT row states why", () => {
    for (const row of Object.values(TABLE)) {
      if (row.kind === "EXEMPT") expect(row.why.length).toBeGreaterThan(20);
    }
  });

  describe("the detector itself (positive controls on inline source)", () => {
    const fnOf = (src: string) => parse("x.ts", src)[0].node;
    it("sees a guarded write, including a nested one", () => {
      const fn = fnOf(
        "class A { m() { return this.prisma.estimate.create({ data: { items: { create: [{ productId }] } } }); } }",
      );
      expect(guardedWrites(fn)).toEqual(["estimate.productId"]);
    });
    it("ignores a field of an unlisted model and a bare mention in a comment or string", () => {
      const fn = fnOf(
        'class A { m() { /* customerPrice.create({ customerId }) */ const s = "advancePayment.create({ customerId })"; return this.prisma.widget.create({ data: { customerId: 1 } }); } }',
      );
      expect(guardedWrites(fn)).toEqual([]);
    });
    it("provenKinds reads only real helper calls", () => {
      const yes = fnOf(
        "class A { async m() { await assertRefsInTenant(this.prisma, { customerIds: [a], productIds: [b] }); } }",
      );
      const no = fnOf(
        'class A { async m() { const s = "assertRefsInTenant(p, { productIds })"; } }',
      );
      expect([...provenKinds(yes)].sort()).toEqual(["customerIds", "productIds"]);
      expect([...provenKinds(no)]).toEqual([]);
    });
  });
});
