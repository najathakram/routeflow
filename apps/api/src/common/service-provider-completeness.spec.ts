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
  candidateSpecs,
  constructorDeps,
  findMissingProviders,
  toPosix,
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

  describe("Windows-style paths (the PC lane: C:\\ paths from the file walk)", () => {
    const shared =
      "export const entitlementAuthorityFromEntitlements = { provide: EntitlementAuthority, inject: [], useFactory: () => ({}) };";
    // The reader is keyed on the '/'-normalised path, the form the scan hands it on every platform.
    const rf: ReadFile = (p) =>
      p === "C:/repo/apps/api/src/products/testing/shared.ts" ||
      p === "C:/repo/apps/api/src/testing/shared.ts"
        ? shared
        : null;
    const body = `Test.createTestingModule({ providers: [ProductsService, { provide: PrismaService, useValue: {} }, entitlementAuthorityFromEntitlements] });`;

    it("a backslash file name resolves a './' shared-provider import (54 false gaps on the PC before)", () => {
      expect(
        findMissingProviders(
          "C:\\repo\\apps\\api\\src\\products\\a.spec.ts",
          `import { entitlementAuthorityFromEntitlements } from "./testing/shared";\n${body}`,
          deps,
          rf,
        ),
      ).toEqual([]);
    });

    it("a backslash file name resolves a '../' import, keeping the drive letter", () => {
      expect(
        findMissingProviders(
          "C:\\repo\\apps\\api\\src\\products\\deep\\a.spec.ts",
          `import { entitlementAuthorityFromEntitlements } from "../../testing/shared";\n${body}`,
          deps,
          rf,
        ),
      ).toEqual([]);
    });

    it("a '/'-normalised drive path works too, and a missing provider is still a gap on it", () => {
      expect(
        findMissingProviders(
          "C:/repo/apps/api/src/products/a.spec.ts",
          `import { entitlementAuthorityFromEntitlements } from "./testing/shared";\n${body}`,
          deps,
          rf,
        ),
      ).toEqual([]);
      expect(
        findMissingProviders(
          "C:\\repo\\apps\\api\\src\\products\\a.spec.ts",
          "x({ providers: [ProductsService] });",
          deps,
          rf,
        ),
      ).toHaveLength(1);
    });
  });

  describe("a providers value that cannot be read is REPORTED, never silently passed", () => {
    it("`providers: someVar` with no resolvable const is reported as unresolvable", () => {
      const missing = run(
        "import { someVar } from './elsewhere'; Test.createTestingModule({ providers: someVar }); const s = ProductsService;",
      );
      expect(missing).toHaveLength(1);
      expect(missing[0].service).toMatch(/unresolvable providers/);
    });

    it("`providers: makeProviders()` (a call) is reported too", () => {
      expect(
        run("Test.createTestingModule({ providers: makeProviders(ProductsService) });")[0].service,
      ).toMatch(/unresolvable providers/);
    });

    it("`providers: [...someVar]` (an unresolvable spread) is reported", () => {
      expect(
        run("Test.createTestingModule({ providers: [ProductsService, ...someVar] });").some((m) =>
          /unresolvable/.test(m.service),
        ),
      ).toBe(true);
    });

    it("`providers: COMMON` that resolves to a const array in the same file IS read (and judged)", () => {
      const src = (extra: string) =>
        `const COMMON = [ProductsService, { provide: PrismaService, useValue: {} }${extra}]; Test.createTestingModule({ providers: COMMON });`;
      expect(run(src(""))).toHaveLength(1);
      expect(run(src(", { provide: EntitlementAuthority, useValue: {} }"))).toEqual([]);
    });

    it("a providers PARAMETER typed as value stubs only (Array<{ provide; useValue }>) cannot hold a real service: not reported, and `as never` is looked through", () => {
      expect(
        run(`async function boot(providers: Array<{ provide: unknown; useValue: unknown }>) {
               return Test.createTestingModule({ providers: providers as never });
             }
             const x = { provide: ProductsService, useValue: {} };`),
      ).toEqual([]);
      expect(
        run(`function boot(providers: { provide: unknown; useValue: unknown }[]) { return x({ providers }); }
             const y = ProductsService;`),
      ).toEqual([]);
    });

    it("but a providers parameter typed loosely (could hold a bare class) is still reported", () => {
      expect(
        run(
          `function boot(providers: unknown[]) { return x({ providers }); } const y = ProductsService;`,
        )[0]?.service,
      ).toMatch(/unresolvable providers/);
      expect(
        run(
          `function boot(providers: Array<{ provide: unknown }>) { return x({ providers }); } const y = ProductsService;`,
        )[0]?.service,
      ).toMatch(/unresolvable providers/);
    });

    it("a file that never mentions a guarded service is not asked about its unresolvable providers", () => {
      expect(run("Test.createTestingModule({ providers: someVar });")).toEqual([]);
    });
  });

  it("candidateSpecs keeps only the files that mention a guarded service (the rest are never parsed)", () => {
    const files = {
      "/a/x.spec.ts": "uses ProductsService here",
      "/a/y.spec.ts": "nothing relevant",
      "/a/z.spec.ts": "CustomersService",
    };
    expect(
      candidateSpecs(Object.keys(files), (f) => files[f as keyof typeof files], [
        "ProductsService",
        "CustomersService",
      ]),
    ).toEqual(["/a/x.spec.ts", "/a/z.spec.ts"]);
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
  // Every path is '/'-normalised (a Windows walk yields C:\\ paths), only the specs that mention a
  // guarded service are read into an AST, and each is analysed ONCE for both tests below.
  const serviceNames = [...DEPS.keys()];
  const all = specFiles(SRC).map(toPosix);
  const texts = new Map<string, string>();
  const candidates = candidateSpecs(
    all,
    (f) => {
      const t = readFile(f);
      if (t != null) texts.set(f, t);
      return t;
    },
    serviceNames,
  );
  const analysed = new Map(candidates.map((f) => [f, analyseSpec(f, texts.get(f)!, readFile)]));

  it("scans a meaningful number of specs, including DB-lane ones (the scan is not vacuous)", () => {
    const withReal = candidates.filter((f) =>
      analysed.get(f)!.some((a) => serviceNames.some((s) => a.real.has(s))),
    );
    expect(withReal.length).toBeGreaterThan(40);
    expect(withReal.some((f) => f.endsWith(".db.spec.ts"))).toBe(true);
    // The pre-filter skips most of the tree (the point of it: parsing every spec took ~60 s on the PC).
    expect(candidates.length).toBeLessThan(all.length / 2);
    // No path the scan uses carries a backslash, on any platform.
    expect(all.some((f) => f.includes("\\"))).toBe(false);
  });

  it("no spec provides a real ProductsService / InvoicesService / EstimatesService / CustomersService without EntitlementAuthority and the rest of its constructor", () => {
    const problems = candidates.flatMap((f) =>
      findMissingProviders(f, texts.get(f)!, DEPS, readFile),
    );
    const lines = problems.map(
      (p) =>
        `${path.relative(SRC, p.file)}:${p.line} provides a real ${p.service} but not: ${p.missing.join(", ")}`,
    );
    expect(lines).toEqual([]);
  });
});
