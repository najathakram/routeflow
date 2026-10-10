/**
 * COPIER CONTRACT — every place that copies a sales line into a new row must say, per column of the
 * target model, whether it CARRIES it, RESETS it, RE-DERIVES it, cannot apply it (NA) or has a KNOWN GAP
 * (`gaps: { col: "B###" }`). A registry that only ever grows rots, so this goes RED when:
 *   (a) a column appears on a line model that a registered copier has not classified;
 *   (b) a copier is added, renamed or removed without a registry entry (fingerprint = file + function);
 *   (c) a known gap is FIXED (the column is now written) but its entry still says gap — flip it to `carried`
 *       and delete the id; or a carried column stops being written (a regression).
 * Every fix PR's job is therefore visible: B644 (#1159) was exactly that flip for C2's `unitsPerBox`, `originalPrice`,
 * `priceType` and `notes` (this spec went red on the merge until they moved from gaps to carried).
 *
 * METHOD. Column lists come from `Prisma.dmmf` (the generated client: no DB). "Written" means: a TOP-LEVEL key
 * of a line-write object literal (`items: { create: … }`, `<x>.<model>.createMany({ data })`, a builder's
 * `return { … }`, an `<array>.push({ … })`), found with the TypeScript compiler API and anchored PER ENTRY, so
 * `where` / `select` / `include` and parent-object keys can never count. Hermetic: fs + typescript + the
 * generated client only — no git, no DB, no network, no env (B420 lesson).
 *
 * WHAT THIS CANNOT SEE (stated limits):
 *   1. A same-named key used for a read shape inside an anchored literal counts as "written" (false green).
 *   2. Copiers that spread another object (`...i`) or build the row in a helper are covered only through the
 *      anchored literal; C10 is registry-only for that reason (C5 instead anchors on its shared builder). A literal
 *      passed as a call ARGUMENT is that helper's input, never a written row. The one exception is
 *      `...helper(x)` for a helper in SPREAD_HELPER_KEYS (copier-ast.ts) imported from @routeflow/pricing, whose
 *      return is a fixed key set (pinned against the real helper below). Raw-SQL writes are not detected.
 *   3. A wrong VALUE for a present key is invisible (B658: `categoryTaxAmount: 0` is a present key).
 *   4. CLIENT copiers (C15, C16a/b) are `coverage: "registry-only"`: they are NOT column-checked (a request
 *      body is not a Prisma model; the spec lives in apps/api). C3 (web Duplicate) was retired by B644 (#1159: the
 *      button calls the server endpoint) so the entry was dropped. Next step: the same AST check over web/mobile
 *      asserting "does the request body carry these keys". The registry-only set is pinned below.
 *   5. The discovery pass matches nested `<relation>: { create }` by relation NAME, so other models' `items` are
 *      excluded by file (NOT_SALES_FILES) — keep that list short.
 * Looked at and NOT a copier: OrderTemplateItem writers (template create/update/addItem take a request DTO; no
 * "save this order as a template" path exists).
 *
 * SIZE EXCEPTION (fleet lead, 2026-09-21): this directory exceeds the 400-line PR cap on purpose. It is test
 * infrastructure under `src/common/testing/` (no production code, excluded from the build) and about 300 lines
 * of it are a data registry, where length is a feature; the mutation proofs below are why the spec can be trusted.
 *
 * `Prisma.dmmf` needs the generated client: CI runs `prisma generate`; a STALE local client makes this red for
 * the wrong reason (run `npx prisma generate` first).
 */
import * as fs from "fs";
import * as path from "path";
import { Prisma } from "@prisma/client";
import { copyCategoryTaxSnapshot } from "@routeflow/pricing";
import {
  SPREAD_HELPER_KEYS,
  optionsPassedKeys,
  writeSites,
  writtenKeys,
  findFunctions,
} from "./copier-ast";
import { COPIERS, Copier, INFRA, Model, NOT_A_COPIER, NOT_SALES_FILES } from "./copier-registry";

/** Pinned on purpose: adding a registry-only copier must be a visible diff HERE, not just in the registry. */
const REGISTRY_ONLY_PINNED = ["C10", "C15", "C16a", "C16b"];
const SRC = path.resolve(__dirname, "../../..");
const ROOT = path.resolve(SRC, "../../..");
const COMPONENT_TARGETS = new Set<Model>(["OrderItem", "InvoiceItem"]);
const words = (s?: string) => (s ?? "").split(/\s+/).filter(Boolean);
const isClient = (c: Copier) => c.file.startsWith("apps/");

