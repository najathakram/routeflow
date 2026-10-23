/**
 * W-702 / SA-860 static pins.
 *  R6: the issuing dry run stays side-effect-free: the code between the dry-run tx's open and its rollback (and the
 *      shared credit helper it calls) reaches no gateway, messaging, storage, email or PDF API.
 *  R7: one read: the email path hands the PDF service its snapshot, and the PDF service reads the invoice itself only when
 *      it was given none.
 */
import { readFileSync } from "fs";
import { join } from "path";

const read = (f: string) => readFileSync(join(__dirname, f), "utf8");

describe("W-702 the email snapshot (SA-860)", () => {
  const service = read("invoices.service.ts");
  const snap = read("invoice-send-snapshot.ts");
  const regionOf = (src: string, startMarker: string, endMarker: string) => {
    const a = src.indexOf(startMarker);
    const b = src.indexOf(endMarker, a);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    return src.slice(a, b);
  };
  const region = (startMarker: string, endMarker: string) =>
    regionOf(service, startMarker, endMarker);

  it("R6: the dry run and the shared credit helper call no non-DB API", () => {
    const dryRun = snap.slice(snap.indexOf("export async function readSendSnapshot("));
    const credits = regionOf(
      snap,
      "export async function runSendCredits(",
      "export async function readSendSnapshot(",
    );
    expect(dryRun.length).toBeGreaterThan(100);
    for (const body of [dryRun, credits]) {
      expect(body).not.toMatch(/this\.(gateway|messaging|storage|emailService|pdfService)\b/);
      expect(body).not.toMatch(
        /emit[A-Z]\w*\(|notifyEvent\(|sendInvoice\(|\.upload\(|getOrGenerate\(/,
      );
    }
    // the dry run ends in the rollback throw, so nothing it wrote can commit
    expect(dryRun).toMatch(/throw new SendSnapshotRollback\(/);
    // and it runs the SAME credit helper the real commit runs
    expect(dryRun).toMatch(/runSendCredits\(creditNotes, tx, id, true, locked\)/);
    expect(region("private async markSent(", "sendEmail(...args")).toMatch(
      /runSendCredits\(this\.creditNotes, tx, id, issuing, updated\)/,
    );
  });

  it("R7: the email path builds the PDF, the payload and the fingerprint from the one snapshot", () => {
    const deliver = region("private async deliverEmail(", "this.gateway.emitInvoiceUpdated(");
    expect(deliver).toMatch(/getOrGenerate\(id, \{ variant, model: snapshot \}\)/);
    expect(deliver).toMatch(/buildInvoiceEmailPayload\(snapshot,/);
    expect(deliver).toMatch(/fingerprintOfSnapshot\([\s\S]*snapshot/);
    // exactly one dry-run/snapshot read, and no second invoice read for the document
    expect(deliver.match(/readSendSnapshot\(/g)).toHaveLength(1);
  });

  it("R7: the PDF service reads the invoice itself only when it got no model", () => {
    const pdf = read("invoice-pdf.service.ts");
    expect(pdf).toMatch(
      /const inv =\s*model \?\?\s*\(await this\.prisma\.forTenant\(\)\.invoice\.findUnique\(/,
    );
    expect(pdf.match(/invoice\.findUnique\(/g)).toHaveLength(1);
  });

  // SA-874 MUST 2: a non-DB effect added anywhere the dry run reaches would fire inside a ROLLED-BACK tx (clients told of
  // credits that never committed). So the pin walks the credit code itself: the three entry methods and every method of
  // the same class they call (transitively), plus the commission sync the credit application runs.
  const classBody = (src: string, name: string) => {
    const re = new RegExp(`\\n  (?:private |public |protected )?(?:async )?${name}\\s*\\(`);
    const m = re.exec(src);
    expect(m).not.toBeNull();
    const start = (m as RegExpExecArray).index;
    const end = src.indexOf("\n  }\n", start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };
  const FORBIDDEN =
    /this\.(gateway|messaging|storage|emailService|pdfService|notifications|email)\b|\bemit[A-Z]\w*\(|\.emit\(|\.publish\(|notifyEvent\(|\.notify\(|sendInvoice\(|\.upload\(|getOrGenerate\(|afterCommit\(|onCommit\(|runAfterCommit\(/;

  // Walk a class's methods from the given entries, following every `this.<method>(` call to a method of the same class.
  const walkClass = (src: string, entries: string[]) => {
    const seen = new Set<string>();
    const queue = [...entries];
    const hits: Array<{ method: string; hit: string | null }> = [];
    while (queue.length) {
      const name = queue.shift() as string;
      if (seen.has(name)) continue;
      seen.add(name);
      const body = classBody(src, name);
      hits.push({ method: name, hit: FORBIDDEN.exec(body)?.[0] ?? null });
      for (const m of body.matchAll(/this\.([A-Za-z_]\w*)\(/g)) {
        const callee = m[1];
        if (
          !seen.has(callee) &&
          new RegExp(`\\n  (?:private |public |protected )?(?:async )?${callee}\\s*\\(`).test(src)
        ) {
          queue.push(callee);
        }
      }
    }
    return { seen, hits };
  };
  const noHits = (hits: Array<{ method: string; hit: string | null }>) =>
    expect(hits.filter((h) => h.hit !== null)).toEqual([]);

  it("R6 (SA-874): the credit code the dry run executes has no non-DB effect and no after-commit hook", () => {
    const credits = readFileSync(
      join(__dirname, "../credit-notes/credit-notes.service.ts"),
      "utf8",
    );
    const { seen, hits } = walkClass(credits, [
      "settleOrderCreditsInTx",
      "autoApplyOldestCreditsInTx",
      "applyCreditInTx",
    ]);
    noHits(hits);
    // the walk really reached helpers (so the pin is not vacuous)
    expect(seen.size).toBeGreaterThan(3);
  });

  it("R6 (SA-880): the commission sync that RUNS INSIDE the dry-run tx is walked too (syncInvoiceCommission, runSync, helpers)", () => {
    const engine = readFileSync(
      join(__dirname, "../sales-agents/commission-engine.service.ts"),
      "utf8",
    );
    const { seen, hits } = walkClass(engine, [
      "syncInvoiceCommissionSafe",
      "syncInvoiceCommission",
    ]);
    noHits(hits);
    expect(seen.has("runSync")).toBe(true);
    expect(seen.has("logSyncFailure")).toBe(true);
  });

  it("the forbidden pattern catches a bare .emit( / .publish( as well as the named APIs (so a new effect turns R6 red)", () => {
    for (const bad of [
      'this.events.emit("x")',
      "this.gateway.emitInvoiceUpdated(a)",
      "bus.publish(msg)",
      "this.messaging.notifyEvent(e)",
      "afterCommit(() => 1)",
    ]) {
      expect(FORBIDDEN.test(bad)).toBe(true);
    }
    expect(FORBIDDEN.test("await tx.invoice.update({ where: { id } })")).toBe(false);
  });
});
