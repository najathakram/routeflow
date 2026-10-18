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
const ALLOW_UNPAIRED: Record<string, string> = {};
/** The RATCHET: may only go DOWN. */
const UNPAIRED_BASELINE = 0;

/**
 * B562 PR-3 (SA-136b): a write made through `this.prisma…` / `prisma.…` rather than a transaction
 * client is NON-ATOMIC — its movement row (even when the same function writes one) can commit
 * without it, or it without the row. Such a site must be listed here; the list may only shrink.
 */
const ALLOW_NON_ATOMIC: Record<string, string> = {};
const NON_ATOMIC_BASELINE = 0;

const SRC_ROOT = path.resolve(__dirname, "..");

/**
 * DB-spec seed fixtures that set up counters directly (a historic booked state), never production writers.
 * Named files, not a directory: a new writer under a `testing/` folder still fails this census.
 */
const SEED_FIXTURES = new Set(["inventory/testing/order-stock-world.ts"]);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) continue;
    if (SEED_FIXTURES.has(path.relative(SRC_ROOT, full).split(path.sep).join("/"))) continue;
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
  // SA-767 L-2.2: the session commit is a chain: commitStockCountSession (pre-checks + the
  // stock-count advisory lock) -> commitStockCountBatches (the batch loop + the CAS) ->
  // commitStockCountBatch (ONE short tx, locks first). The first two write nothing themselves.
  "InventoryService.commitStockCountBatch": { kind: "locks-first" },
  "InventoryService.commitStockCountBatches": {
    kind: "guarded",
    where: "delegates every Product write to commitStockCountBatch (locks-first; L-2.2 pins below)",
  },
  "InventoryService.commitStockCountSession": {
    kind: "guarded",
    where: "delegates every Product write to commitStockCountBatch (locks-first; L-2.2 pins below)",
  },
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
    callers: ["commitStockCount", "commitStockCountBatch"],
  },
  "InventoryService.setCostBasisInTx": {
    kind: "caller-locked",
    callers: ["setCostBasis", "bulkSetCostBasis", "commitStockCountBatch"],
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
  /** The body itself holds a stock write (as opposed to only calling a function that does). */
  direct?: boolean;
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

/**
 * SA-767 R6 (SA must 1): the SAME predicate over ALL non-spec `apps/api/src`, not just InventoryService. A function
 * (class method or free function; closures count as their parent) that writes `Product.currentStock` /
 * `averageCost`, a `StockLot` or a `StockMovement` either takes the Product row locks before its first Product
 * access (locks-first) or is NAMED below with a reason a reviewer can challenge. A new writer anywhere fails the
 * build until it locks or is named; a stale entry fails too.
 */
const OTHER_WRITERS: Record<string, string> = {
  // The returns restock chain writes stock without the Product lock: SA-767 L-4 moves it under the helper.
  "returns/returns-restock.util.ts::bookRestockMovement":
    "SA-767 L-4/L-5: returns restock books the movement and counter without the Product lock",
  "returns/returns.service.ts::ReturnsService.cancel":
    "SA-767 L-4/L-5: a return cancel re-takes stock without the Product lock",
  "returns/inline-returns.service.ts::InlineReturnsService.cancel":
    "SA-767 L-4/L-5: an inline-return cancel re-takes stock without the Product lock",
  // The Zoho product import CREATES rows with their opening stock: nothing exists to lock yet.
  "products/products.service.ts::ProductsService.importFromZoho":
    "new-row create: opening stock is written on a product created in the same transaction",
  // Not a stock-value write: it nulls a link on the stock tables only.
  "suppliers/suppliers.service.ts::SuppliersService.remove":
    "link null: nulls StockMovement.supplierId only; no quantity, cost or lot changes",
};

const OTHER_REASON = /^(?:SA-767 L-[45]\b|new-row create\b|row delete\b|link null\b)/;
/** The lock call as written anywhere in the tree (`this.inventory.lockProducts(...)` included). */
const WIDE_LOCK_CALL = /(?:^|\.)(?:lockProducts|lockProductsForStock)$/;
/** Test support, not production code. */
const OTHER_WRITERS_SKIP = /(?:^|\/)testing\//;

/** Every named function (class method, function declaration, `const f = () => ...`) of a file -> its writer facts. */
function analyzeFileFunctions(rel: string, text: string): Map<string, MethodInfo> {
  const sf = parse(rel, text);
  const out = new Map<string, MethodInfo>();
  const measure = (body: ts.Node): MethodInfo => {
    const info: MethodInfo = {
      writes: false,
      lockPos: Infinity,
      accessPos: Infinity,
      calls: new Map(),
    };
    const visit = (n: ts.Node) => {
      if (isStockWriteNode(n, sf)) {
        info.writes = true;
        info.direct = true;
      }
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf).replace(/\s+/g, "");
        const pos = n.getStart(sf);
        if (WIDE_LOCK_CALL.test(callee)) info.lockPos = Math.min(info.lockPos, pos);
        if (PRODUCT_ACCESS_CALL.test(callee)) info.accessPos = Math.min(info.accessPos, pos);
        const last = /(\w+)$/.exec(callee);
        if (last) info.calls.set(last[1], [...(info.calls.get(last[1]) ?? []), pos]);
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return info;
  };
  ts.forEachChild(sf, (top) => {
    if (ts.isClassDeclaration(top) && top.name) {
      for (const m of top.members) {
        if (ts.isMethodDeclaration(m) && m.body) {
          out.set(`${rel}::${top.name.text}.${m.name.getText(sf)}`, measure(m.body));
        }
      }
    } else if (ts.isFunctionDeclaration(top) && top.name && top.body) {
      out.set(`${rel}::${top.name.text}`, measure(top.body));
    } else if (ts.isVariableStatement(top)) {
      for (const d of top.declarationList.declarations) {
        const init = d.initializer;
        if (
          ts.isIdentifier(d.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          out.set(`${rel}::${d.name.text}`, measure(init.body));
        }
      }
    }
  });
  // A function that calls a local writer is a writer entry point too (its own body may write nothing).
  for (let grew = true; grew;) {
    grew = false;
    for (const [k, info] of out) {
      if (info.writes) continue;
      const file = k.split("::")[0];
      const cls = k.split("::")[1].includes(".") ? k.split("::")[1].split(".")[0] + "." : "";
      if (
        [...info.calls.keys()].some(
          (c) => out.get(`${file}::${cls}${c}`)?.writes || out.get(`${file}::${c}`)?.writes,
        )
      ) {
        info.writes = true;
        grew = true;
      }
    }
  }
  return out;
}

/**
 * The writers of other files that neither lock first, nor are a helper EVERY caller of which locks first before it
 * calls it (derived, not declared), nor are named (empty = compliant).
 */
function otherWriterProblems(
  all: Map<string, MethodInfo>,
  table: Record<string, string>,
): string[] {
  const problems: string[] = [];
  // a function that only CALLS a writer is checked through that writer, not on its own
  const writers = [...all].filter(([, i]) => i.direct);
  const lockedFirst = (i: MethodInfo) => Number.isFinite(i.lockPos) && i.accessPos >= i.lockPos;
  const simple = (k: string) => k.split("::")[1].split(".").pop() as string;
  const covered = new Set<string>(writers.filter(([, i]) => lockedFirst(i)).map(([k]) => k));
  // A helper whose every caller (by name, anywhere in the tree) calls it after locking first is covered too.
  for (let grew = true; grew;) {
    grew = false;
    for (const [k] of writers) {
      if (covered.has(k) || k in table) continue;
      const name = simple(k);
      const callers = [...all].filter(([ck, ci]) => ck !== k && ci.calls.has(name));
      const ok =
        callers.length > 0 &&
        callers.every(
          ([ck, ci]) =>
            covered.has(ck) ||
            (Number.isFinite(ci.lockPos) && (ci.calls.get(name) ?? [0])[0] > ci.lockPos),
        );
      if (ok) {
        covered.add(k);
        grew = true;
      }
    }
  }
  for (const [k] of writers) {
    if (covered.has(k) || k in table) continue;
    problems.push(
      `${k}: a stock writer that does not lock first - lock via lockProductsForStock, or name it`,
    );
  }
  const writerKeys = new Set(writers.map(([k]) => k));
  for (const [k, why] of Object.entries(table)) {
    if (!writerKeys.has(k)) problems.push(`${k}: listed but no longer a stock writer`);
    else if (covered.has(k))
      problems.push(`${k}: listed but it now locks first - remove the entry`);
    else if (!OTHER_REASON.test(why))
      problems.push(
        `${k}: allow-list reason must name SA-767 L-4/L-5, "new-row create" or "link null"`,
      );
  }
  return problems;
}

describe("SA-767 R6 - every stock writer outside InventoryService locks first or is named (G4 pin 2, whole tree)", () => {
  const all = new Map<string, MethodInfo>();
  for (const abs of collectSourceFiles(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, abs).split(path.sep).join("/");
    if (rel === INVENTORY_SERVICE || OTHER_WRITERS_SKIP.test(rel)) continue;
    for (const [k, v] of analyzeFileFunctions(rel, fs.readFileSync(abs, "utf8"))) all.set(k, v);
  }

  it("the scan is live: it sees writers outside InventoryService", () => {
    expect([...all.values()].filter((i) => i.writes).length).toBeGreaterThan(5);
    expect(all.get("orders/order-stock.ts::decrementStockForSale")).toMatchObject({ writes: true });
  });

  it("every such writer is locks-first or on the named allow-list", () => {
    expect(otherWriterProblems(all, OTHER_WRITERS)).toEqual([]);
  });

  describe("the pin has teeth (inline sources)", () => {
    const run = (src: string, t: Record<string, string> = {}) =>
      otherWriterProblems(analyzeFileFunctions("x.ts", src), t);

    it("a free-function writer that locks first passes; one that does not fails until named", () => {
      const good =
        "async function f(tx) { await lockProductsForStock(tx, []); await tx.product.update({ data: { currentStock: { increment: 1 } } }); }";
      expect(run(good)).toEqual([]);
      const bad = "const g = async (tx) => { await tx.stockLot.create({}); };";
      expect(run(bad)).toEqual([
        expect.stringContaining("x.ts::g: a stock writer that does not lock first"),
      ]);
      expect(run(bad, { "x.ts::g": "SA-767 L-4: restock" })).toEqual([]);
    });

    it("a stale entry or an entry without an SA-767 L-4/L-5 reason fails", () => {
      expect(run("function h() {}", { "x.ts::h": "SA-767 L-4: gone" })).toEqual([
        expect.stringContaining("listed but no longer a stock writer"),
      ]);
      expect(
        run("const g = async (tx) => { await tx.stockLot.create({}); };", { "x.ts::g": "TODO" }),
      ).toEqual([expect.stringContaining('must name SA-767 L-4/L-5, "new-row create"')]);
    });
  });
});

/**
 * SA-767 R6 (SA must 2): every stock-writer transaction has a 15 s budget (`STOCK_TX_OPTIONS`) and bounds its lock
 * waits with `lock_timeout` BEFORE its first lock. Prisma's default tx timeout is 5 s - the same as the lock timeout -
 * so an unbounded PO / bill row lock waiting behind a long holder used to surface as P2028 (an uncoded 500) before
 * 55P03 (retried, then the coded 503) could fire.
 */
describe("SA-767 R6 - stock-writer transactions carry the 15 s budget and a bounded domain-row lock wait", () => {
  const strip = (code: string) =>
    code
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length));
  const inv = strip(fs.readFileSync(path.join(SRC_ROOT, INVENTORY_SERVICE), "utf8"));
  const bills = strip(
    fs.readFileSync(path.join(SRC_ROOT, "vendor-bills/vendor-bills.service.ts"), "utf8"),
  );
  const locks = strip(fs.readFileSync(path.join(SRC_ROOT, "common/product-locks.ts"), "utf8"));

  it("the budget is 15 s and the helper bounds the wait at STOCK_LOCK_TIMEOUT, only while the tx has none", () => {
    expect(locks).toMatch(/export const STOCK_TX_OPTIONS = \{ timeout: 15_000 \} as const/);
    expect(locks).toMatch(
      /export async function setStockLockTimeout[\s\S]*?set_config\('lock_timeout', \$\{STOCK_LOCK_TIMEOUT\}, true\) WHERE current_setting\('lock_timeout'\) = '0'/,
    );
    expect(inv).toMatch(/private stockTx<T>[\s\S]*?tenantTransaction\(fn, STOCK_TX_OPTIONS\)/);
  });

  it.each([
    "recordPurchase",
    "recordAdjustment",
    "commitStockCount",
    "setCostBasis",
    "bulkSetCostBasis",
    "receivePurchaseOrder",
    "updatePurchaseOrder",
  ])("InventoryService.%s runs its transaction through stockTx inside retryStockTx", (name) => {
    expect(inv).toMatch(
      new RegExp(`retryStockTx\\("inventory\\.${name}", \\(\\) =>\\s+this\\.stockTx\\(`),
    );
  });

  it("the PurchaseOrder row lock (taken BEFORE the Product rows) is preceded by the lock_timeout bound", () => {
    expect(inv).toMatch(
      /private async lockPurchaseOrder\([^)]*\) \{[\s\S]*?await setStockLockTimeout\(tx\);[\s\S]*?FOR UPDATE/,
    );
  });

  it.each(["receive", "revertToDraft", "voidBill"])(
    "VendorBillsService.%s: the 15 s budget, and the bill row lock waits at most the lock timeout",
    (name) => {
      expect(bills).toMatch(
        new RegExp(
          `retryStockTx\\("vendorBills\\.${name}", \\(\\) =>\\s+this\\.prisma\\.tenantTransaction\\(runBody, STOCK_TX_OPTIONS\\)`,
        ),
      );
    },
  );

  it("each bill stock transaction body sets the bound BEFORE it locks the bill row", () => {
    const bodies = bills.split("const runBody = async (tx: any) => {").slice(1);
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    for (const b of bodies) {
      const set = b.search(/await setStockLockTimeout\(tx\)/);
      const lock = b.search(/this\.lockBillAndAssertReceiptState\(tx, bill\)/);
      expect(set).toBeGreaterThan(-1);
      expect(set).toBeLessThan(lock);
    }
  });
});

