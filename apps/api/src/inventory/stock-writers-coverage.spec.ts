import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * B562 PR-2 (SA-136 §6.2) — writer coverage for the stock-ledger invariant (§1): every write to
 * `Product.currentStock` appends a StockMovement for that product in the same transaction.
 *
 * Every `currentStock: { increment | decrement }` property, every ABSOLUTE `currentStock: <value>`
 * inside a Prisma `data` / `create` / `update` payload (B562 PR-3, SA-136b), and every raw-SQL
 * `SET "currentStock"` under apps/api/src (non-spec `.ts`) is a WRITE SITE. A site is PAIRED when the nearest enclosing
 * function (class method, function declaration, arrow or function expression — free functions too,
 * since `orders/order-stock.ts` is a module of functions) also contains a movement write:
 * `<x>.stockMovement.create(...)` / `createMany(...)`, or a call to one of the shared movement
 * writers below. AST, not regex: a comment or a string never counts.
 *
 * A site that is not paired fails the build unless it is on ALLOW_UNPAIRED, which may only SHRINK
 * (UNPAIRED_BASELINE forces it): a new writer without its ledger row is a red `npm run verify`.
 */

/** Shared movement writers: a call to one of these pairs the site that calls it. */
const MOVEMENT_WRITERS = new Set(["recordSaleMovement", "bookRestockMovement"]);

/** `<file>::<enclosing function>` → why the counter write has no movement in the same function. */
const ALLOW_UNPAIRED: Record<string, string> = {
  // SA-136 §7 "out of scope, filed separately": the vendor-bill un-receive DELETES the bill's PURCHASE
  // movement(s) and decrements the counter by the same pieces, so Σquantity still equals the counter
  // (no gap) — but the receipt's history is erased instead of reversed by an appended row.
  // SA-767 L-1: the tx body is now the `runBody` closure that retryOnTxConflict re-runs (same site).
  "vendor-bills/vendor-bills.service.ts::VendorBillsService.revertToDraft.runBody":
    "un-receive deletes the PURCHASE row instead of appending a reversal (filed separately, SA-136 §7)",
};
/** The RATCHET: may only go DOWN. */
const UNPAIRED_BASELINE = 1;

/**
 * B562 PR-3 (SA-136b): a write made through `this.prisma…` / `prisma.…` rather than a transaction
 * client is NON-ATOMIC — its movement row (even when the same function writes one) can commit
 * without it, or it without the row. Such a site must be listed here; the list may only shrink.
 */
const ALLOW_NON_ATOMIC: Record<string, string> = {
  // SA-136b: the Zoho stock sync SETS the counter, then writes its ADJUSTMENT row in a second call,
  // with the quantity from a pre-read. Paired, but non-atomic. Filed on its own item.
  "import/import.service.ts::ImportService.importInventory":
    "paired, non-atomic, filed (SA-136b; absolute set + separate ADJUSTMENT row, pre-read delta)",
};
const NON_ATOMIC_BASELINE = 1;

const SRC_ROOT = path.resolve(__dirname, "..");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

const parse = (name: string, text: string) =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);

const isFunctionLike = (n: ts.Node) =>
  ts.isMethodDeclaration(n) ||
  ts.isFunctionDeclaration(n) ||
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) ||
  ts.isConstructorDeclaration(n);

/** The name a reviewer would look for: `Class.method`, `fn`, or `<outer>.<const arrow>`. */
function functionName(fn: ts.Node, sf: ts.SourceFile): string {
  const own = (n: ts.Node): string | null => {
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name)
      return n.name.getText(sf);
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent))
      return n.parent.name.getText(sf);
    return null;
  };
  const parts: string[] = [];
  for (let c: ts.Node | undefined = fn; c; c = c.parent) {
    if (isFunctionLike(c)) {
      const name = own(c);
      if (name) parts.unshift(name);
    }
    if (ts.isClassDeclaration(c) && c.name) parts.unshift(c.name.text);
  }
  return parts.join(".") || "<anonymous>";
}

function nearestFunction(n: ts.Node): ts.Node | null {
  for (let c: ts.Node | undefined = n.parent; c; c = c.parent) if (isFunctionLike(c)) return c;
  return null;
}

