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
 *   PENDING - a site still to be classified. A ratchet: PENDING_BASELINE may only go DOWN; B1106 PR B took it to 0, so a new
 *             PENDING row is a red.
 *   EXEMPT  - stores no caller-supplied id (re-points rows already in the tenant, copies a loaded row's own id, ...).
 *   DERIVED - stores a stop id READ off a named parent (an order the writer loaded tenant-scoped, a stop it read
 *             tenant-scoped). SA-1105 W-7 lists changeRequest and deliveryMutation this way, so a new writer of either
 *             goes red until it is classified.
 *
 * Detection: a Prisma write (`<x>.<model>.create|createMany|update|updateMany|upsert`) of a listed model whose first
 * argument holds a property named like a guarded field. A writer that builds its data in a variable the scan cannot
 * see is listed with `seen: false`; it is still checked for existence and for its proof call.
 */
type Kind = "customerIds" | "productIds" | "trackedCategoryIds" | "routeRunIds" | "routeRunStopIds";
type Row =
  | { kind: "GUARDED"; kinds: Kind[]; via?: string | string[]; seen?: boolean }
  | { kind: "PENDING"; step: string }
  | { kind: "EXEMPT"; why: string }
  | { kind: "DERIVED"; parent: string; why: string };

const G = (kinds: Kind[], opts: { via?: string | string[]; seen?: boolean } = {}): Row => ({
  kind: "GUARDED",
  kinds,
  ...opts,
});
const X = (why: string): Row => ({ kind: "EXEMPT", why });
/** Stores a stop id it READ off a parent row (SA-1105 W-7), never a caller-supplied one: the parent is named. */
const D = (parent: string, why: string): Row => ({ kind: "DERIVED", parent, why });

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
  // SA-1105 W-7: the derived models. Each stores a stop id read off a loaded parent, never a caller-supplied one.
  changeRequest: ["routeRunStopId"],
  deliveryMutation: ["routeRunStopId"],
  deliveryBatch: ["routeRunStopId"],
};
const WRITE_OPS = new Set(["create", "createMany", "update", "updateMany", "upsert"]);

