import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { NON_ROUTABLE_ORDER_STATUSES } from "../../routes/routes.constants";
import { ORDER_STATUS_TRANSITIONS } from "../order-status-transitions";

/**
 * SA-1134 R-1 (class: every exit from DRAFT is checked for open gate flags, swept by predicate and pinned).
 *
 * An order holding an open GATE flag (RESTRICTED, LICENSE_REQUIRED, CREDIT_BLOCKED) may only live on a DRAFT: those flags
 * clear only by passing the draft's promotion (`resolveGateFlagsAtPromotion`), which runs the license guard, the
 * restriction check and `assertPromotionCredit`. So no writer but the promotion may move an order out of DRAFT.
 *
 * THE PREDICATE (TypeScript AST over apps/api/src, non-spec): every call `<x>.order.update|updateMany|upsert(...)` whose
 * `data` can carry a `status` (an object with a `status` key, a spread, or a value that is not an object literal, which
 * is read as "can") is a status writer. The set must EQUAL the table below, both ways: a NEW writer fails until it is
 * read with the status it starts from and classified, and a removed one fails until its row is dropped. A new writer that
 * can start from DRAFT is not classified by the builder: it goes back to the SA.
 *
 *   PROMOTION      starts from DRAFT: the one writer allowed to. Its method must call the three promotion judges and the
 *                  flag resolver.
 *   REOPEN         claims a CANCELLED order into `reopenTarget(...)`: DRAFT while a gate flag is open, else PENDING (R-1).
 *   NOT_FROM_DRAFT its `where`, or the JS guard named in `needs`, cannot match a DRAFT (each needed name is an identifier
 *                  or string literal inside the function, so deleting the guard fails here).
 *   TO_CANCELLED   writes CANCELLED (never a live status): the order and its flags stay as they were; needsReview skips it
 *                  (R-2) and a reopen (R-1) puts a gate-flagged one back to DRAFT.
 *   NO_STATUS      its data carries no status column (a header, route-link or fee write).
 *
 * The DRAFT transitions themselves are pinned below (DRAFT -> PENDING or CANCELLED only), as is the one raw-SQL spelling.
 * Not covered by the predicate (read, none found): a nested `orders: { update }` write through another model, and
 * `$executeRaw` UPDATE "Order" (the last one is pinned at zero below).
 */
type How = "PROMOTION" | "REOPEN" | "NOT_FROM_DRAFT" | "TO_CANCELLED" | "NO_STATUS";
interface Row {
  how: How;
  /** The number of such calls in that function. */
  n: number;
  why: string;
  /**
   * Names that must occur (identifier or string literal) in the writer, or, as `File::Name:word`, in the named function
   * (a guard that lives in a caller).
   */
  needs?: string[];
}

