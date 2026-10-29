/**
 * SA-842 §2e — source tripwire for the class "a write that removes a RouteRun / RouteRunStop / Route".
 *
 * Deleting those rows destroys the sole pointers to proof-of-delivery objects, so EVERY deleter in
 * production source must sit in a method whose transaction takes the delete locks
 * (`lockRunsForDelete`) and then asks `routeHasDeliveryEvidence(` BEFORE the delete runs. Inventory at
 * the base sha: 5 call sites in 2 methods (deleteRoute x3, deleteRun x2). A new deleter anywhere in
 * `apps/api/src` fails this spec until it goes through the predicate; changing the rule means changing
 * this file on purpose.
 *
 * Comments are stripped first (a call in a comment is not a call); the scan helpers ship their own
 * detector self-test below, so a broken regex can never report green on an empty scan.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  API_SRC_ROOT,
  codeOnly,
  collectSourceFiles,
  findCalls,
  scanSource,
} from "../testing/source-scan";

const DELETERS = [
  /\.routeRunStop\.(deleteMany|delete)\(/,
  /\.routeRun\.(deleteMany|delete)\(/,
  /\.route\.(deleteMany|delete)\(/,
];

const sites = DELETERS.flatMap((re) => scanSource(re));

describe("REG-B209 delivery-evidence tripwire — every RouteRun / RouteRunStop / Route deleter asks the predicate first (SA-842 §2e)", () => {
  it("the inventory is exactly deleteRoute x3 and deleteRun x2, all in routes.service.ts", () => {
    const tally: Record<string, number> = {};
    for (const s of sites) tally[`${s.file}:${s.fn}`] = (tally[`${s.file}:${s.fn}`] ?? 0) + 1;
    // WRONG VALUE TODAY: the same 5 sites, but none asks the predicate (the next test goes red).
    expect(tally).toEqual({
      "routes/routes.service.ts:deleteRoute": 3,
      "routes/routes.service.ts:deleteRun": 2,
    });
  });

  it.each(sites.map((s) => [`${s.file}:${s.fn} (${s.method}, line ${s.line})`, s] as const))(
    "REG-B209 %s: lockRunsForDelete -> routeHasDeliveryEvidence( both come BEFORE the delete",
    (_label, site) => {
      const lock = site.scope.indexOf("lockRunsForDelete(");
      const check = site.scope.indexOf("routeHasDeliveryEvidence(");
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(check).toBeGreaterThan(lock);
    },
  );

  it("no raw SQL DELETE removes a Route, RouteRun or RouteRunStop outside the audited methods", () => {
    const offenders = collectSourceFiles().filter((f) =>
      /DELETE\s+FROM\s+"?(RouteRunStop|RouteRun|Route)"?(\s|$)/i.test(
        codeOnly(fs.readFileSync(f, "utf8")),
      ),
    );
    expect(offenders.map((f) => path.relative(API_SRC_ROOT, f))).toEqual([]);
  });

  it("the predicate body exists ONCE, in routes/delivery-evidence.ts", () => {
    const definers = collectSourceFiles().filter((f) =>
      /function\s+routeHasDeliveryEvidence\b/.test(codeOnly(fs.readFileSync(f, "utf8"))),
    );
    expect(definers.map((f) => path.relative(API_SRC_ROOT, f).replace(/\\/g, "/"))).toEqual([
      "routes/delivery-evidence.ts",
    ]);
  });

  it("the false premise that scheduled / cancelled runs 'recorded nothing' is gone from routes.service.ts", () => {
    const src = fs.readFileSync(path.join(__dirname, "routes.service.ts"), "utf8");
    expect(src).not.toMatch(/which\s+recorded\s+nothing/);
  });

  it("detector self-test: a deleter in a method that never asks the predicate is found, and its scope lacks the check", () => {
    const snippet = [
      "class Bad {",
      "  async nuke(id: string) {",
      "    await tx.routeRun.deleteMany({ where: { routeId: id } });",
      "  }",
      "}",
    ].join("\n");
    const found = findCalls("bad.ts", snippet, DELETERS[1]);
    expect(found.map((f) => [f.fn, f.method])).toEqual([["nuke", "deleteMany"]]);
    expect(found[0].scope).not.toContain("routeHasDeliveryEvidence(");
    expect(sites.length).toBeGreaterThan(0);
  });
});