const f = (file: string, fn: string) => `${file}::${fn}`;
const TABLE: Record<string, Row> = {
  // ── PR A: guarded ────────────────────────────────────────────────────────────────────────────
  [f("customers/customers.service.ts", "CustomersService.upsertCustomerPrice")]: G([
    "customerIds",
    "productIds",
  ]),
  [f("invoices/invoices.service.ts", "InvoicesService.create")]: G(["productIds"], { seen: false }),
  [f("invoices/invoices.service.ts", "InvoicesService.update")]: G(["productIds"], { seen: false }),
  // Create and the draft edit price their lines through priceEstimate, which proves both kinds before any write.
  [f("estimates/estimates.service.ts", "EstimatesService.create")]: G(
    ["customerIds", "productIds"],
    {
      via: f("estimates/estimates.service.ts", "EstimatesService.priceEstimate"),
    },
  ),
  [f("estimates/estimates.service.ts", "EstimatesService.update")]: G(
    ["customerIds", "productIds"],
    {
      via: f("estimates/estimates.service.ts", "EstimatesService.priceEstimate"),
      seen: false,
    },
  ),
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
  [f("orders/deliver-again.ts", "deliverAgainInTx")]: X("only clears the run link (null)"),
  [f("orders/testing/units-fold-db-harness.ts", "seedFoldTenant")]: X(
    "test-only seeding fixture of the D3 units-fold DB specs (orders/testing, imported only by *.db.spec.ts): every customer, product and category id it stores comes from rows it just created in its own throwaway qa-ufold-* tenant",
  ),

  // ── PR B (B1106, SA-1105): run / stop ids ────────────────────────────────────────────────────
  [f("drivers/drivers.service.ts", "DriversService.recordLocation")]: G(["routeRunIds"]),
  [f("messages/messages.service.ts", "MessagesService.create")]: G(["routeRunIds"]),
  // The staff-path proof lives in order-inline-return.ts (orders.service.ts is under a size ratchet); create() calls it.
  [f("orders/orders.service.ts", "OrdersService.create")]: G(["routeRunIds", "routeRunStopIds"], {
    via: f("orders/order-inline-return.ts", "assertStaffRunStopRefs"),
  }),
  // The Return's stop is written inside captureInTx's transaction, where the helper never runs (it reads on the outer
  // client, before any tx): the proof is hoisted to the three entries that reach it, each before any read.
  [f("returns/inline-returns.service.ts", "InlineReturnsService.captureInTx")]: G(
    ["routeRunStopIds"],
    {
      via: [
        f("returns/inline-returns.service.ts", "InlineReturnsService.capture"),
        f("returns/inline-returns.service.ts", "InlineReturnsService.preflightCapture"),
        f("returns/inline-returns.service.ts", "InlineReturnsService.preflightNewOrderReturn"),
      ],
    },
  ),

  // ── PR B: exempt (no caller-supplied run or stop id is stored) ───────────────────────────────
  [f("messaging/messaging.service.ts", "MessagingService.sendMessage")]: X(
    "writes runId: null on the customer-thread message (the engine's customer-facing rows carry no run)",
  ),
  // e3e62812b2 moved the write out of updateFulfillPathImpl into this shared release; the old row had gone stale.
  [f("orders/order-lifecycle.ts", "releaseFinishedRunLink")]: X(
    "only clears routeRunId and routeRunStopId (null) on a tenant-scoped order the caller just read",
  ),
  [f("orders/counter-sale/complete-at-counter-run.ts", "takeOrderOffRun")]: X(
    "only clears routeRunId and routeRunStopId (null) on the order the locked link names",
  ),
  [f("routes/routes.service.ts", "RoutesService.createRun")]: X(
    "links orders to the run this method just minted and to the stops it just created in the same transaction; the route is read tenant-scoped first (404)",
  ),
  [f("routes/routes.service.ts", "RoutesService.deleteRun")]: X(
    "only clears routeRunId and routeRunStopId (null) on the orders of a run read tenant-scoped (404)",
  ),
  [f("routes/routes.service.ts", "RoutesService.deleteRoute")]: X(
    "only clears routeRunId and routeRunStopId (null) on the orders of runs of a route read tenant-scoped (404)",
  ),
  [f("routes/routes.service.ts", "RoutesService.releaseUndeliveredOrders")]: X(
    "only clears routeRunId and routeRunStopId (null) on the undelivered orders it selects tenant-scoped",
  ),
  // ── PR B, SA-1105 W-7: derived (the stop id comes off a parent row the writer loaded) ────────
  [f("orders/change-requests.service.ts", "ChangeRequestsService.create")]: D(
    "order.routeRunStopId",
    "copies the routeRunStopId of the order it just loaded tenant-scoped; a change request never takes a stop id from the body",
  ),
  [f("orders/orders.service.ts", "OrdersService.approveChangeRequestAtStop")]: D(
    "order.routeRunStopId",
    "the at-door provenance row carries the loaded order's stop (or the change request's own, itself copied from that order)",
  ),
  [f("routes/routes.service.ts", "RoutesService.completeStop")]: D(
    "routeRunStop.id",
    "stopId is the path stop, read tenant-scoped with its run (404) before any write; the delivery mutation stores that stop's own id",
  ),
  [f("routes/routes.service.ts", "RoutesService.completeWithPayment")]: D(
    "routeRunStop.id",
    "stopId is the path stop, read tenant-scoped with its run (404) before any write; the delivery mutation stores that stop's own id",
  ),
  [f("orders/office-evidence-completion.ts", "completeOfficeEvidencedLines")]: X(
    "writes routeRunStopId: null (an office completion has no stop)",
  ),
  [f("orders/order-pd-quantities.ts", "writeOfficeDeliveries")]: X(
    "writes routeRunStopId: null (an office delivery has no stop)",
  ),
};

/** Down-only. B1106 PR B took it to 0: nothing is left pending. */
const PENDING_BASELINE = 0;

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

/** Does `fn` contain a real call to any of `names` (`x.name(...)` or `name(...)`)? A comment or a string never counts. */
export function callsAny(fn: ts.Node, names: string[]): boolean {
  let hit = false;
  const walkNode = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name !== null && names.includes(name)) hit = true;
    }
    if (!hit) ts.forEachChild(n, walkNode);
  };
  walkNode(fn);
  return hit;
}