/** Write sites: `currentStock: { increment|decrement: … }` and raw SQL that SETs "currentStock". */
function stockWriteSites(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isPropertyAssignment(n) &&
      n.name.getText(sf) === "currentStock" &&
      ts.isObjectLiteralExpression(n.initializer) &&
      n.initializer.properties.some(
        (p) => p.name && ["increment", "decrement"].includes(p.name.getText(sf)),
      )
    )
      out.push(n);
    // Absolute: `currentStock: <non-object>` as a key of a payload object (`data:` / `create:` /
    // `update:`), so a response mapping like `{ ...p, currentStock: Number(p.currentStock) }` is not
    // a site.
    if (
      ts.isPropertyAssignment(n) &&
      n.name.getText(sf) === "currentStock" &&
      !ts.isObjectLiteralExpression(n.initializer) &&
      ts.isObjectLiteralExpression(n.parent) &&
      ts.isPropertyAssignment(n.parent.parent) &&
      ["data", "create", "update"].includes(n.parent.parent.name.getText(sf))
    )
      out.push(n);
    if (ts.isTaggedTemplateExpression(n)) {
      const text = n.template.getText(sf);
      if (/SET\s+"currentStock"/i.test(text)) out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** True when `fn` (nested functions included) writes a StockMovement or calls a shared writer. */
function writesMovement(fn: ts.Node, sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ["create", "createMany"].includes(callee.name.text) &&
        ts.isPropertyAccessExpression(callee.expression) &&
        callee.expression.name.text === "stockMovement"
      )
        found = true;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name && MOVEMENT_WRITERS.has(name)) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  void sf;
  return found;
}

/**
 * True when the site's Prisma call goes through the ambient client (`this.prisma…` / `prisma.…`)
 * instead of a transaction client handed in (`tx`, `db`, a callback parameter).
 */
function viaAmbientClient(site: ts.Node, sf: ts.SourceFile): boolean {
  for (let c: ts.Node | undefined = site.parent; c; c = c.parent) {
    if (ts.isCallExpression(c) || ts.isTaggedTemplateExpression(c)) {
      const callee = ts.isCallExpression(c) ? c.expression : c.tag;
      const text = callee.getText(sf).replace(/\s+/g, "");
      if (/\.(update|updateMany|upsert|create|createMany|\$executeRaw|\$queryRaw)\w*$/.test(text))
        return /^(this\.prisma|prisma)\b/.test(text);
    }
    if (isFunctionLike(c)) return false;
  }
  return false;
}

interface Site {
  key: string;
  line: number;
  paired: boolean;
  ambient: boolean;
}

function scan(rel: string, text: string): Site[] {
  const sf = parse(rel, text);
  return stockWriteSites(sf).map((site) => {
    const fn = nearestFunction(site);
    return {
      key: `${rel}::${fn ? functionName(fn, sf) : "<module>"}`,
      line: sf.getLineAndCharacterOfPosition(site.getStart()).line + 1,
      paired: fn != null && writesMovement(fn, sf),
      ambient: viaAmbientClient(site, sf),
    };
  });
}