const CS = "orders/orders.service.ts::OrdersService.changeStatus";
const INVENTORY: Record<string, Row> = {
  [CS]: {
    how: "PROMOTION",
    n: 2,
    why: "the DRAFT -> PENDING promotion (judgeDraftPromotion, assertPromotionCredit, resolveGateFlagsAtPromotion) and, from PENDING, the demotion back to DRAFT; the status table gives DRAFT no other live exit",
  },
  "orders/orders.service.ts::OrdersService.reopenOrder": {
    how: "REOPEN",
    n: 1,
    why: "CANCELLED -> target (R-1): DRAFT while a gate flag is open, no restriction check; promotion judges it later",
    needs: ["reopenTarget", "claimReopenInTx"],
  },
  "orders/order-reopen-claim.ts::claimReopenInTx": {
    how: "REOPEN",
    n: 1,
    why: "the B695 CAS, from CANCELLED only, into the target re-read under the lock",
    needs: ["CANCELLED", "reopenTarget"],
  },
  "orders/order-cancel-tx.ts::cancelOrderInTx": {
    how: "TO_CANCELLED",
    n: 1,
    why: "the cancel's CAS (changeStatus passes CANCELLED data only); a gate flag stays open and needsReview skips the order",
  },
  "orders/order-status-claim.ts::writeStatusIfUnchanged": {
    how: "NOT_FROM_DRAFT",
    n: 1,
    why: "changeStatus's last branch (ship and delivery states), a CAS on the status read; DRAFT has only the promotion and the cancel branches above it",
    needs: [`${CS}:isDraftToPendingPromotion`, `${CS}:updateStatusWithShipMarker`],
  },
  "orders/driver-edit-access.ts::confirmPendingAsDriver": {
    how: "NOT_FROM_DRAFT",
    n: 1,
    why: "the driver's PENDING -> CONFIRMED CAS",
    needs: ["PENDING"],
  },
  "orders/deliver-again.ts::deliverAgainInTx": {
    how: "NOT_FROM_DRAFT",
    n: 1,
    why: "SA-1101 deliver again: a REFUSED -> CONFIRMED CAS",
    needs: ["REFUSED"],
  },
  "orders/delivered-stamp.ts::markSaleDelivered": {
    how: "NOT_FROM_DRAFT",
    n: 1,
    why: "the counter sale's DELIVERED write: createSale creates its order PENDING, and a replay of a stored DRAFT is a 409 draft mismatch before this write (assertReplaySameCart)",
    needs: [
      "orders/orders.service.ts::OrdersService.createSale:PENDING",
      "orders/replay-same-cart.ts::assertReplaySameCart:draftMismatchConflict",
    ],
  },
  "orders/orders.service.ts::OrdersService.create": {
    how: "NOT_FROM_DRAFT",
    n: 1,
    why: "the run/stop link write sets CONFIRMED when immediateDelivery is sent; an offline request (the only source of gate flags) refuses immediateDelivery with a 400, and any other DRAFT carries no gate flag",
    needs: [
      "orders/offline/offline-create.ts::resolveOfflineRequest:OFFLINE_IMMEDIATE_DELIVERY_ONLINE_ONLY",
    ],
  },
  "orders/orders.service.ts::OrdersService.updateOrderItems": {
    how: "NOT_FROM_DRAFT",
    n: 1,
    why: "the edit's CONFIRMED -> PENDING revert, behind shouldRevert (status CONFIRMED only)",
    needs: ["shouldRevert", "CONFIRMED"],
  },
  "orders/orders.service.ts::OrdersService.forceConsolidateCustomer": {
    how: "NO_STATUS",
    n: 1,
    why: "the merge winner's write: totals and the route link (routeUpdate holds routeRunId and routeRunStopId); no status column",
  },
  "orders/order-lifecycle.ts::applyBuyerMergeHeaderImpl": {
    how: "NO_STATUS",
    n: 1,
    why: "the header merge: notes, urgent and requestedDeliveryDate only",
  },
  "orders/order-lifecycle.ts::releaseFinishedRunLink": {
    how: "NO_STATUS",
    n: 1,
    why: "clears the route link; its callers pass { fulfillPath } or nothing",
  },
  "routes/routes.service.ts::RoutesService.releaseUndeliveredOrders": {
    how: "NOT_FROM_DRAFT",
    n: 1,
    why: "OUT_FOR_DELIVERY -> CONFIRMED when a stop is released",
    needs: ["OUT_FOR_DELIVERY"],
  },
  "routes/routes.service.ts::RoutesService.reopenStop": {
    how: "NOT_FROM_DRAFT",
    n: 1,
    why: "reopening a stop undoes a delivery: only a post-delivery or OUT_FOR_DELIVERY order moves to CONFIRMED",
    needs: ["isPostDeliveryOrderStatus", "OUT_FOR_DELIVERY"],
  },
  "routes/stop-outcome.ts::applyStopOutcomes": {
    how: "NOT_FROM_DRAFT",
    n: 2,
    why: "a stop's DELIVERED / REFUSED outcome, never on a NON_ROUTABLE order (DRAFT is in that set, pinned below)",
    needs: ["NON_ROUTABLE_ORDER_STATUSES"],
  },
};

const SRC = path.resolve(__dirname, "../..");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "testing") walk(full, out);
    } else if (e.name.endsWith(".ts") && !/\.(spec|test|fixtures)\.ts$/.test(e.name))
      out.push(full);
  }
  return out;
};

const WRITE = new Set(["update", "updateMany", "upsert"]);

/** Whether a call's first argument is `{ data: <can carry status> }`. */
function dataCanCarryStatus(call: ts.CallExpression): boolean {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return true;
  const props = arg.properties;
  // upsert: `create` / `update` objects hold the data
  const holders = props.filter(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) &&
      ["data", "update", "create"].includes((p.name as ts.Identifier).text),
  );
  if (props.some((p) => ts.isSpreadAssignment(p))) return true;
  if (holders.length === 0) return true; // data was not named: shorthand or computed
  return holders.some((h) => {
    if (!ts.isObjectLiteralExpression(h.initializer)) return true;
    return h.initializer.properties.some(
      (p) =>
        ts.isSpreadAssignment(p) ||
        ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          (p.name as ts.Identifier).text === "status"),
    );
  });
}

