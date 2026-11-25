/**
 * @jest-environment node
 */
// C1 (SA-1304, copy ruling 7172194631): the site's yearly-offer guard keys on RF_PRICES.yearlyOffer, not on a word
// in billing.service.ts, and it reads every place a customer can see words: .js files, subfolder html, page.tsx.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  collectScanFiles,
  yearlyOfferViolations,
  type GuardInput,
} from "./yearly-offer-guard.testkit";

const THROW =
  "throw new ConflictException({ code: API_ERROR_CODES.CHECKOUT_ANNUAL_NOT_SUPPORTED })";
const CLEAN_REGISTER = "| a year is 10 months' price | pricing | `live` | prices.js |";

const base = (over: Partial<GuardInput>): GuardInput => ({
  yearlyOffer: false,
  billingSource: THROW,
  files: [],
  specSources: [],
  claimsRegister: CLEAN_REGISTER,
  ...over,
});
const page = (text: string) => ({ name: "pricing.html", text });

describe("yearly-offer guard", () => {
  it("C-T1: the guard survives the refusal word going away from billing.service.ts", () => {
    const out = yearlyOfferViolations(
      base({
        billingSource: "// yearly checkout reworked",
        files: [page("<p>Pay a year up front.</p>")],
      }),
    );
    expect(out.length).toBeGreaterThan(0);
  });

  it("C-T2: the scan reaches js files, subfolder html and page.tsx", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "c1-scan-"));
    const site = path.join(root, "site");
    const mk = path.join(root, "mk");
    fs.mkdirSync(path.join(site, "js"), { recursive: true });
    fs.mkdirSync(path.join(site, "sub"), { recursive: true });
    fs.mkdirSync(path.join(mk, "lib"), { recursive: true });
    fs.mkdirSync(path.join(mk, "terms"), { recursive: true });
    fs.writeFileSync(path.join(site, "pricing.html"), "x");
    fs.writeFileSync(path.join(site, "sub", "deep.html"), "x");
    fs.writeFileSync(path.join(site, "js", "site.js"), "x");
    fs.writeFileSync(path.join(mk, "lib", "site.ts"), "x");
    fs.writeFileSync(path.join(mk, "terms", "page.tsx"), "x");
    const names = collectScanFiles(site, mk).map((f) => f.name.split(path.sep).join("/"));
    expect(names).toEqual(
      expect.arrayContaining(["pricing.html", "sub/deep.html", "js/site.js", "terms/page.tsx"]),
    );
  });

  it.each([
    "billed a&nbsp;year",
    "billed a<br>year",
    "billed per annum",
    "billed every 12/twelve months",
    "billed annually",
    "$99 / yr",
  ])("C-T3: the probe %p goes red", (probe) => {
    const out = yearlyOfferViolations(base({ files: [page(`<p>${probe}</p>`)] }));
    expect(out.length).toBeGreaterThan(0);
  });

  it("C-T4: yearlyOffer true with a throw site goes red", () => {
    expect(yearlyOfferViolations(base({ yearlyOffer: true })).join("|")).toMatch(/throw site/);
  });

  it("C-T4: yearlyOffer true with a skipped spec goes red", () => {
    const out = yearlyOfferViolations(
      base({ yearlyOffer: true, billingSource: "", specSources: ["it.skip('x', () => {})"] }),
    );
    expect(out.join("|")).toMatch(/skipped/);
  });

  it("C-T4: yearlyOffer true with a claims row that is not live goes red", () => {
    const out = yearlyOfferViolations(
      base({
        yearlyOffer: true,
        billingSource: "",
        claimsRegister: "| a year is 10 months' price | pricing | `not built` | prices.js |",
      }),
    );
    expect(out.join("|")).toMatch(/not live/);
  });

  it("yearlyOffer true with a clean tree passes, and a closed offer with a clean tree passes", () => {
    expect(yearlyOfferViolations(base({ yearlyOffer: true, billingSource: "" }))).toEqual([]);
    expect(yearlyOfferViolations(base({ files: [page("<p>Monthly plans.</p>")] }))).toEqual([]);
  });
});