interface World {
  copiers: Copier[];
  columns: (m: Model) => string[]; //  classifiable columns (schema minus INFRA)
  read: (file: string) => string | null; // server source by path under src/
  exists: (file: string) => boolean; //   client file by repo path
  sites: () => string[]; //               "file::fn" for every discovered line-write site
  notACopier: Record<string, string>;
  notSales: Record<string, string>;
}

/** Every way the contract can be broken, as readable messages (empty = green). */
export function evaluate(w: World): string[] {
  const bad: string[] = [];
  const ids = new Set<string>();
  for (const c of w.copiers) {
    const at = `${c.id} (${c.file}::${c.fn})`;
    if (ids.has(c.id)) bad.push(`${at}: duplicate copier id`);
    ids.add(c.id);
    if (c.coverage === "registry-only" && !c.why) bad.push(`${at}: registry-only needs a "why"`);
    if (isClient(c)) {
      if (!w.exists(c.file)) bad.push(`${at}: client file is gone (renamed? update the entry)`);
      continue;
    }
    const src = w.read(c.file);
    if (src === null || !findFunctions(src, c.fn).length) {
      bad.push(`${at}: copier not found: renamed or removed — update the registry entry`);
      continue;
    }
    if (c.coverage === "registry-only") continue;
    const cols = w.columns(c.target);
    const buckets: [string, string[]][] = [
      ["carried", words(c.carried)],
      ["reset", words(c.reset)],
      ["rederived", words(c.rederived)],
      ["viaOptions", words(c.viaOptions)],
      ["na", words(c.na)],
      ["gaps", Object.keys(c.gaps ?? {})],
    ];
    const seen = new Map<string, string>();
    for (const [b, list] of buckets)
      for (const col of list) {
        if (!cols.includes(col))
          bad.push(`${at}: "${col}" is not a ${c.target} column (typo, or the column was removed)`);
        if (seen.has(col))
          bad.push(`${at}: "${col}" is classified twice (${seen.get(col)} and ${b})`);
        seen.set(col, b);
      }
    // #2717 M3: the `components` relation is skipped by the column check (it is not a scalar), so a
    // line copier says separately what happens to the frozen component rows: carried (copied from
    // the source line's rows), rederived (rebuilt from the recipe or rescaled from the line's own
    // rows) or na (a line that can never carry components).
    if (
      COMPONENT_TARGETS.has(c.target) &&
      !["carried", "rederived", "na"].includes(c.components ?? "")
    )
      bad.push(
        `${at}: NEW/UNCLASSIFIED components bucket on ${c.target} — set components to carried, rederived or na`,
      );
    for (const col of cols)
      if (!seen.has(col))
        bad.push(
          `${at}: NEW/UNCLASSIFIED ${c.target}.${col} — classify it as carried, viaOptions, reset, rederived, na or gaps`,
        );
    const keys = c.anchor ? writtenKeys(src, { name: c.fn, anchor: c.anchor }) : null;
    if (!keys || keys.size === 0) {
      bad.push(
        `${at}: the anchored line-write literal was not found (anchor lost — fix the anchor)`,
      );
      continue;
    }
    const passed = optionsPassedKeys(src, c.fn, "sourceLines");
    for (const col of words(c.viaOptions))
      if (!passed.has(col))
        bad.push(
          `${at}: "${col}" is classified viaOptions but is no longer passed in the sourceLines literal (regression)`,
        );
    for (const col of words(c.carried))
      if (!keys.has(col))
        bad.push(`${at}: "${col}" is classified carried but is no longer written (regression)`);
    for (const [col, ref] of Object.entries(c.gaps ?? {}))
      if (keys.has(col))
        bad.push(
          `${at}: gap ${col} (${ref}) is now WRITTEN — looks fixed: move it to carried and delete the gap`,
        );
  }
  const registered = new Set(
    w.copiers.filter((c) => !isClient(c)).map((c) => `${c.file}::${c.fn}`),
  );
  for (const site of w.sites()) {
    const file = site.split("::")[0];
    if (!registered.has(site) && !(site in w.notACopier) && !(file in w.notSales))
      bad.push(
        `${site}: writes a sales-line model but is neither a registered copier nor in NOT_A_COPIER — add it`,
      );
  }
  for (const [site, why] of Object.entries(w.notACopier)) {
    const [file, fn] = site.split("::");
    const src = w.read(file);
    if (!why) bad.push(`${site}: NOT_A_COPIER entry needs a reason`);
    if (registered.has(site)) bad.push(`${site}: is both registered and NOT_A_COPIER`);
    if (src === null || !findFunctions(src, fn).length)
      bad.push(`${site}: NOT_A_COPIER entry is stale (function gone)`);
  }
  return bad;
}

