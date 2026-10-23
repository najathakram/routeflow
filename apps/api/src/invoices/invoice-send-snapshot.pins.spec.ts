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
});