const fnOfSrc = (src: string) => parse("x.ts", src)[0].node;
const fnByKey = (key: string): ts.Node => {
  const [rel] = key.split("::");
  const found = parse(rel, fs.readFileSync(path.join(SRC, rel), "utf8")).find((x) => x.key === key);
  if (!found) throw new Error(`no such method: ${key}`);
  return found.node;
};

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
      // One holder, or several entries that each prove (a writer inside a transaction is reached by more than one entry).
      const holders = row.via === undefined ? [key] : ([] as string[]).concat(row.via);
      for (const holder of holders) {
        const [rel] = holder.split("::");
        const node =
          ALL.get(holder) ??
          parse(rel, fs.readFileSync(path.join(SRC, rel), "utf8")).find((x) => x.key === holder)
            ?.node;
        const proven = node ? provenKinds(node) : new Set<string>();
        for (const k of row.kinds)
          if (!proven.has(k)) unproven.push(`${key} -> ${k} (in ${holder})`);
      }
    }
    expect(unproven).toEqual([]);
  });

  it("PENDING is a down-only ratchet (at 0 since B1106 PR B)", () => {
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

  it("every DERIVED row names a parent the writer reads from, and says why", () => {
    const parents = [...Object.keys(FIELDS), "routeRunStop"].map((m) => `${m}.`);
    for (const row of Object.values(TABLE)) {
      if (row.kind !== "DERIVED") continue;
      expect(parents.some((p) => row.parent.startsWith(p))).toBe(true);
      expect(row.why.length).toBeGreaterThan(20);
    }
  });

  describe("the call graph behind a `via` (L-1): the proof holders are the only way in", () => {
    // Every function that CALLS one of `names`, keyed like TABLE.
    const callersOf = (names: string[]): string[] => {
      const out: string[] = [];
      for (const file of walk(SRC)) {
        const rel = path.relative(SRC, file).split(path.sep).join("/");
        const text = fs.readFileSync(file, "utf8");
        if (!names.some((n) => text.includes(`${n}(`))) continue;
        for (const fn of parse(rel, text)) if (callsAny(fn.node, names)) out.push(fn.key);
      }
      return out.sort();
    };

    it("captureInTx / captureAndIssueInTx are called only by the three listed paths", () => {
      // capture: the standalone entry (proves the stop itself); captureAndIssueInTx: reaches captureInTx for the order
      // glue; applyInlineReturnInTx: the order create / edit glue, reached only behind the entries pinned next.
      expect(callersOf(["captureInTx", "captureAndIssueInTx"])).toEqual(
        [
          f("orders/order-inline-return.ts", "applyInlineReturnInTx"),
          f("returns/inline-returns.service.ts", "InlineReturnsService.capture"),
          f("returns/inline-returns.service.ts", "InlineReturnsService.captureAndIssueInTx"),
        ].sort(),
      );
    });

    it("the order glue is reached only by order create and order edit, each behind its proving entry", () => {
      expect(callersOf(["applyReturn", "applyInlineReturnInTx"])).toEqual(
        [
          f("orders/orders.service.ts", "OrdersService.create"),
          f("orders/orders.service.ts", "OrdersService.updateOrderItems"),
        ].sort(),
      );
      // create: reserveReturnNo -> preflightNewOrderReturn proves the stop; edit: preflightInlineReturn -> preflightCapture.
      expect(
        callsAny(fnByKey(f("orders/orders.service.ts", "OrdersService.create")), [
          "reserveReturnNo",
        ]),
      ).toBe(true);
      expect(
        callsAny(fnByKey(f("orders/orders.service.ts", "OrdersService.updateOrderItems")), [
          "preflightInlineReturn",
        ]),
      ).toBe(true);
    });

    it("a `via` writer with one holder actually calls it", () => {
      for (const [key, row] of Object.entries(TABLE)) {
        if (row.kind !== "GUARDED" || typeof row.via !== "string") continue;
        // A method holder is keyed "Class.method"; its call reads `this.method(`.
        const holder = row.via.split("::")[1];
        expect(callsAny(fnByKey(key), [holder.slice(holder.lastIndexOf(".") + 1)])).toBe(true);
      }
    });

    it("the call check sees a call and ignores a comment or a string", () => {
      const yes = fnOfSrc("class A { m() { this.svc.captureInTx(tx); } }");
      const no = fnOfSrc('class A { m() { /* captureInTx(tx) */ const s = "captureInTx(tx)"; } }');
      expect(callsAny(yes, ["captureInTx"])).toBe(true);
      expect(callsAny(no, ["captureInTx"])).toBe(false);
    });
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