/** The nearest enclosing method, function or arrow-assigned const: its node and its name. */
function enclosing(node: ts.Node): { fn: ts.Node | undefined; name: string } {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) {
      const cls = n.parent;
      const owner = ts.isClassDeclaration(cls) && cls.name ? cls.name.text : "?";
      return { fn: n, name: `${owner}.${n.name.text}` };
    }
    if (ts.isFunctionDeclaration(n) && n.name) return { fn: n, name: n.name.text };
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    )
      return { fn: n, name: n.name.text };
  }
  return { fn: undefined, name: "(module)" };
}

function wordsIn(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) out.add(n.text);
    else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** Files whose functions a `needs` entry names (`File::Name:word`): parsed even when they hold no order write. */
const NEEDED_FILES = new Set(
  Object.values(INVENTORY)
    .flatMap((r) => r.needs ?? [])
    .filter((n) => n.includes("::"))
    .map((n) => n.split("::")[0]),
);

interface Hit {
  key: string;
  fn: ts.Node | undefined;
}
function scan(): { hits: Hit[]; rawSql: string[]; fns: Map<string, ts.Node> } {
  const hits: Hit[] = [];
  const rawSql: string[] = [];
  const fns = new Map<string, ts.Node>();
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    if (/UPDATE\s+"?Order"?\s/i.test(text)) rawSql.push(rel);
    if (!/\.order\b/.test(text) && !NEEDED_FILES.has(rel)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (NEEDED_FILES.has(rel) && (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n))) {
        const e = n.body ? enclosing(n.body) : { fn: undefined, name: "" };
        if (e.fn === n) fns.set(`${rel}::${e.name}`, n);
      }
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        WRITE.has(n.expression.name.text) &&
        ts.isPropertyAccessExpression(n.expression.expression) &&
        n.expression.expression.name.text === "order" &&
        dataCanCarryStatus(n)
      ) {
        const { fn, name } = enclosing(n);
        hits.push({ key: `${rel}::${name}`, fn });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { hits, rawSql, fns };
}

describe("SA-1134 R-1: no writer but the promotion moves an order out of DRAFT", () => {
  const { hits, rawSql, fns } = scan();
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h.key, (counts.get(h.key) ?? 0) + 1);

  it("the status writers are exactly the classified set, with the same count per function", () => {
    expect(Object.fromEntries([...counts].sort())).toEqual(
      Object.fromEntries(
        Object.entries(INVENTORY)
          .map(([k, r]) => [k, r.n] as const)
          .sort(),
      ),
    );
  });

  it("each writer still contains the guard names its row relies on", () => {
    const missing: string[] = [];
    for (const [key, row] of Object.entries(INVENTORY)) {
      for (const need of row.needs ?? []) {
        // "File::Name:word" is a guard in another function; a bare word is in the writer itself
        const remote = need.includes("::");
        const at = need.lastIndexOf(":");
        const node = remote ? fns.get(need.slice(0, at)) : hits.find((h) => h.key === key)?.fn;
        const word = remote ? need.slice(at + 1) : need;
        if (!node || !wordsIn(node).has(word)) missing.push(`${key} lost ${need}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the promotion is the one DRAFT-starting writer and still runs the judges and resolves the gate flags", () => {
    const promotion = Object.entries(INVENTORY).filter(([, r]) => r.how === "PROMOTION");
    expect(promotion.map(([k]) => k)).toEqual([CS]);
    const words = wordsIn(hits.find((h) => h.key === CS)!.fn!);
    for (const call of [
      "judgeDraftPromotion",
      "assertPromotionCredit",
      "resolveGateFlagsAtPromotion",
    ])
      expect(words.has(call)).toBe(true);
  });

  it("a DRAFT can only become PENDING (the promotion) or CANCELLED, and only a PENDING order can be demoted to it", () => {
    expect(ORDER_STATUS_TRANSITIONS.DRAFT).toEqual(["PENDING", "CANCELLED"]);
    expect(
      Object.keys(ORDER_STATUS_TRANSITIONS).filter((from) =>
        ORDER_STATUS_TRANSITIONS[from].includes("DRAFT"),
      ),
    ).toEqual(["PENDING"]);
  });

  it("DRAFT is a NON_ROUTABLE status, so a stop outcome never writes a DRAFT", () => {
    expect(NON_ROUTABLE_ORDER_STATUSES).toContain("DRAFT");
  });

  it("no raw SQL writes an Order row", () => {
    expect(rawSql).toEqual([]);
  });
});