describe("stock-ledger writer coverage (B562 SA-136 §6.2)", () => {
  const sites = collectSourceFiles(SRC_ROOT).flatMap((abs) =>
    scan(path.relative(SRC_ROOT, abs).split(path.sep).join("/"), fs.readFileSync(abs, "utf8")),
  );

  it("finds the known writers (the scan is live, not vacuous)", () => {
    const keys = new Set(sites.map((s) => s.key));
    expect(keys).toContain("orders/order-stock.ts::decrementStockForSale");
    expect(keys).toContain("orders/order-stock.ts::settleStockForEdit");
    expect(keys).toContain("inventory/inventory.service.ts::InventoryService.recordPurchase");
    expect(sites.length).toBeGreaterThan(10);
  });

  it("every currentStock write is paired with a StockMovement in the same function", () => {
    const unpaired = sites
      .filter((s) => !s.paired && !(s.key in ALLOW_UNPAIRED))
      .map((s) => `${s.key} (line ${s.line})`);
    expect(unpaired).toEqual([]);
  });

  it("the allow-list only names live, still-unpaired sites and never grows", () => {
    const unpairedKeys = new Set(sites.filter((s) => !s.paired).map((s) => s.key));
    for (const key of Object.keys(ALLOW_UNPAIRED)) expect(unpairedKeys).toContain(key);
    expect(Object.keys(ALLOW_UNPAIRED).length).toBeLessThanOrEqual(UNPAIRED_BASELINE);
  });

  it("B562 PR-3: every stock write outside a transaction is listed, and the list never grows", () => {
    const ambient = sites.filter((s) => s.ambient);
    const unlisted = ambient
      .filter((s) => !(s.key in ALLOW_NON_ATOMIC))
      .map((s) => `${s.key} (line ${s.line})`);
    expect(unlisted).toEqual([]);
    const ambientKeys = new Set(ambient.map((s) => s.key));
    for (const key of Object.keys(ALLOW_NON_ATOMIC)) expect(ambientKeys).toContain(key);
    expect(Object.keys(ALLOW_NON_ATOMIC).length).toBeLessThanOrEqual(NON_ATOMIC_BASELINE);
  });

  // ── positive controls on inline source (the classifier itself) ───────────────────────────────
  it("control: an increment with no movement in its function is unpaired", () => {
    const [s] = scan(
      "x.ts",
      "class S { async m(tx) { await tx.product.update({ data: { currentStock: { increment: 1 } } }); } }",
    );
    expect(s).toMatchObject({ key: "x.ts::S.m", paired: false });
  });

  it("control: a raw-SQL SET currentStock paired by recordSaleMovement in a free function", () => {
    const [s] = scan(
      "x.ts",
      'async function f(tx) { await tx.$queryRaw`UPDATE "Product" SET "currentStock" = 1`; await recordSaleMovement(tx, {}); }',
    );
    expect(s).toMatchObject({ key: "x.ts::f", paired: true });
  });

  it("control: a movement in a DIFFERENT function does not pair the write", () => {
    const sites2 = scan(
      "x.ts",
      "class S { a(tx) { tx.product.update({ data: { currentStock: { decrement: 2 } } }); } b(tx) { tx.stockMovement.create({}); } }",
    );
    expect(sites2).toEqual([expect.objectContaining({ key: "x.ts::S.a", paired: false })]);
  });

  it("control: an absolute set in a data payload is a site; a response mapping is not", () => {
    const found = scan(
      "x.ts",
      "class S { async m(tx, p) { await tx.product.update({ data: { currentStock: 5 } }); return { ...p, currentStock: Number(p.currentStock) }; } }",
    );
    expect(found).toEqual([expect.objectContaining({ key: "x.ts::S.m", paired: false })]);
  });

  it("control: a write through this.prisma is ambient; one through tx is not", () => {
    const [a, b] = scan(
      "x.ts",
      "class S { async a() { await this.prisma.forTenant().product.update({ data: { currentStock: 1 } }); } async b(tx) { await tx.product.update({ data: { currentStock: { increment: 1 } } }); } }",
    );
    expect(a).toMatchObject({ key: "x.ts::S.a", ambient: true });
    expect(b).toMatchObject({ key: "x.ts::S.b", ambient: false });
  });

  it("control: a comment or string mentioning the pattern is not a site", () => {
    expect(
      scan("x.ts", '// currentStock: { increment: 1 }\nconst s = "SET \\"currentStock\\"";'),
    ).toEqual([]);
  });
});

/**
 * SA-767 L-2 (spec G4, pin 2): a stock / cost WRITER in inventory.service.ts locks the Product rows
 * (`lockProductsForStock` through `this.lockProducts`) BEFORE it reads a Product value it writes
 * from, or it is on a NAMED table below. Predicate (SA r-note Nit 5): a method that writes
 * `Product.currentStock` / `averageCost`, a `StockLot` or a `StockMovement`. A NEW writer is not in
 * the table, so it fails the build until it locks (XS to fix: call the helper) or is named with a
 * reason a reviewer can challenge.
 *
 * AST over each class method of `InventoryService` (closures inside a method count as the method).
 */