const MODELS = Object.keys(INFRA) as Model[];
const RELATIONS = new Set(
  Prisma.dmmf.datamodel.models.flatMap((m) =>
    m.fields
      .filter((f) => f.kind === "object" && MODELS.includes(f.type as Model))
      .map((f) => f.name),
  ),
);
const walk = (d: string): string[] =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const realWorld = (copiers: Copier[] = COPIERS): World => ({
  copiers,
  columns: (m) =>
    Prisma.dmmf.datamodel.models
      .find((x) => x.name === m)!
      .fields.filter((f) => f.kind !== "object" && !words(INFRA[m]).includes(f.name))
      .map((f) => f.name),
  read: (f) =>
    fs.existsSync(path.join(SRC, f)) ? fs.readFileSync(path.join(SRC, f), "utf8") : null,
  exists: (f) => fs.existsSync(path.join(ROOT, f)),
  sites: () =>
    walk(SRC)
      .filter(
        (f) =>
          /\.ts$/.test(f) &&
          !/\.(spec|test|d)\.ts$/.test(f) &&
          !/(^|[\\/])testing([\\/]|$)/.test(f),
      )
      .flatMap((f) =>
        writeSites(fs.readFileSync(f, "utf8"), MODELS, RELATIONS).map(
          (fn) => `${path.relative(SRC, f).split(path.sep).join("/")}::${fn}`,
        ),
      ),
  notACopier: NOT_A_COPIER,
  notSales: NOT_SALES_FILES,
});

describe("copier contract (green on master)", () => {
  it("every registered copier classifies every column, and the registry matches the code", () => {
    expect(evaluate(realWorld())).toEqual([]);
  });

  it("the registry-only set is pinned (a new registry-only entry must be added here too)", () => {
    expect(
      COPIERS.filter((c) => c.coverage === "registry-only")
        .map((c) => c.id)
        .sort(),
    ).toEqual(REGISTRY_ONLY_PINNED);
  });

  it("every model in INFRA still exists and the INFRA columns are real", () => {
    for (const m of MODELS) {
      const cols =
        Prisma.dmmf.datamodel.models.find((x) => x.name === m)?.fields.map((f) => f.name) ?? [];
      expect(words(INFRA[m]).filter((c) => !cols.includes(c))).toEqual([]);
    }
  });
});

