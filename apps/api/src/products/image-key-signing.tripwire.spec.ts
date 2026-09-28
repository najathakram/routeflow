import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * #2533 (SECURITY), defence in depth: every place that SIGNS a product image goes through the
 * own-prefix filter (`signableImageKeys` / `firstSignableImageKey` in products/product-image-keys.ts).
 * A `storage.presignedUrl(s)(…)` whose argument reads `<something>.imageKeys` directly would sign a
 * key planted before the write guard (another tenant's file). Scans every non-spec source in
 * apps/api/src (SA-499).
 */
const SRC = path.resolve(__dirname, "..");

function rawImageKeySigns(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && /\.presignedUrls?$/.test(node.expression.getText(sf))) {
      const args = node.arguments.map((a) => a.getText(sf)).join(",");
      if (/\.imageKeys\b/.test(args)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push(`${fileName}:${line + 1} ${node.getText(sf).slice(0, 80)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)
      ? [p]
      : [];
  });
}

describe("#2533 tripwire: product images are signed only through the own-prefix filter", () => {
  it("controls: a raw .imageKeys sign is flagged; the filtered forms are not", () => {
    expect(
      rawImageKeySigns("c.ts", "await this.storage.presignedUrl(p.imageKeys[0]);"),
    ).toHaveLength(1);
    expect(
      rawImageKeySigns("c.ts", "await this.storage.presignedUrls(p.imageKeys.slice(0, 4));"),
    ).toHaveLength(1);
    expect(
      rawImageKeySigns(
        "c.ts",
        "await this.storage.presignedUrls(signableImageKeys(p.id, p.imageKeys));",
      ),
    ).toHaveLength(1); // the filter must run BEFORE the call, into a local, so the scan stays simple
    expect(rawImageKeySigns("c.ts", "await this.storage.presignedUrl(thumbKey);")).toEqual([]);
    expect(rawImageKeySigns("c.ts", "await this.storage.presignedUrls(imageKeys);")).toEqual([]);
  });

  it("no source anywhere in apps/api/src signs a raw .imageKeys value", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.endsWith(path.join("buyer", "buyer-dashboard.service.ts")))).toBe(
      true,
    );
    const hits = files.flatMap((f) =>
      rawImageKeySigns(path.relative(SRC, f), fs.readFileSync(f, "utf8")),
    );
    expect(hits).toEqual([]);
  });

  it("never passes vacuously: the filter is used at the sign sites", () => {
    const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
    expect(read("products/products.service.ts")).toMatch(/signableImageKeys\(product\.id/);
    expect(read("products/products.service.ts")).toMatch(/firstSignableImageKey\(p\.id/);
    expect(read("buyer/buyer-catalog.service.ts")).toMatch(/signableImageKeys\(p\.id/);
    expect(read("buyer/buyer-dashboard.service.ts").match(/firstSignableImageKey\(/g)).toHaveLength(
      4,
    );
    expect(read("buyer/replenishment.service.ts")).toMatch(/firstSignableImageKey\(productId/);
  });
});