const INVENTORY_SERVICE = "inventory/inventory.service.ts";

/** Calls that take the Product row locks. */
const LOCK_CALL = /^(?:this\.lockProducts|lockProductsForStock)$/;
/** A Product value read (or written) through the tx - or the helper that reads the locked rows. */
const PRODUCT_ACCESS_CALL =
  /^(?:tx\.product\.(?:findUnique|findFirst|findMany|update|updateMany|upsert)|this\.readLockedStockRows)$/;

type WriterClass =
  | { kind: "locks-first" }
  | { kind: "guarded"; where: string }
  | { kind: "caller-locked"; callers: string[] }
  | { kind: "later"; reason: string };

/** `InventoryService.<method>` -> how the writer is made safe. Every live writer is listed. */
const INVENTORY_WRITERS: Record<string, WriterClass> = {
  // SA-767 L-2: lock first, then read in-tx (this pin checks the order).
  "InventoryService.recordPurchase": { kind: "locks-first" },
  "InventoryService.recordAdjustment": { kind: "locks-first" },
  "InventoryService.recordSale": { kind: "locks-first" },
  "InventoryService.assignToVariants": { kind: "locks-first" },
  "InventoryService.commitStockCount": { kind: "locks-first" },
  "InventoryService.commitStockCountSession": { kind: "locks-first" },
  "InventoryService.setCostBasis": { kind: "locks-first" },
  "InventoryService.bulkSetCostBasis": { kind: "locks-first" },
  // SA-767 L-1: domain row -> Products -> reads, pinned in common/product-locks.guard.spec.ts.
  "InventoryService.receivePurchaseOrder": {
    kind: "guarded",
    where: "common/product-locks.guard.spec.ts (domain lock < lockProducts < first Product read)",
  },
  "InventoryService.updatePurchaseOrder": {
    kind: "guarded",
    where: "common/product-locks.guard.spec.ts (domain lock < lockProducts < first Product read)",
  },
  // Private bodies that only ever run inside a locked caller.
  "InventoryService.applyStockCountItemsInTx": {
    kind: "caller-locked",
    callers: ["commitStockCount", "commitStockCountSession"],
  },
  "InventoryService.setCostBasisInTx": {
    kind: "caller-locked",
    callers: ["setCostBasis", "bulkSetCostBasis", "commitStockCountSession"],
  },
  "InventoryService.postPoReceipt": {
    kind: "caller-locked",
    callers: ["receivePurchaseOrder", "updatePurchaseOrder"],
  },
  "InventoryService.reversePoReceipts": {
    kind: "caller-locked",
    callers: ["updatePurchaseOrder"],
  },
  // Assigned to a later SA-767 PR: named so they cannot grow silently.
  "InventoryService.replayProduct": {
    kind: "later",
    reason: "SA-767 L-3: cost replay locks each product with the helper and re-reads it in-tx",
  },
  "InventoryService.recomputeProductInTx": {
    kind: "later",
    reason: "SA-767 L-3: takes the product lock itself (calls replayProduct)",
  },
  "InventoryService.recomputeCosts": {
    kind: "later",
    reason:
      "SA-767 L-3: locks each product inside its own tx and re-reads it (calls replayProduct)",
  },
};
const LATER_REASON = /^(?:SA-767 L-[345]\b|new-row create\b)/;

interface MethodInfo {
  writes: boolean;
  lockPos: number;
  accessPos: number;
  calls: Map<string, number[]>;
}

/** True when `n` sits in a `data` / `create` / `update` payload (through spreads and conditionals). */
function inWritePayload(n: ts.Node): boolean {
  for (let c: ts.Node | undefined = n.parent; c; c = c.parent) {
    if (ts.isPropertyAssignment(c))
      return ["data", "create", "update"].includes((c.name as ts.Identifier).text);
    if (isFunctionLike(c) || ts.isBlock(c)) return false;
  }
  return false;
}

