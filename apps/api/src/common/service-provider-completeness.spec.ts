/**
 * L-247 guard (third hit in a day): a spec that provides a REAL ProductsService, InvoicesService,
 * EstimatesService or CustomersService must also provide everything that service's constructor asks
 * for, EntitlementAuthority (#2241) included. It reads the specs' source, so it covers
 * `*.db.spec.ts` files (which need a database to run) in the unit lane, with no DB.
 *
 * The required list is DERIVED from each service's constructor parameters, never hand-written, so a
 * dependency added later is covered the day it lands. Nothing is allow-listed.
 */
import fs from "node:fs";
import path from "node:path";
import {
  analyseSpec,
  constructorDeps,
  findMissingProviders,
  type ReadFile,
} from "./testing/provider-completeness";

const SRC = path.resolve(__dirname, "..");
const readFile: ReadFile = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);

const GUARDED: Array<[string, string]> = [
  ["ProductsService", "products/products.service.ts"],
  ["InvoicesService", "invoices/invoices.service.ts"],
  ["EstimatesService", "estimates/estimates.service.ts"],
  ["CustomersService", "customers/customers.service.ts"],
];

const DEPS = new Map<string, string[]>(
  GUARDED.map(([name, file]) => [
    name,
    constructorDeps(fs.readFileSync(path.join(SRC, file), "utf8"), name),
  ]),
);

function specFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") specFiles(full, out);
    } else if (/\.spec\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("constructorDeps derives the required providers from the constructor", () => {
  it.each(GUARDED)(
    "%s asks for EntitlementAuthority (so a spec that omits it is caught)",
    (name) => {
      expect(DEPS.get(name)).toContain("EntitlementAuthority");
    },
  );

  it("reads parameter tokens in order, skips ? and @Optional() params, and honours @Inject(TOKEN)", () => {
    const src = `
      class Sample {
        constructor(
          private readonly a: Alpha,
          @Optional() private readonly b: Beta,
          private readonly c?: Gamma,
          @Inject(TOKEN_D) private readonly d: unknown,
          @Inject('str-e') private readonly e: unknown,
          @Inject(forwardRef(() => Delta)) private readonly f: Delta,
          private readonly g: ns.Epsilon,
        ) {}
      }`;
    expect(constructorDeps(src, "Sample")).toEqual([
      "Alpha",
      "TOKEN_D",
      '"str-e"',
      "Delta",
      "Epsilon",
    ]);
  });

  it("throws for a class that is not in the file (a renamed service must not silently guard nothing)", () => {
    expect(() => constructorDeps("class Other {}", "Sample")).toThrow(/not found/);
  });
});

describe("negative controls: the analysis fails a spec that leaves a dependency out and passes stubbed ones", () => {
  const deps = new Map([["ProductsService", ["PrismaService", "EntitlementAuthority"]]]);
  const none: ReadFile = () => null;
  const run = (src: string, rf: ReadFile = none) =>
    findMissingProviders("/x/a.spec.ts", src, deps, rf);

  it("FAILS: a real ProductsService with no EntitlementAuthority", () => {
    const missing = run(`
      Test.createTestingModule({ providers: [
        ProductsService,
        { provide: PrismaService, useValue: {} },
      ] });`);
    expect(missing).toEqual([
      {
        file: "/x/a.spec.ts",
        line: 2,
        service: "ProductsService",
        missing: ["EntitlementAuthority"],
      },
    ]);
  });

  it("FAILS: several are missing, and each is named", () => {
    const missing = run("Test.createTestingModule({ providers: [ProductsService] });");
    expect(missing[0].missing).toEqual(["PrismaService", "EntitlementAuthority"]);
  });

  it("PASSES: EntitlementAuthority via useValue", () => {
    expect(
      run(`Test.createTestingModule({ providers: [
        ProductsService,
        { provide: PrismaService, useValue: {} },
        { provide: EntitlementAuthority, useValue: { can: jest.fn() } },
      ] });`),
    ).toEqual([]);
  });

  it("PASSES: EntitlementAuthority via the shared provider const, resolved through a relative import", () => {
    const shared =
      "export const entitlementAuthorityFromEntitlements = { provide: EntitlementAuthority, inject: [], useFactory: () => ({}) };";
    const rf: ReadFile = (p) =>
      p === "/x/testing/entitlement-authority-provider.ts" ? shared : null;
    expect(
      run(
        `import { entitlementAuthorityFromEntitlements } from "./testing/entitlement-authority-provider";
         Test.createTestingModule({ providers: [ProductsService, { provide: PrismaService, useValue: {} }, entitlementAuthorityFromEntitlements] });`,
        rf,
      ),
    ).toEqual([]);
  });

  it("PASSES: a spread const array of providers in the same file", () => {
    expect(
      run(`const COMMON = [{ provide: PrismaService, useValue: {} }, { provide: EntitlementAuthority, useValue: {} }];
           Test.createTestingModule({ providers: [ProductsService, ...COMMON] });`),
    ).toEqual([]);
  });

  it("PASSES: a `.map` stub list naming the classes (stubbed, not real)", () => {
    expect(
      run(
        `Test.createTestingModule({ providers: [ProductsService, ...[PrismaService, EntitlementAuthority].map((p) => ({ provide: p, useValue: {} }))] });`,
      ),
    ).toEqual([]);
  });

  it("PASSES: ProductsService itself only STUBBED (not real, so it needs nothing)", () => {
    expect(
      run("Test.createTestingModule({ providers: [{ provide: ProductsService, useValue: {} }] });"),
    ).toEqual([]);
  });

  it("PASSES: a spec that uses .useMocker( (every missing dependency is auto-mocked)", () => {
    expect(
      run("Test.createTestingModule({ providers: [ProductsService] }).useMocker(() => ({}));"),
    ).toEqual([]);
  });

  it("an unresolvable helper is NOT assumed to provide the class (no allow-list): it is reported", () => {
    expect(
      run(
        `import { helper } from "./elsewhere"; Test.createTestingModule({ providers: [ProductsService, helper] });`,
      ),
    ).toHaveLength(1);
  });

  it("each providers array is judged on its own (a second module that omits it is still caught)", () => {
    const missing = run(`
      Test.createTestingModule({ providers: [ProductsService, { provide: PrismaService, useValue: {} }, { provide: EntitlementAuthority, useValue: {} }] });
      Test.createTestingModule({ providers: [ProductsService, { provide: PrismaService, useValue: {} }] });`);
    expect(missing).toHaveLength(1);
    expect(missing[0].line).toBe(3);
  });

  it("analyseSpec reports real vs provided", () => {
    const [arr] = analyseSpec(
      "/x/a.spec.ts",
      "x({ providers: [A, { provide: B, useValue: 1 }] });",
      none,
    );
    expect([...arr.real]).toEqual(["A"]);
    expect([...arr.provided].sort()).toEqual(["A", "B"]);
  });
});

describe("the repo's specs (unit + db lane): every real guarded service has every constructor dependency", () => {
  const files = specFiles(SRC);

  it("scans a meaningful number of specs, including DB-lane ones (the scan is not vacuous)", () => {
    const withReal = files.filter((f) =>
      analyseSpec(f, fs.readFileSync(f, "utf8"), readFile).some((a) =>
        [...DEPS.keys()].some((s) => a.real.has(s)),
      ),
    );
    expect(withReal.length).toBeGreaterThan(40);
    expect(withReal.some((f) => f.endsWith(".db.spec.ts"))).toBe(true);
  });

  it("no spec provides a real ProductsService / InvoicesService / EstimatesService / CustomersService without EntitlementAuthority and the rest of its constructor", () => {
    const problems = files.flatMap((f) =>
      findMissingProviders(f, fs.readFileSync(f, "utf8"), DEPS, readFile),
    );
    const lines = problems.map(
      (p) =>
        `${path.relative(SRC, p.file)}:${p.line} provides a real ${p.service} but not: ${p.missing.join(", ")}`,
    );
    expect(lines).toEqual([]);
  });
});
