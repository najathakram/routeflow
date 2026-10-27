import * as fs from "fs";
import * as path from "path";
import { sellerDisplayName } from "./seller-display-name";

/**
 * Row 397 / SA-973: ONE seller-display-name expression. The cases use DISTINCT business and tenant names so a helper that
 * returns the wrong one cannot pass by coincidence (a mutant `return tenant.name` goes red below).
 */
const CONFIG = { businessName: "Acme Foods Wholesale" };
const TENANT = { name: "acme-legal-name-llc" };

describe("sellerDisplayName", () => {
  it("prefers the business name over the tenant's own name", () => {
    expect(sellerDisplayName(CONFIG, TENANT)).toBe("Acme Foods Wholesale");
  });

  it("falls back to the tenant name when the business name is missing, null or blank", () => {
    for (const config of [
      null,
      undefined,
      {},
      { businessName: null },
      { businessName: "" },
      { businessName: "   " },
    ]) {
      expect(sellerDisplayName(config, TENANT)).toBe("acme-legal-name-llc");
    }
  });

  it("trims what it returns", () => {
    expect(sellerDisplayName({ businessName: "  Acme Foods Wholesale " }, TENANT)).toBe(
      "Acme Foods Wholesale",
    );
  });

  it("falls back to the caller's text when neither name is usable (and to '' by default)", () => {
    expect(sellerDisplayName(null, null, "Your supplier")).toBe("Your supplier");
    expect(sellerDisplayName({ businessName: " " }, { name: " " }, "your seller")).toBe(
      "your seller",
    );
    expect(sellerDisplayName(undefined, undefined)).toBe("");
  });
});

/**
 * The pin: no hand-written copy of the expression anywhere in apps/api/src. A copy reads `<x>.businessName ?? <y>.name`
 * (or `||`) with the TENANT's name on the right-hand side; customers' own `businessName ?? contactName` is not one.
 */
describe("no hand-written seller display name (pin)", () => {
  const SRC = path.resolve(__dirname, "..");
  // A copy is either a fold onto the TENANT's name, or a fold on a tenant-config receiver's businessName onto ANY
  // non-null fallback ("RouteFlow", a settings key ...): every seller name goes through the helper with its fallback as
  // the third argument. `?? null` / `?? undefined` are pass-throughs, not folds. A customer's businessName is not a seller.
  const COPY =
    /businessName\s*(?:\?\?|\|\|)\s*(?:[\w.?]*\.)?tenant\??\.name\b|\b(?:config|cfg|tenantConfig|\w+\??\.config)\??\.businessName\s*(?:\?\?|\|\|)\s*(?!\s|null\b|undefined\b)/;
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
      return /\.tsx?$/.test(e.name) && !/\.(spec|db\.spec)\.tsx?$/.test(e.name) ? [p] : [];
    });

  it("only common/seller-display-name.ts spells the expression", () => {
    const offenders = walk(SRC)
      .filter((f) => path.basename(f) !== "seller-display-name.ts")
      .flatMap((f) =>
        fs
          .readFileSync(f, "utf8")
          .split("\n")
          .map((l, i) => [i + 1, l] as const)
          .filter(
            ([, l]) => COPY.test(l) && !l.trim().startsWith("//") && !l.trim().startsWith("*"),
          )
          .map(([n, l]) => `${path.relative(SRC, f)}:${n}: ${l.trim()}`),
      );
    expect(offenders).toEqual([]);
  });

  it("positive control: the matcher sees the copies it exists to catch", () => {
    for (const line of [
      "const n = cfg?.businessName ?? tenant.name;",
      "name: tenant.config?.businessName || tenant.name,",
      "const s = config?.businessName ?? tenant?.name ?? 'x';",
      "name: config?.businessName ?? link.tenant.name,",
      'return cfg?.businessName ?? "RouteFlow";',
      'const n = config?.businessName || "RouteFlow tenant";',
      'businessName: config?.businessName || settings["settings.businessName"],',
      "const n = t.config?.businessName ?? fallbackName;",
    ]) {
      expect(COPY.test(line)).toBe(true);
    }
    expect(
      COPY.test("customerName: link.customer?.businessName || link.customer?.contactName"),
    ).toBe(false);
    expect(
      COPY.test("const name = primaryLink?.customer?.businessName ?? primaryCustomerId;"),
    ).toBe(false);
    // pass-throughs stay legal
    expect(COPY.test("businessName: t.config?.businessName ?? null,")).toBe(false);
    expect(COPY.test("author={tenant?.businessName ?? undefined}")).toBe(false);
  });
});