function isStockWriteNode(n: ts.Node, sf: ts.SourceFile): boolean {
  if (ts.isPropertyAssignment(n)) {
    const name = n.name.getText(sf);
    if (name === "currentStock" && ts.isObjectLiteralExpression(n.initializer))
      return n.initializer.properties.some(
        (p) => p.name && ["increment", "decrement"].includes(p.name.getText(sf)),
      );
    if (
      (name === "currentStock" || name === "averageCost") &&
      !ts.isObjectLiteralExpression(n.initializer) &&
      inWritePayload(n)
    )
      return true;
  }
  if (ts.isCallExpression(n)) {
    const callee = n.expression.getText(sf).replace(/\s+/g, "");
    if (
      /\.(?:stockLot|stockMovement)\.(?:create|createMany|update|updateMany|delete|deleteMany|upsert)$/.test(
        callee,
      )
    )
      return true;
  }
  if (ts.isTaggedTemplateExpression(n) && /SET\s+"currentStock"/i.test(n.template.getText(sf)))
    return true;
  return false;
}

/** Every class method -> its writer flag (direct, or by calling a writer), first lock position, first Product access, `this.x(` calls. */
function analyzeClasses(rel: string, text: string): Map<string, MethodInfo> {
  const sf = parse(rel, text);
  const out = new Map<string, MethodInfo>();
  ts.forEachChild(sf, (top) => {
    if (!ts.isClassDeclaration(top) || !top.name) return;
    const className = top.name.text;
    for (const m of top.members) {
      if (!ts.isMethodDeclaration(m) || !m.body) continue;
      const info: MethodInfo = {
        writes: false,
        lockPos: Infinity,
        accessPos: Infinity,
        calls: new Map(),
      };
      const visit = (n: ts.Node) => {
        if (isStockWriteNode(n, sf)) info.writes = true;
        if (ts.isCallExpression(n)) {
          const callee = n.expression.getText(sf).replace(/\s+/g, "");
          const pos = n.getStart(sf);
          if (LOCK_CALL.test(callee)) info.lockPos = Math.min(info.lockPos, pos);
          if (PRODUCT_ACCESS_CALL.test(callee)) info.accessPos = Math.min(info.accessPos, pos);
          const self = /^this\.(\w+)$/.exec(callee);
          if (self) info.calls.set(self[1], [...(info.calls.get(self[1]) ?? []), pos]);
        }
        ts.forEachChild(n, visit);
      };
      visit(m.body);
      out.set(`${className}.${m.name.getText(sf)}`, info);
    }
    // A method that calls a writer is a writer entry point too (its own body may write nothing).
    for (let grew = true; grew;) {
      grew = false;
      for (const [k, info] of out) {
        if (info.writes || !k.startsWith(`${className}.`)) continue;
        if ([...info.calls.keys()].some((c) => out.get(`${className}.${c}`)?.writes)) {
          info.writes = true;
          grew = true;
        }
      }
    }
  });
  return out;
}

/** The problems of one file's writers against a classification table (empty = compliant). */
function stockWriterProblems(
  methods: Map<string, MethodInfo>,
  table: Record<string, WriterClass>,
): string[] {
  const problems: string[] = [];
  const writers = [...methods].filter(([, i]) => i.writes).map(([k]) => k);
  for (const k of writers)
    if (!(k in table))
      problems.push(`${k}: an unclassified stock writer - lock first via lockProducts, or name it`);
  for (const k of Object.keys(table))
    if (!writers.includes(k)) problems.push(`${k}: listed but no longer a stock writer`);
  for (const [k, cls] of Object.entries(table)) {
    const info = methods.get(k);
    if (!info?.writes) continue;
    if (cls.kind === "locks-first") {
      if (!Number.isFinite(info.lockPos)) problems.push(`${k}: never takes the Product lock`);
      else if (info.accessPos < info.lockPos)
        problems.push(`${k}: reads/writes a Product before taking the lock`);
    } else if (cls.kind === "caller-locked") {
      const [klass, helper] = k.split(".");
      for (const caller of cls.callers) {
        const c = methods.get(`${klass}.${caller}`);
        const calls = c?.calls.get(helper) ?? [];
        if (!c || calls.length === 0) problems.push(`${k}: caller ${caller} no longer calls it`);
        else if (table[`${klass}.${caller}`]?.kind === "locks-first" && calls[0] < c.lockPos)
          problems.push(`${k}: ${caller} calls it before taking the lock`);
      }
    } else if (cls.kind === "later" && !LATER_REASON.test(cls.reason)) {
      problems.push(`${k}: allow-list reason must name SA-767 L-3/L-4/L-5 or "new-row create"`);
    }
  }
  return problems;
}