describe("copier contract mutation proofs (each must turn the spec red)", () => {
  const fx = `class S { async copy(x) { return this.db.invoice.create({ data: { items: { create: x.items.map((i) => ({ productId: i.productId, qty: i.qty, boxes: i.boxes })) } } }); } }`;
  const entry: Copier = {
    id: "F1",
    file: "fx.ts",
    fn: "copy",
    target: "EstimateItem",
    anchor: { via: "prop", name: "items" },
    carried: "productId qty boxes",
    gaps: { unitsPerBox: "B1" },
  };
  const world = (over: Partial<World> = {}, src = fx, c: Copier = entry): World => ({
    copiers: [c],
    columns: () => ["productId", "qty", "boxes", "unitsPerBox"],
    read: (f) => (f === "fx.ts" ? src : null),
    exists: () => true,
    sites: () => ["fx.ts::copy"],
    notACopier: {},
    notSales: {},
    ...over,
  });

  it("baseline fixture is green", () => expect(evaluate(world())).toEqual([]));
  it("(a) a fake new column is unclassified -> red", () =>
    expect(
      evaluate(
        world({ columns: () => ["productId", "qty", "boxes", "unitsPerBox", "fakeCol"] }),
      ).join(),
    ).toMatch(/UNCLASSIFIED EstimateItem\.fakeCol/));
  it("(a) on the REAL registry: a fake column on InvoiceItem reddens every InvoiceItem copier", () => {
    const w = realWorld();
    const out = evaluate({
      ...w,
      columns: (m) => [...w.columns(m), ...(m === "InvoiceItem" ? ["fakeCol"] : [])],
    });
    expect(out.filter((l) => /UNCLASSIFIED InvoiceItem\.fakeCol/.test(l)).length).toBe(
      COPIERS.filter(
        (c) => c.target === "InvoiceItem" && c.coverage !== "registry-only" && !isClient(c),
      ).length,
    );
  });
  it("(#2717 M3) a copier of an order/invoice line with no components bucket -> red", () => {
    const out = evaluate(
      realWorld(COPIERS.map((c) => (c.id === "C1" ? { ...c, components: undefined } : c))),
    );
    expect(out.join()).toMatch(/C1 .*NEW\/UNCLASSIFIED components bucket on InvoiceItem/);
  });
  it("(#2717 M3) every order/invoice line copier declares a components bucket", () => {
    const missing = COPIERS.filter(
      (c) =>
        COMPONENT_TARGETS.has(c.target) &&
        c.coverage !== "registry-only" &&
        !isClient(c) &&
        !c.components,
    ).map((c) => c.id);
    expect(missing).toEqual([]);
  });
  it("(b) an unregistered write site -> red", () =>
    expect(evaluate(world({ sites: () => ["fx.ts::copy", "fx.ts::sneaky"] })).join()).toMatch(
      /fx\.ts::sneaky/,
    ));
  it("(b) dropping a real copier entry -> its function is an unregistered write site", () =>
    expect(evaluate(realWorld(COPIERS.filter((c) => c.id !== "C4"))).join()).toMatch(
      /estimates\.service\.ts::create: writes a sales-line model/,
    ));
  it("(b) a renamed function -> red", () =>
    expect(evaluate(world({}, fx.replace("copy", "copy2"))).join()).toMatch(/copier not found/));
  it("(c) a gap column that gets written -> 'looks fixed'", () =>
    expect(
      evaluate(
        world({}, fx.replace("boxes: i.boxes", "boxes: i.boxes, unitsPerBox: i.unitsPerBox")),
      ).join(),
    ).toMatch(/gap unitsPerBox \(B1\) is now WRITTEN/));
  it("(c) a carried column that stops being written -> regression", () =>
    expect(evaluate(world({}, fx.replace(", boxes: i.boxes", ""))).join()).toMatch(
      /"boxes" is classified carried but is no longer written/,
    ));
  describe("a known fixed-shape helper spread (SPREAD_HELPER_KEYS)", () => {
    const trio = "categoryTaxType categoryTaxRate categoryPriceIncludesTax";
    const cols = () => ["productId", "qty", "boxes", "unitsPerBox", ...trio.split(" ")];
    const IMPORT = `import { copyCategoryTaxSnapshot } from "@routeflow/pricing";\n`;
    const withSpread = (helper: string, arg = "i", imp = IMPORT) =>
      imp + fx.replace("boxes: i.boxes", `boxes: i.boxes, ...${helper}(${arg})`);
    const trioEntry: Copier = { ...entry, carried: `productId qty boxes ${trio}` };
    const trioLiteral = "{ categoryTaxType: 1, categoryTaxRate: 1, categoryPriceIncludesTax: 1 }";
    it("...copyCategoryTaxSnapshot(x) writes the trio -> carried is green", () =>
      expect(
        evaluate(world({ columns: cols }, withSpread("copyCategoryTaxSnapshot"), trioEntry)),
      ).toEqual([]));
    it("(c) removing that spread -> the trio is a regression", () =>
      expect(evaluate(world({ columns: cols }, IMPORT + fx, trioEntry)).join()).toMatch(
        /"categoryTaxType" is classified carried but is no longer written/,
      ));
    it("an UNKNOWN helper spread stays opaque -> carried is red", () =>
      expect(
        evaluate(world({ columns: cols }, withSpread("someOtherHelper"), trioEntry)).join(),
      ).toMatch(/"categoryTaxRate" is classified carried but is no longer written/));
    it("an unknown helper's LITERAL ARGUMENT is not written keys -> carried is red", () =>
      expect(
        evaluate(
          world({ columns: cols }, withSpread("someOtherHelper", trioLiteral), trioEntry),
        ).join(),
      ).toMatch(/"categoryPriceIncludesTax" is classified carried but is no longer written/));
    it("a same-named helper NOT imported from @routeflow/pricing stays opaque -> red", () =>
      expect(
        evaluate(
          world({ columns: cols }, withSpread("copyCategoryTaxSnapshot", "i", ""), trioEntry),
        ).join(),
      ).toMatch(/"categoryTaxType" is classified carried but is no longer written/));
    it("the pinned key list is exactly what the real helper returns, on both paths", () => {
      const pinned = [...SPREAD_HELPER_KEYS.copyCategoryTaxSnapshot].sort();
      expect(Object.keys(copyCategoryTaxSnapshot(null)).sort()).toEqual(pinned);
      expect(
        Object.keys(
          copyCategoryTaxSnapshot({
            categoryTaxType: null,
            categoryTaxRate: 1,
            categoryPriceIncludesTax: true,
          }),
        ).sort(),
      ).toEqual(pinned);
    });
  });
  it("a builder call's literal ARGUMENT inside a callback is not the written line -> red", () =>
    expect(
      evaluate(
        world(
          {},
          fx.replace(
            "x.items.map((i) => ({ productId: i.productId, qty: i.qty, boxes: i.boxes }))",
            "x.items.map((i) => build({ productId: i.productId, qty: i.qty, boxes: i.boxes }))",
          ),
        ),
      ).join(),
    ).toMatch(/the anchored line-write literal was not found/));
  it("keys in where/select/include or the parent literal never count as written", () => {
    const noisy = fx
      .replace("create(", "create(")
      .replace("data: {", "where: { unitsPerBox: 1 }, select: { unitsPerBox: true }, data: {");
    expect(evaluate(world({}, noisy))).toEqual([]);
  });
  describe('a builder that wraps its lines ({ via: "return", nested: true })', () => {
    const bx = `function b(items) { let subtotal = 0; const itemsData = items.map((i) => { const s = i.q * 2; subtotal += s; return { productId: i.p, qty: i.q, subtotal: s }; }); return { itemsData, subtotal }; }`;
    const bEntry: Copier = {
      id: "F2",
      file: "fx.ts",
      fn: "b",
      target: "EstimateItem",
      anchor: { via: "return", nested: true },
      carried: "productId qty subtotal",
    };
    const bWorld = (src: string, c: Copier = bEntry) =>
      world({ columns: () => ["productId", "qty", "subtotal"], sites: () => [] }, src, c);
    it("baseline: the per-line literal is read -> green", () =>
      expect(evaluate(bWorld(bx))).toEqual([]));
    it("(c) the LINE stops writing subtotal -> red, even though the wrapper returns `subtotal`", () =>
      expect(evaluate(bWorld(bx.replace(", subtotal: s }", " }"))).join()).toMatch(
        /"subtotal" is classified carried but is no longer written/,
      ));
    it("without nested, the wrapper's `subtotal` would hide that (why C5 uses nested)", () =>
      expect(
        evaluate(
          bWorld(bx.replace(", subtotal: s }", " }"), { ...bEntry, anchor: { via: "return" } }),
        ),
      ).toEqual([]));
    // The same builder written `const b = (items) => { … }` (or a function expression): nested must
    // still exclude the builder's OWN return, or a pure syntax refactor brings the false green back.
    const arrow = bx.replace("function b(items) {", "const b = (items) => {");
    const fnExpr = bx.replace("function b(items) {", "const b = function (items) {");
    for (const [label, src] of [
      ["an arrow", arrow],
      ["a function-expression", fnExpr],
    ] as const) {
      it(`${label} builder: baseline green, and a dropped line subtotal -> red`, () => {
        expect(evaluate(bWorld(src))).toEqual([]);
        expect(evaluate(bWorld(src.replace(", subtotal: s }", " }"))).join()).toMatch(
          /"subtotal" is classified carried but is no longer written/,
        );
      });
    }
  });
  it("a stale NOT_A_COPIER entry and a reasonless one -> red", () =>
    expect(
      evaluate(world({ notACopier: { "fx.ts::gone": "", "fx.ts::copy": "x" } })).join(),
    ).toMatch(/needs a reason[\s\S]*stale[\s\S]*both registered and NOT_A_COPIER/));
  it("registry-only without a why, and a duplicate id -> red", () =>
    expect(
      evaluate({ ...world(), copiers: [{ ...entry, coverage: "registry-only" }, entry] }).join(),
    ).toMatch(/needs a "why"[\s\S]*duplicate copier id/));
});
