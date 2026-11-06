/**
 * SA-1099 A-3 note 2 and A-5 (F-WP5-1, row S5): every call that creates a NEW SELF-SERVE add-on line passes through
 * `heldStateRefusal` (a SKU the workspace already holds a row for is a keep, and `subscribe` skips it by design). A row is written through `upsertAddonRowTx` / `createAddonRowTx` and nowhere else, so this reads
 * the source for those writers and pins their callers: the back office enable (`addon.service.ts`, out of scope by
 * SA-1099 section 6: an admin may comp or grant what the tenant already has), `enableAddonLocked` (reached only from
 * `enableAddon`) and `subscribe`. A fourth writer anywhere is a seller nobody judged, and turns this red.
 */
import fs from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") out.push(...sources(p));
    } else if (p.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(p)) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(SRC, p).replace(/\\/g, "/");
const read = (r: string) => fs.readFileSync(path.join(SRC, r), "utf8");
const MUTATION = "billing/subscription-mutation.service.ts";

/** The text of one class method: from its signature to the first method-closing brace at class indent. */
function method(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start);
  return rest.slice(0, rest.indexOf("\n  }\n"));
}

describe("every seller of a NEW self-serve add-on line is judged", () => {
  it("add-on rows are written by exactly three seats: the back office, enableAddonLocked and subscribe", () => {
    const writers = sources(SRC)
      .filter((p) => !p.endsWith("tenant-addon-writer.ts"))
      .filter((p) => /\b(upsertAddonRowTx|createAddonRowTx)\(/.test(fs.readFileSync(p, "utf8")))
      .map(rel)
      .sort();
    expect(writers).toEqual(["billing/addon.service.ts", MUTATION]);

    const svc = read(MUTATION);
    const inEnable = method(svc, "private async enableAddonLocked(");
    const inSubscribe = method(svc, "async subscribe(");
    const calls = svc.match(/\b(upsertAddonRowTx|createAddonRowTx)\(/g) ?? [];
    const counted =
      (inEnable.match(/\b(upsertAddonRowTx|createAddonRowTx)\(/g) ?? []).length +
      (inSubscribe.match(/\b(upsertAddonRowTx|createAddonRowTx)\(/g) ?? []).length;
    expect(counted).toBe(calls.length);
  });

  it("enableAddon, the preview twin addonEnableRefusal and subscribe each call heldStateRefusal", () => {
    const svc = read(MUTATION);
    expect(method(svc, "async enableAddon(")).toMatch(/this\.heldStateRefusal\(/);
    expect(method(svc, "async addonEnableRefusal(")).toMatch(/this\.heldStateRefusal\(/);
    expect(method(svc, "async subscribe(")).toMatch(/this\.heldStateRefusal\(/);
  });

  it("subscribe judges on the TARGET plan: it passes asPlan to both judgeAddon and heldStateRefusal", () => {
    const body = method(read(MUTATION), "async subscribe(");
    expect(body).toMatch(/this\.judgeAddon\([\s\S]{0,80}?input\.planKey/);
    expect(body).toMatch(/heldStateRefusal\([^)]*asPlan/s);
  });

  it("the judgement runs before the first Stripe call and the transaction in subscribe", () => {
    const body = method(read(MUTATION), "async subscribe(");
    const check = body.indexOf("this.heldStateRefusal(");
    expect(check).toBeGreaterThan(-1);
    for (const later of [
      "this.planTransition.prepare(",
      "this.removeStripeAddonItem(",
      "$transaction(",
    ]) {
      expect(body.indexOf(later)).toBeGreaterThan(check);
    }
  });
});
