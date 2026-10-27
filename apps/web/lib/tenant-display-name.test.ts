import * as fs from "fs";
import * as path from "path";
import { tenantDisplayName } from "./tenant-display-name";

describe("tenantDisplayName", () => {
  it("prefers the business name, trimmed", () => {
    expect(tenantDisplayName({ businessName: "  Acme Foods Wholesale ", name: "acme-llc" })).toBe(
      "Acme Foods Wholesale",
    );
  });

  it("falls back to the tenant's own name when the business name is missing, null or blank", () => {
    for (const businessName of [undefined, null, "", "   "]) {
      expect(tenantDisplayName({ businessName, name: "acme-llc" })).toBe("acme-llc");
    }
  });
});

describe("no hand-written tenant display name under app/(platform-admin) (pin)", () => {
  const ROOT = path.resolve(__dirname, "../app/(platform-admin)");
  const COPY = /\bbusinessName\s*(?:\?\?|\|\|)\s*\w+(?:\??\.)name\b/;
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });

  it("no file spells businessName ?? <x>.name", () => {
    const offenders = walk(ROOT).flatMap((f) =>
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        .map((l, i) => [i + 1, l] as const)
        .filter(([, l]) => COPY.test(l))
        .map(([n, l]) => `${path.relative(ROOT, f)}:${n}: ${l.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("positive control: the matcher sees the copy it exists to catch", () => {
    expect(COPY.test("const name = tenant.businessName ?? tenant.name;")).toBe(true);
    expect(COPY.test("{t.businessName ?? t.name}")).toBe(true);
    expect(COPY.test("{tenant.businessName ?? tenant.slug}")).toBe(false);
  });
});
