import * as fs from "fs";
import * as path from "path";

/**
 * SA-1508 R-252L MEDIUM-1: the lasting, file-scoped guard for invoices/invoice-draft-return.ts (the revert and
 * reopen bodies moved out of InvoicesService). The 3R body comparison was move proof only; this scan is what
 * stays. Modelled on delivered-line-lock.writer-pin.spec.ts (a scan of one writer file with comments stripped).
 *
 * The rules (each one is checked by `violations()` and goes red under a mutation, see "probes" below):
 *   R1 every `.create/.update/.upsert/.delete...(` receiver starts with `tx.`
 *   R2 no raw SQL
 *   R3 no nested-write key inside a `data: { ... }` literal
 *   R4 `tx` is bound only as the parameter of `tenantTransaction(async (tx) =>`, once per writer
 *   R5 `clearIssueDisplayUnits(tx, ` and `syncInvoiceCommissionSafe(id, tx)` appear exactly 2 times each
 *   R6 `lockInvoiceRow(tx,` is the first statement of revert's transaction, ahead of its write
 *   R7 reopen is named as the known gap, with item W-1458
 *   R8 the expected ROW_LOCK_SITES key is named in order-lock-callers.guard.spec.ts
 */
const SRC = path.join(__dirname, "..");
const FILE = "invoices/invoice-draft-return.ts";
const GUARD = "common/order-lock-callers.guard.spec.ts";
const ROW_LOCK_KEY = `${FILE}#revertInvoiceToDraftFlow`;

const strip = (code: string) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length));

const raw = fs.readFileSync(path.join(SRC, FILE), "utf8");
const guardRaw = fs.readFileSync(path.join(SRC, GUARD), "utf8");

const WRITE_VERB = "create|createMany|update|updateMany|upsert|delete|deleteMany";
const NESTED_KEY =
  /\b(?:create|createMany|connectOrCreate|update|updateMany|upsert|delete|deleteMany)\s*:/;

/** The balanced `{ ... }` literal that follows each `data:` key. A `data:` that is not a literal is itself reported. */
function dataLiterals(src: string): { literals: string[]; nonLiteral: number } {
  const literals: string[] = [];
  let nonLiteral = 0;
  const re = /\bdata\s*:\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const at = m.index + m[0].length;
    if (src[at] !== "{") {
      nonLiteral++;
      continue;
    }
    let depth = 0;
    let i = at;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    literals.push(src.slice(at, i + 1));
  }
  return { literals, nonLiteral };
}