describe("SA-767 L-2 - every InventoryService stock writer locks before it reads (G4 pin 2)", () => {
  const methods = analyzeClasses(
    INVENTORY_SERVICE,
    fs.readFileSync(path.join(SRC_ROOT, INVENTORY_SERVICE), "utf8"),
  );

  it("the scan is live: it sees the known writers and the lock call", () => {
    expect(methods.get("InventoryService.recordPurchase")).toMatchObject({ writes: true });
    expect(methods.get("InventoryService.setCostBasisInTx")).toMatchObject({ writes: true });
    expect(Number.isFinite(methods.get("InventoryService.recordPurchase")!.lockPos)).toBe(true);
    expect([...methods.values()].filter((m) => m.writes).length).toBeGreaterThan(10);
  });

  it("every writer is locks-first, guarded, caller-locked, or named for a later PR", () => {
    expect(stockWriterProblems(methods, INVENTORY_WRITERS)).toEqual([]);
  });

  describe("the pin has teeth (inline sources)", () => {
    const table: Record<string, WriterClass> = {
      "S.good": { kind: "locks-first" },
    };
    const run = (src: string, t = table) => stockWriterProblems(analyzeClasses("x.ts", src), t);

    it("a compliant writer passes", () => {
      expect(
        run(
          "class S { async good(tx) { await this.lockProducts(tx, ['a']); await tx.product.update({ data: { currentStock: { increment: 1 } } }); } }",
        ),
      ).toEqual([]);
    });

    it("a NEW writer that is not in the table fails", () => {
      const problems = run(
        "class S { async good(tx) { await this.lockProducts(tx, []); tx.stockMovement.create({}); } async fresh(tx) { await tx.stockLot.create({}); } }",
      );
      expect(problems).toEqual([expect.stringContaining("S.fresh: an unclassified stock writer")]);
    });

    it("a locks-first writer that reads a Product before the lock fails", () => {
      const problems = run(
        "class S { async good(tx) { const p = await tx.product.findUnique({}); await this.lockProducts(tx, ['a']); await tx.stockMovement.create({}); } }",
      );
      expect(problems).toEqual([expect.stringContaining("before taking the lock")]);
    });

    it("a locks-first writer that never locks fails", () => {
      const problems = run(
        "class S { async good(tx) { await tx.product.update({ data: { averageCost: 1 } }); } }",
      );
      expect(problems).toEqual([expect.stringContaining("never takes the Product lock")]);
    });

    it("a stale table entry fails, and so does a later-PR entry without an SA-767 reason", () => {
      expect(run("class S { async other() {} }")).toEqual(
        expect.arrayContaining([expect.stringContaining("no longer a stock writer")]),
      );
      const later: Record<string, WriterClass> = { "S.w": { kind: "later", reason: "TODO" } };
      expect(run("class S { async w(tx) { await tx.stockLot.create({}); } }", later)).toEqual([
        expect.stringContaining("must name SA-767 L-3/L-4/L-5"),
      ]);
    });

    it("a caller-locked helper called before its caller's lock fails", () => {
      const t: Record<string, WriterClass> = {
        "S.caller": { kind: "locks-first" },
        "S.helper": { kind: "caller-locked", callers: ["caller"] },
      };
      const src = (body: string) =>
        `class S { async caller(tx) { ${body} } async helper(tx) { await tx.stockLot.create({}); } }`;
      expect(
        run(
          src(
            "await this.lockProducts(tx, []); await this.helper(tx); tx.stockMovement.create({});",
          ),
          t,
        ),
      ).toEqual([]);
      expect(
        run(
          src(
            "await this.helper(tx); await this.lockProducts(tx, []); tx.stockMovement.create({});",
          ),
          t,
        ),
      ).toEqual([expect.stringContaining("calls it before taking the lock")]);
    });
  });
});
