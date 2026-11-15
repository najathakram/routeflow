/**
 * SA-1101 §2.4 (P-1): "the order is done" is one list, read by name.
 *
 * Before REFUSED, every place that meant "done" spelled `DELIVERED` and `CANCELLED` out again (an array,
 * a `notIn`/`in` list, an `&&`/`||` chain). A new terminal status would have been missed by every one of them,
 * which is how a refused order's $0 draft would have been re-mirrored at the full amount on its next edit.
 * This walks the source and fails on any such list or chain that names BOTH an order `DELIVERED` and
 * `CANCELLED` without `REFUSED` or one of the shared names (`TERMINAL_ORDER_STATUSES`,
 * `POST_DELIVERY_ORDER_STATUSES`, `isTerminalOrderStatus`, `isPostDeliveryOrderStatus`).
 *
 * A site that is really about something else (a transition TABLE, an item or run status, a report that must keep
 * excluding only those two) goes in EXEMPT with a reason. The map is COUNT-PINNED and only shrinks: fewer hits
 * than the number written down fails too, so a fixed site cannot leave a stale exemption behind (OP-7).
 *
 * Also pins (G4): the blind `status: DELIVERED` stop-close write is gone and `applyStopOutcomes` runs exactly
 * twice in `routes.service.ts`; the API copy of both lists equals the shared ones in `@routeflow/types`.
 */
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";
import {
  ACTIVE_ORDER_STATUSES as SHARED_ACTIVE,
  ORDER_STATUS_VALUES,
  POST_DELIVERY_ORDER_STATUSES as SHARED_POST_DELIVERY,
  TERMINAL_ORDER_STATUSES as SHARED_TERMINAL,
} from "@routeflow/types";
import {
  ACTIVE_ORDER_STATUSES,
  POST_DELIVERY_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
} from "./terminal-order-statuses";

const REPO = path.resolve(__dirname, "../../../..");

const ROOTS = [
  "apps/api/src",
  "apps/web/app",
  "apps/web/components",
  "apps/web/lib",
  "apps/mobile/app",
  "apps/mobile/lib",
];
for (const pkg of fs.readdirSync(path.join(REPO, "packages"))) {
  for (const sub of ["src", "api"]) ROOTS.push(`packages/${pkg}/${sub}`);
}

const SKIP_DIR = new Set(["node_modules", ".next", "dist", "__tests__", "e2e", "migrations"]);
const TEST_FILE = /\.(spec|test)\.(ts|tsx)$|\.d\.ts$/;
const SHARED_NAME =
  /REFUSED|TERMINAL_ORDER_STATUSES|POST_DELIVERY_ORDER_STATUSES|isTerminalOrderStatus|isPostDeliveryOrderStatus/;

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !TEST_FILE.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const names = (text: string) => ({
  delivered: /\bDELIVERED\b/.test(text.replace(/PARTIALLY_DELIVERED|OUT_FOR_DELIVERED/g, "")),
  cancelled: /\bCANCELLED\b/.test(text),
});

