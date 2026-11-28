import * as fs from "fs";
import * as path from "path";

/**
 * SA-1508 commit 5 (gate): the inventory pin on the three "Only DRAFT invoices can be edited" sites, and the shape pins on
 * the service's two transaction branches. Master had the refusal at three sites (the service's pre-read, the locked
 * `assertStillDraft`, and the composed-line writer); they are ONE gate now, count-pinned and shrink-only.
 *
 * L-364: the scan walks production files only, so this spec never matches its own text.
 */
const SRC = path.join(__dirname, "..");
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(path.join(dir, e.name));
    return e.name.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(e.name)
      ? [path.join(dir, e.name)]
      : [];
  });
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
const files = walk(SRC).map((f) => [rel(f), fs.readFileSync(f, "utf8")] as const);
const service = files.find(([f]) => f === "invoices/invoices.service.ts")![1];
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

/** The inventory: every production file naming the refusal, with its count. */
export const onlyDraftSites = (all: ReadonlyArray<readonly [string, string]>) =>
  Object.fromEntries(
    all
      .map(([f, t]) => [f, count(t, /Only DRAFT invoices can be edited/g)] as const)
      .filter(([, n]) => n > 0),
  );

/** The shape violations of the service's `update()` wiring (empty = clean). */
export const gateShapeViolations = (svc: string): string[] => {
  const v: string[] = [];
  if (count(svc, /\bassertStillDraft\(/g) !== 0) v.push("assertStillDraft is back in the service");
  if (count(svc, /\bassertModeUnderLock\(/g) !== 2)
    v.push("assertModeUnderLock must be called twice");
  if (count(svc, /\bwriteIfFigureFree\(/g) !== 2) v.push("writeIfFigureFree must be called twice");
  if (count(svc, /\bassertEditableUnderLock\(/g) !== 2)
    v.push("assertEditableUnderLock must be called twice");
  if (count(svc, /\beditModeOf\(/g) !== 1) v.push("editModeOf must be called once");
  // the header-only unlocked write is DRAFT-only: an issued save never calls updateHeaderOnly
  if (!/mode === "DRAFT"\s*\n?\s*\?\s*await updateHeaderOnly\(/.test(svc))
    v.push("updateHeaderOnly is not gated on DRAFT");
  // the pre-tx money gates are DRAFT-only: an issued save is judged under the lock
  if (!/mode === "DRAFT" &&\s*\(dto\.items \|\| dto\.discount/.test(svc))
    v.push("the pre-tx filing check is not gated on DRAFT");
  if (!/mode === "DRAFT" && \(dto\.items \|\| figureSent\)/.test(svc))
    v.push("the pre-tx unit-rewrite check is not gated on DRAFT");
  return v;
};

describe("the 'Only DRAFT' refusal is one gate (SA-1508 inventory pin, shrink-only)", () => {
  it("is not vacuous: the scan sees the tree and the service", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(service.length).toBeGreaterThan(100_000);
  });

  it("exactly one production site names it: locked-invoice-edit.ts, once", () => {
    expect(onlyDraftSites(files)).toEqual({ "invoices/locked-invoice-edit.ts": 1 });
  });

  it("the pin bites: a second site, or a site in another file, is detected", () => {
    const planted = [
      ...files,
      ["invoices/x.ts", 'throw new Error("Only DRAFT invoices can be edited");'] as const,
    ];
    expect(onlyDraftSites(planted)).toEqual({
      "invoices/locked-invoice-edit.ts": 1,
      "invoices/x.ts": 1,
    });
  });
});

describe("InvoicesService.update(): the gate's wiring (SA-1508)", () => {
  it("is clean on the tree", () => {
    expect(gateShapeViolations(service)).toEqual([]);
  });

  it.each([
    [
      "the old DRAFT check back",
      (s: string) => s + "\nassertStillDraft(x);",
      "assertStillDraft is back",
    ],
    [
      "a dropped figure-free call",
      (s: string) => s.replace("await writeIfFigureFree(tx, locked, null, edit)", "null"),
      "writeIfFigureFree must be called twice",
    ],
    [
      "a dropped money gate",
      (s: string) =>
        s.replace(
          "await assertEditableUnderLock(tx, locked, edit, {",
          "await ((tx, locked, edit, _x) => 0)(tx, locked, edit, {",
        ),
      "assertEditableUnderLock must be called twice",
    ],
    [
      "the header-only write ungated",
      (s: string) =>
        s.replace(
          /mode === "DRAFT"(\s*)\? await updateHeaderOnly\(/,
          "true$1? await updateHeaderOnly(",
        ),
      "updateHeaderOnly is not gated on DRAFT",
    ],
    [
      "the pre-tx filing check ungated",
      (s: string) => s.replace('mode === "DRAFT" &&\n      (dto.items ||', "(dto.items ||"),
      "the pre-tx filing check is not gated on DRAFT",
    ],
  ])("the pin bites: %s", (_name, mutate, expected) => {
    const mutated = mutate(service);
    expect(mutated).not.toBe(service);
    expect(gateShapeViolations(mutated).join("|")).toContain(expected);
  });
});
