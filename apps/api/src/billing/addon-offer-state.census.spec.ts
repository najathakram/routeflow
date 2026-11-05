/**
 * SA-1099 A-4 (row L-2): where a self-serve add-on is offered or sold has ONE decision. `skuAddsSomething` is called
 * from `addonOfferState` and nowhere else in the source, and both seats that read "do they already have it" go
 * through `addonOfferState`: the enable's refusal (`heldStateRefusal`) and the add-on list (`getSubscription`). A second
 * direct caller is a second copy of the rule, which is how the sheet and the list would come to disagree.
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

describe("one decision for 'they already have it'", () => {
  it("skuAddsSomething( is called only inside addon-adds-something.ts (by addonOfferState)", () => {
    const callers = sources(SRC)
      .filter((p) => /\bskuAddsSomething\(/.test(fs.readFileSync(p, "utf8")))
      .map(rel);
    expect(callers).toEqual(["billing/addon-adds-something.ts"]);
    const home = read("billing/addon-adds-something.ts");
    const offerState = home.slice(home.indexOf("export function addonOfferState"));
    expect(offerState).toMatch(/skuAddsSomething\(/);
  });

  it("heldStateRefusal's flag half calls addonOfferState", () => {
    const svc = read("billing/subscription-mutation.service.ts");
    const body = svc.slice(svc.indexOf("private async heldStateRefusal"));
    expect(body.slice(0, body.indexOf("\n  }\n"))).toMatch(/addonOfferState\(/);
  });

  it("getSubscription's alreadyHaveAddonSkus calls addonOfferState", () => {
    expect(read("billing/subscription.service.ts")).toMatch(/addonOfferState\(/);
  });
});