/** Every list or chain in one file that names an order DELIVERED and CANCELLED but no REFUSED / shared name. */
function violationsIn(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  if (!/DELIVERED/.test(src) || !/CANCELLED/.test(src)) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const isLogical = (n: ts.Node): n is ts.BinaryExpression =>
    ts.isBinaryExpression(n) &&
    (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      n.operatorToken.kind === ts.SyntaxKind.BarBarToken);
  const visit = (n: ts.Node) => {
    const topChain = isLogical(n) && !(n.parent && isLogical(n.parent));
    if (ts.isArrayLiteralExpression(n) || topChain) {
      const text = n.getText(sf);
      const { delivered, cancelled } = names(text);
      if (delivered && cancelled && !SHARED_NAME.test(text)) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        hits.push(`${path.relative(REPO, file).replace(/\\/g, "/")}:${line}`);
      }
      // A chain's inner parts and nested arrays are judged by their outermost node only.
      if (topChain) return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

/** file -> the exact number of hits that are NOT a "done" list, and why. Shrink-only. */
const EXEMPT: Record<string, { count: number; reason: string }> = {
  "apps/api/src/common/testing/copier-contract/copier-registry.ts": {
    count: 1,
    reason:
      "Test fixture: line-item statuses of the copier contract rows, not an order done-ness list.",
  },
  "apps/api/src/documents/receipt.fixtures.ts": {
    count: 1,
    reason: "Test fixture: a list of sample statuses a receipt renders, not a done-ness decision.",
  },
  "apps/api/src/orders/order-status-transitions.ts": {
    count: 3,
    reason:
      "The transition TABLE: what an order may move to next. REFUSED has its own row and entries.",
  },
  "packages/types/api/enums.ts": {
    count: 1,
    reason:
      "ITEM_STATUS_VALUES: a line status set (DELIVERED, CANCELLED), not an order terminal list.",
  },
  "apps/web/app/(dashboard)/dashboard/page.tsx": {
    count: 1,
    reason:
      "The order pipeline strip: the 'all time' caption on its cumulative DELIVERED and CANCELLED tiles, a display caption and not a done-list.",
  },
  "apps/web/app/(dashboard)/orders/[id]/_components/line-status.ts": {
    count: 1,
    reason:
      "A LINE status chip (CANCELLED, DELIVERED, PARTIAL on an order line), not an order status.",
  },
  "apps/mobile/lib/order-actions.ts": {
    count: 3,
    reason:
      "The per-status action lists (CONFIRMED, OUT_FOR_DELIVERY, PARTIALLY_DELIVERED) with their DELIVERED and CANCELLED targets; REFUSED has its own case (Deliver again).",
  },
  "apps/mobile/lib/order-line-display.ts": {
    count: 1,
    reason:
      "A LINE status chip (CANCELLED, DELIVERED, PARTIAL on an order line), not an order status.",
  },
  "apps/mobile/lib/order-status-flow.ts": {
    count: 3,
    reason:
      "The mirrored transition TABLE (what an order may move to next); REFUSED has its own row (Deliver again).",
  },
};

describe("terminal-order-status-lists (SA-1101 P-1)", () => {
  const all = ROOTS.flatMap((r) => walk(path.join(REPO, r)));
  const byFile = new Map<string, string[]>();
  for (const f of all) {
    const v = violationsIn(f);
    if (v.length) byFile.set(path.relative(REPO, f).replace(/\\/g, "/"), v);
  }

  it("walks a believable number of files", () => {
    expect(all.length).toBeGreaterThan(1500);
  });

  it("no list or chain names DELIVERED and CANCELLED without REFUSED or a shared name (beyond EXEMPT)", () => {
    const bad: string[] = [];
    for (const [file, hits] of byFile) {
      const allowed = EXEMPT[file]?.count ?? 0;
      if (hits.length > allowed) bad.push(...hits);
    }
    expect(bad).toEqual([]);
  });

  it("EXEMPT only shrinks: every entry matches its hit count exactly and carries a reason", () => {
    const stale: string[] = [];
    for (const [file, { count, reason }] of Object.entries(EXEMPT)) {
      const got = byFile.get(file)?.length ?? 0;
      if (got !== count) stale.push(`${file}: exempt ${count}, found ${got}`);
      expect(reason.length).toBeGreaterThan(10);
    }
    expect(stale).toEqual([]);
  });

  it("the API copies equal the shared lists in @routeflow/types", () => {
    expect([...TERMINAL_ORDER_STATUSES].sort()).toEqual([...SHARED_TERMINAL].sort());
    expect([...POST_DELIVERY_ORDER_STATUSES].sort()).toEqual([...SHARED_POST_DELIVERY].sort());
  });

  it("routes.service.ts holds no blind DELIVERED write and calls applyStopOutcomes exactly twice (G4)", () => {
    const src = fs.readFileSync(path.join(REPO, "apps/api/src/routes/routes.service.ts"), "utf8");
    expect(src).not.toMatch(/data:\s*\{\s*status:\s*OrderStatus\.DELIVERED\s*\}/);
    expect(src.match(/applyStopOutcomes\(/g)?.length).toBe(2);
  });
});

// UX guide B12: "in progress" is one list, and every status is classified exactly once.
describe("ACTIVE_ORDER_STATUSES (UX guide B12)", () => {
  it("guard: the API copy equals the shared list", () => {
    expect([...ACTIVE_ORDER_STATUSES].sort()).toEqual([...SHARED_ACTIVE].sort());
  });

  it("guard: every order status is exactly one of DRAFT, active or terminal (a ninth status fails until classified)", () => {
    const groups: string[][] = [["DRAFT"], [...SHARED_ACTIVE], [...SHARED_TERMINAL]];
    for (const status of ORDER_STATUS_VALUES) {
      expect({ status, groups: groups.filter((g) => g.includes(status)).length }).toEqual({
        status,
        groups: 1,
      });
    }
  });
});