/** Writers = the exported async functions; each is sliced to the next one. */
function writers(src: string): Array<{ name: string; body: string }> {
  const heads = [...src.matchAll(/export async function (\w+)\(/g)];
  return heads.map((h, i) => ({
    name: h[1],
    body: src.slice(h.index, heads[i + 1]?.index ?? src.length),
  }));
}

/** Rule ids broken by `rawSrc` (the file as written) and `guardText` (the lock guard spec). Real tree: none. */
function violations(rawSrc: string, guardText: string): string[] {
  const out: string[] = [];
  const src = strip(rawSrc);
  const flat = src.replace(/\s*\n\s*\./g, ".");

  // R1
  const receivers = [...flat.matchAll(new RegExp(`([\\w$.]*)\\.(?:${WRITE_VERB})\\(`, "g"))].map(
    (m) => m[1],
  );
  if (receivers.length === 0 || receivers.some((r) => !/^tx\.[A-Za-z]+$/.test(r))) out.push("R1");

  // R2
  if (/\$(?:execute|query)Raw|\bPrisma\.sql\b|\.query\(|\bsql`/.test(src)) out.push("R2");

  // R3
  const { literals, nonLiteral } = dataLiterals(src);
  if (literals.length === 0 || nonLiteral > 0 || literals.some((l) => NESTED_KEY.test(l.slice(1))))
    out.push("R3");

  // R4
  const ws = writers(src);
  const bindsOnlyTx = ws.every((w) => {
    const txCallbacks = w.body.match(/\btenantTransaction\(\s*async \(tx(?::\s*any)?\)\s*=>/g);
    const txArrowParams = w.body.match(/(?:async\s*)?\(\s*tx\s*(?::[^)]*)?\)\s*=>|\btx\s*=>/g);
    return (
      txCallbacks?.length === 1 &&
      txArrowParams?.length === 1 &&
      !/\b(?:const|let|var)\s+tx\b/.test(w.body) &&
      !/\btx\s*=(?![=>])/.test(w.body) &&
      !/[{,]\s*tx\s*[,}]\s*=/.test(w.body) &&
      !/\bfunction\s*\w*\(\s*tx\b/.test(w.body)
    );
  });
  const callbackParams = [...src.matchAll(/\btenantTransaction\(\s*async \((\w+)/g)].map(
    (m) => m[1],
  );
  if (ws.length !== 2 || !bindsOnlyTx || callbackParams.join() !== "tx,tx") out.push("R4");

  // R5
  if ((src.match(/\bclearIssueDisplayUnits\(tx, /g) ?? []).length !== 2) out.push("R5");
  if ((src.match(/\bclearIssueDisplayUnits\(/g) ?? []).length !== 2) out.push("R5");
  if ((src.match(/\bsyncInvoiceCommissionSafe\(id, tx\)/g) ?? []).length !== 2) out.push("R5");
  if ((src.match(/\bsyncInvoiceCommissionSafe\(/g) ?? []).length !== 2) out.push("R5");

  // R6
  const revert = ws.find((w) => w.name === "revertInvoiceToDraftFlow")?.body ?? "";
  const cb = revert.match(/tenantTransaction\(async \(tx(?:: any)?\) => \{\s*([\s\S]*)/);
  const firstStatement = cb?.[1].trim() ?? "";
  const lock = revert.indexOf("lockInvoiceRow(tx,");
  if (
    !/^const locked = await lockInvoiceRow\(tx,/.test(firstStatement) ||
    lock < 0 ||
    lock > revert.indexOf("tx.invoice.update(") ||
    (src.match(/\blockInvoiceRow\(/g) ?? []).length !== 1
  )
    out.push("R6");

  // R7 (on the file as written: the gap is named in a comment)
  const reopenAt = rawSrc.indexOf("export async function reopenInvoiceFlow(");
  const docAt = rawSrc.lastIndexOf("/**", reopenAt);
  const doc = reopenAt > 0 && docAt >= 0 ? rawSrc.slice(docAt, reopenAt) : "";
  if (!/Known gap/.test(doc) || !/W-1458/.test(doc) || !/no row lock/.test(doc)) out.push("R7");

  // R8
  if (!guardText.includes(`"${ROW_LOCK_KEY}": "Order > Invoice"`)) out.push("R8");

  return out;
}

describe("invoice-draft-return.ts writer pin (SA-1508 R-252L MEDIUM-1)", () => {
  it("the real file breaks no rule", () => {
    expect(violations(raw, guardRaw)).toEqual([]);
  });

  it("is not vacuous: two writers, two Invoice writes on tx, two data literals", () => {
    const flat = strip(raw).replace(/\s*\n\s*\./g, ".");
    expect(writers(strip(raw)).map((w) => w.name)).toEqual([
      "revertInvoiceToDraftFlow",
      "reopenInvoiceFlow",
    ]);
    expect(flat.match(new RegExp(`\\btx\\.invoice\\.(?:${WRITE_VERB})\\(`, "g"))).toHaveLength(2);
    expect(dataLiterals(strip(raw)).literals).toHaveLength(2);
  });

  // The probes: each mutates the real text so exactly the named rule must trip, and each proves it changed the text.
  const mutate = (from: string | RegExp, to: string, text = raw): string => {
    const next = text.replace(from, to);
    expect(next).not.toBe(text);
    return next;
  };
  const probes: Array<[string, string, () => string]> = [
    [
      "R1",
      "a write on the unlocked client",
      () => mutate("tx.invoice.update(", "deps.prisma.forTenant().invoice.update("),
    ],
    [
      "R1",
      "a write on a base-client chain split over lines",
      () => mutate("tx.invoice.update(", "deps.prisma\n      .invoice.update("),
    ],
    [
      "R1",
      "a line write on another receiver",
      () =>
        mutate(
          "await deps.commissionEngine",
          "await deps.prisma.invoiceItem.deleteMany({ where: { invoiceId: id } });\n    await deps.commissionEngine",
        ),
    ],
    [
      "R2",
      "raw SQL",
      () =>
        mutate(
          "await deps.commissionEngine",
          "await tx.$executeRaw`UPDATE \"Invoice\" SET status = 'DRAFT'`;\n    await deps.commissionEngine",
        ),
    ],
    [
      "R3",
      "a nested write under data:",
      () =>
        mutate(
          "paidAt: null },",
          "paidAt: null, items: { updateMany: { where: {}, data: {} } } },",
        ),
    ],
    [
      "R3",
      "a non-literal data:",
      () => mutate("data: { status: InvoiceStatus.DRAFT, paidAt: null },", "data: someData,"),
    ],
    [
      "R4",
      "tx re-bound as a local",
      () =>
        mutate(
          "const locked = await lockInvoiceRow(tx,",
          "const tx2 = deps.prisma.forTenant();\n    const locked = await lockInvoiceRow(tx,",
        ).replace("const tx2", "const tx"),
    ],
    [
      "R4",
      "the callback parameter renamed",
      () =>
        mutate(
          "tenantTransaction(async (tx: any) => {\n    await du.clearIssueDisplayUnits(tx, id); // SA-827 rule 5",
          "tenantTransaction(async (db: any) => {\n    await du.clearIssueDisplayUnits(tx, id); // SA-827 rule 5",
        ),
    ],
    [
      "R4",
      "a third writer",
      () =>
        `${raw}\nexport async function sneakyFlow(deps: InvoiceDraftReturnDeps, id: string) {\n  return deps.prisma.tenantTransaction(async (tx: any) => tx.invoice.update({ where: { id }, data: { notes: null } }));\n}\n`,
    ],
    [
      "R5",
      "a dropped display clear",
      () =>
        mutate(
          "    await du.clearIssueDisplayUnits(tx, id); // SA-827: a DRAFT renders live; a re-issue freezes afresh\n",
          "",
        ),
    ],
    [
      "R5",
      "a third commission sync",
      () =>
        mutate(
          "    return reverted;",
          "    await deps.commissionEngine.syncInvoiceCommissionSafe(id, tx);\n    return reverted;",
        ),
    ],
    [
      "R5",
      "the display clear on another client",
      () =>
        mutate(
          "await du.clearIssueDisplayUnits(tx, id); // SA-827: a DRAFT",
          "await du.clearIssueDisplayUnits(deps.prisma, id); // SA-827: a DRAFT",
        ),
    ],
    [
      "R6",
      "the lock on another client",
      () => mutate("lockInvoiceRow(tx,", "lockInvoiceRow(deps.prisma,"),
    ],
    [
      "R6",
      "a write ahead of the lock",
      () =>
        mutate(
          "const locked = await lockInvoiceRow(tx,",
          "await tx.invoice.update({ where: { id }, data: { status: InvoiceStatus.DRAFT } });\n    const locked = await lockInvoiceRow(tx,",
        ),
    ],
    [
      "R6",
      "a statement ahead of the lock",
      () =>
        mutate(
          "const locked = await lockInvoiceRow(tx,",
          "await tx.invoicePayment.count({ where: { invoiceId: id } });\n    const locked = await lockInvoiceRow(tx,",
        ),
    ],
    ["R7", "reopen's gap note removed", () => mutate("W-1458", "W-0000")],
    [
      "R7",
      "reopen's gap note deleted with its doc",
      () => mutate(/\/\*\*\n \* Known gap[\s\S]*?\*\/\n/, ""),
    ],
  ];

  it.each(probes)("probe %s: %s", (rule, _what, make) => {
    expect(violations(make(), guardRaw)).toContain(rule);
  });

  it("probe R8: the ROW_LOCK_SITES key is renamed or removed", () => {
    expect(
      violations(raw, mutate(ROW_LOCK_KEY, "invoices/invoice-draft-return.ts#renamed", guardRaw)),
    ).toContain("R8");
    expect(violations(raw, mutate(`"${ROW_LOCK_KEY}": "Order > Invoice"`, "", guardRaw))).toContain(
      "R8",
    );
  });

  it("a rule trips alone: each probe leaves the other rules green where they are independent", () => {
    expect(violations(mutate("W-1458", "W-0000"), guardRaw)).toEqual(["R7"]);
    expect(
      violations(mutate("lockInvoiceRow(tx,", "lockInvoiceRow(deps.prisma,"), guardRaw),
    ).toEqual(["R6"]);
  });
});