/**
 * SA-767 L-2.2 (r-note 2 (b)): the batched count committer keeps its shape. Source pins over the
 * comment-stripped service: the chain delegates to the one batch tx, which is a retryStockTx tx that
 * locks, reads locked, and skips an already-applied line; the committer is one try-mode
 * `stock-count` advisory lock, taken before its lines are read; every edit path and discard run in
 * their own tx under the SHARED form of that lock (SA-767 L-2.4 B).
 */
describe("SA-767 L-2.2 - the batched count committer (structural pins)", () => {
  const strip = (code: string) =>
    code
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length));
  const src = strip(fs.readFileSync(path.join(SRC_ROOT, INVENTORY_SERVICE), "utf8"));
  const body = (name: string): string => {
    const head = src.search(new RegExp(`\\n  (?:private |public )?async ${name}\\(`));
    expect(head).toBeGreaterThan(-1);
    const rest = src.slice(head + 1);
    const next = rest
      .slice(1)
      .search(/\n  (?:private |public |protected )?(?:async )?\w+\(|\n  \/\*\*/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  };

  it("the session commit is ONE try-mode stock-count advisory lock around the batch loop", () => {
    const m = body("commitStockCountSession");
    expect(body("runUnderCountLock")).toMatch(
      /withAdvisoryLock\(\s*\{\s*family: "stock-count",\s*key: id,\s*mode: "try"\s*\}/,
    );
    expect(m).toMatch(/this\.runUnderCountLock\(/);
    expect(m).toMatch(/this\.commitStockCountBatches\(/);
    expect(m).toMatch(/stockCountCommitting\(\)/);
    // no transaction of its own: the Product writes live in the batch method
    expect(m).not.toMatch(/tenantTransaction/);
  });

  it("the committer re-reads the session AND its lines under the lock, before the first batch", () => {
    const m = body("commitStockCountBatches");
    const reread = m.search(
      /stockCountSession\.findUnique\(\{\s*where: \{ id \},\s*include: \{ lines: true \}/,
    );
    expect(reread).toBeGreaterThan(-1);
    expect(reread).toBeLessThan(m.search(/this\.commitStockCountBatch\(/));
    expect(body("commitStockCountSession")).not.toMatch(/commitStockCountBatch\(/);
  });

  it("finish with skips: classifies only lines with no movement, never on a transient error, and audits after the CAS", () => {
    const m = body("commitStockCountBatches");
    expect(m).toMatch(/if \(finishWithSkips\) \{/);
    expect(m).toMatch(/if \(done\.has\(l\.productId\)\) return true;/);
    // the permanent reasons are decided from the product row only (family / missing), never from a thrown error
    expect(m).toMatch(/"PRODUCT_DELETED"/);
    expect(m).toMatch(/"PRODUCT_IS_FAMILY"/);
    expect(m).not.toMatch(/stockTxRetryState|55P03|40P01/);
    const cas = m.search(/stockCountSession\.updateMany\(/);
    const audit = m.search(/"stock-count\.line-skipped"/);
    expect(cas).toBeGreaterThan(-1);
    expect(audit).toBeGreaterThan(cas);
  });

  it("the committer's 503s carry progress: LockUnavailable, retryStockTx's 503 and a raw lock error all go through lockUnavailableWithProgress", () => {
    const m = body("commitStockCountSession");
    expect(m).toMatch(/e instanceof LockUnavailableError/);
    expect(m).toMatch(/API_ERROR_CODES\.LOCK_UNAVAILABLE/);
    expect(m).toMatch(/stockTxRetryState\(e\) !== null/);
    expect(m).toMatch(/throw await this\.lockUnavailableWithProgress\(id\)/);
    const p = body("lockUnavailableWithProgress");
    expect(p).toMatch(/code: API_ERROR_CODES\.LOCK_UNAVAILABLE/);
    expect(p).toMatch(/\.\.\.\(progress \?\? \{\}\)/);
  });

  it("the batch loop steps by COUNT_COMMIT_BATCH and flips the session by CAS only after it", () => {
    const m = body("commitStockCountBatches");
    expect(m).toMatch(/i \+= COUNT_COMMIT_BATCH/);
    const loop = m.search(/this\.commitStockCountBatch\(/);
    const cas = m.search(/stockCountSession\.updateMany\(/);
    expect(loop).toBeGreaterThan(-1);
    expect(cas).toBeGreaterThan(loop);
    expect(m).toMatch(/status: \{ in: \["OPEN", "REVIEW"\] \}/);
    expect(m).not.toMatch(/stockCountSession\.update\(/);
  });

  it("one batch = one retryStockTx tx: lock, locked read, skip-by-movement, then apply", () => {
    const m = body("commitStockCountBatch");
    expect(m).toMatch(/retryStockTx\("inventory\.commitStockCountSession"/);
    const lock = m.search(/this\.lockProducts\(/);
    const read = m.search(/this\.readLockedStockRows\(/);
    const skip = m.search(/tx\.stockMovement\.findMany\(/);
    const apply = m.search(/this\.applyStockCountItemsInTx\(/);
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(read);
    expect(read).toBeLessThan(skip);
    expect(skip).toBeLessThan(apply);
    expect(m).toMatch(/where: \{ reference, productId: \{ in: productIds \} \}/);
    expect(m).toMatch(/expectedQty: l\.expectedQty/);
  });

  it("upsertStockCountLine stamps expectedQty from the in-tx live stock: on create and on an ABSOLUTE write, never on an increment", () => {
    const m = body("upsertStockCountLine");
    const read = m.search(/tx\.product\.findFirst\(/);
    const existing = m.search(/tx\.stockCountLine\.findUnique\(/);
    expect(read).toBeGreaterThan(m.search(/this\.prisma\.tenantTransaction\(/));
    expect(read).toBeLessThan(existing);
    // re-stamps only on an ABSOLUTE write that CHANGES the count (SA-767 r-note 5 SA-1)
    expect(m).toMatch(/const recount = !dto\.increment && absoluteCountChanged\(existing, data\)/);
    expect(m).toMatch(/data: recount \? \{ \.\.\.data, expectedQty: live\.currentStock \} : data/);
    expect(m).toMatch(/expectedQty: live\.currentStock,\n\s+\.\.\.data,/);
    // adding the product takes the per-product tx lock, then checks the other open counts (SA-3)
    expect(m.search(/advisoryXactLock\(/)).toBeGreaterThan(-1);
    expect(m.search(/advisoryXactLock\(/)).toBeLessThan(m.search(/findOpenCountConflicts\(/));
    expect(m.search(/findOpenCountConflicts\(/)).toBeLessThan(
      m.search(/tx\.stockCountLine\.create\(/),
    );
    // the read is a baseline stamp, not a stock write: no Product lock for it
    expect(m).not.toMatch(/lockProducts|lockProductsForStock/);
  });

  it.each(["upsertStockCountLine", "removeStockCountLine", "discardStockCountSession"])(
    "%s runs in its own tx under the shared stock-count lock (enterSessionEdit)",
    (name) => {
      const m = body(name);
      expect(m).toMatch(/this\.prisma\.tenantTransaction\(/);
      expect(m).toMatch(/this\.enterSessionEdit\(tx, /);
      // nothing is decided from a read made before the lock
      expect(m.search(/this\.enterSessionEdit\(/)).toBeLessThan(
        m.search(/tx\.\w+\.(find|delete|update|create)\w*\(/),
      );
    },
  );

  it("enterSessionEdit: the shared lock first, then the status, then the movements check", () => {
    const m = body("enterSessionEdit");
    const lock = m.search(/tryAdvisoryXactLockShared\(tx, STOCK_COUNT_LOCK_FAMILY, sessionId\)/);
    const status = m.search(/tx\.stockCountSession\.findFirst\(/);
    const moves = m.search(/tx\.stockMovement\.findFirst\(/);
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(status);
    expect(status).toBeLessThan(moves);
    expect(m).toMatch(/stockCountCommitting\(\)/);
  });

  it("discardStockCountSession is a CAS on OPEN / REVIEW; a CAS that matches nothing is the 409", () => {
    const m = body("discardStockCountSession");
    expect(m).toMatch(/tx\.stockCountSession\.updateMany\(/);
    expect(m).toMatch(/status: \{ in: \["OPEN", "REVIEW"\] \}/);
    expect(m).toMatch(/flipped\.count === 0\) throw stockCountCommitting\(\)/);
    expect(m).not.toMatch(/stockCountSession\.update\(/);
  });
});
