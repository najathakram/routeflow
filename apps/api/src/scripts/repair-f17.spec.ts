import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// T-R17 / REG-B99 — the F17 repair lane's script contract (build-plan P3).
//
// F17's code fix (R2 / P1, `import.service.ts`) stops FUTURE payment re-uploads from
// double-recording, but it does nothing for the rows B99 already damaged before the fix landed:
// a re-uploaded payments file with no `zohoPaymentId` on a row created a second, indistinguishable
// InvoicePayment and could flip the invoice PAID early. `scripts/repair-f17.mjs` is that repair
// lane — it finds live duplicate-payment PAIRS matching the damage signature and, only when
// explicitly told to, VOIDs the later twin and recomputes the invoice's status/paidAt from the
// surviving CONFIRMED rows. On the untouched tree the script does not exist, so every assertion
// below is red.
//
// The script is ESM (`.mjs`); this project's Jest runs CommonJS with a `.ts`-only transform
// (apps/api/package.json's `jest.transform` matches `^.+\.(t|j)s$`, which a `.mjs` filename never
// satisfies), so it cannot be `require`d or statically `import`ed from here. Following the
// established convention for exactly this boundary (apps/api/src/scripts/repair-f03.spec.ts,
// T-R10 of the F03 batch — mirrored here precisely), the script is driven for real in a child Node
// process (native ESM via `--input-type=module`) and its result is read back as JSON over a stdout
// marker — the assertions stay in this file, not in a grep.
//
// CONTRACT this spec fixes for the implementation (the file exists only as a signature stub —
// this spec is where the behaviour is decided): `scripts/repair-f17.mjs` exports
//   parseFlags(argv) -> { execute: boolean, backupAttested: boolean, forceNonprod: boolean }
//   assertRepairTarget(databaseUrl, flags) -> void (throws on a non-production target)
//   identifyRepairs(store) -> Promise<{ proposals: Proposal[], unrepairable: Unrepairable[] }>
//   applyRepairs(store, proposals, flags) -> Promise<{ applied: Ref[], skipped: Ref[], logPath }>
// where a Proposal is `{ class: "duplicate-payment", id, invoiceId, before, after }` (`id` is the
// LATER twin — the one proposed for VOID) and identifyRepairs is READ-ONLY — it must never call
// any store mutator. applyRepairs must refuse (reject) unless BOTH flags.execute AND
// flags.backupAttested are true, and — mirroring scripts/repair-integrity.mjs's per-row "re-read
// and compare to the dry-run snapshot" safety shape — must re-read each row's current state before
// writing it, skipping (not applying) any row whose state no longer matches what identifyRepairs
// saw.
//
// DAMAGE SIGNATURE (build-plan P3): per invoice, a payment PAIR is the true B99 duplicate iff both
// rows share a cent-equal amount, the same method, `createdAt` within ±1 day of each other, and
// neither carries a reference that would distinguish them (a real `zohoPaymentId` proves the two
// rows are NOT duplicates — the import's own reference-based check already caught that case). A
// pair on different days is not proposed. A cluster of MORE than two mutually matching rows is
// ambiguous (which N-1 of them are the true duplicates cannot be determined from the signature
// alone) and is report-only — returned under `unrepairable`, never auto-voided.
//
// The `store` is a seeded fake (not Postgres): six invoices — one true duplicate pair, one
// same-amount-different-day pair (must NOT be proposed), one three-row cluster (report-only), one
// clean control (two payments differing in amount AND method, so the signature never matches), one
// otherwise-matching pair whose two rows carry DISTINCT real references, and one otherwise-matching
// pair whose later row is already VOID. The last two pin the two eligibility predicates the
// signature is built on (reference and non-VOID); like the control, none of the three may appear in
// either `proposals` or `unrepairable`. Each store method is hand-rolled
// against a plain in-memory object (not a blind pass-through) so "wrote nothing" and "wrote exactly
// once, with the right value" are provable by inspecting the fake's own recorded `writes`.

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "repair-f17.mjs");

/**
 * The seeded fake store, as a plain-JS source fragment (no backticks/`${}` inside — it is itself
 * interpolated into an outer template literal below).
 *
 *   inv-dup-pair          — the true B99 duplicate: two $100 CASH payments, no reference, 6h
 *                          apart (well within ±1 day). The wrongful double-count (100+100=200 >=
 *                          total 150) is what put "PAID" on the invoice; voiding the later twin
 *                          leaves $100 confirmed against a $150 total, so the correct recompute
 *                          is "PARTIAL" with paidAt cleared.
 *   inv-diff-day          — same $75 CASH amount and method, but 3 days apart — outside the ±1 day
 *                          window, so this is NOT the damage signature and must produce no
 *                          proposal. Its status (PARTIAL, 75+75=150 < total 200) is already
 *                          correct either way.
 *   inv-cluster           — three mutually matching $30 ACH rows on the same day: a cluster of
 *                          more than two, which no pairing can be auto-resolved from the signature
 *                          alone. Report-only.
 *   inv-clean-control      — two payments that differ in BOTH amount ($60 vs $90) and method (CASH
 *                          vs CHECK) — proves the detector doesn't fire on a two-payment invoice
 *                          that merely resembles the damaged shape. Already correctly "PAID"
 *                          (60+90 = total 150).
 *   inv-referenced-pair   — two $40 CHECK payments 4h apart — every part of the signature matches
 *                          EXCEPT that each row carries its own real external reference
 *                          ("zoho-pay-1"/"zoho-pay-2"). A real zohoPaymentId proves the rows are
 *                          two distinct payments, so the reference predicate must drop both before
 *                          pairing. Correctly "PAID" (40+40 = total 80).
 *   inv-already-void      — two $50 CASH payments 6h apart where the later twin is ALREADY "VOID"
 *                          (an operator cleaned it up by hand, or an earlier repair run did). The
 *                          VOID row is not eligible, so no pair forms — re-voiding it and
 *                          recomputing the invoice a second time is the double-repair this row
 *                          exists to prevent. Already correctly "PARTIAL" (50 confirmed of 120).
 */
const SEED_STORE_SRC = `
function freshStore() {
  return {
    invoices: [
      {
        id: "inv-dup-pair",
        status: "PAID",
        total: 150,
        paidAt: "2026-06-01T15:00:00.000Z",
        payments: [
          {
            id: "pay-dup-first",
            amount: 100,
            method: "CASH",
            reference: null,
            createdAt: "2026-06-01T09:00:00.000Z",
            status: "PAID",
          },
          {
            id: "pay-dup-second",
            amount: 100,
            method: "CASH",
            reference: null,
            createdAt: "2026-06-01T15:00:00.000Z",
            status: "PAID",
          },
        ],
      },
      {
        id: "inv-diff-day",
        status: "PARTIAL",
        total: 200,
        paidAt: null,
        payments: [
          {
            id: "pay-diffday-a",
            amount: 75,
            method: "CASH",
            reference: null,
            createdAt: "2026-06-01T09:00:00.000Z",
            status: "PAID",
          },
          {
            id: "pay-diffday-b",
            amount: 75,
            method: "CASH",
            reference: null,
            createdAt: "2026-06-04T09:00:00.000Z",
            status: "PAID",
          },
        ],
      },
      {
        id: "inv-cluster",
        status: "PAID",
        total: 90,
        paidAt: "2026-06-01T10:00:00.000Z",
        payments: [
          {
            id: "pay-cluster-1",
            amount: 30,
            method: "ACH",
            reference: null,
            createdAt: "2026-06-01T08:00:00.000Z",
            status: "PAID",
          },
          {
            id: "pay-cluster-2",
            amount: 30,
            method: "ACH",
            reference: null,
            createdAt: "2026-06-01T09:00:00.000Z",
            status: "PAID",
          },
          {
            id: "pay-cluster-3",
            amount: 30,
            method: "ACH",
            reference: null,
            createdAt: "2026-06-01T10:00:00.000Z",
            status: "PAID",
          },
        ],
      },
      {
        id: "inv-clean-control",
        status: "PAID",
        total: 150,
        paidAt: "2026-06-01T09:30:00.000Z",
        payments: [
          {
            id: "pay-control-a",
            amount: 60,
            method: "CASH",
            reference: null,
            createdAt: "2026-06-01T09:00:00.000Z",
            status: "PAID",
          },
          {
            id: "pay-control-b",
            amount: 90,
            method: "CHECK",
            reference: null,
            createdAt: "2026-06-01T09:30:00.000Z",
            status: "PAID",
          },
        ],
      },
      {
        id: "inv-referenced-pair",
        status: "PAID",
        total: 80,
        paidAt: "2026-06-01T13:00:00.000Z",
        payments: [
          {
            id: "pay-ref-a",
            amount: 40,
            method: "CHECK",
            reference: "zoho-pay-1",
            createdAt: "2026-06-01T09:00:00.000Z",
            status: "PAID",
          },
          {
            id: "pay-ref-b",
            amount: 40,
            method: "CHECK",
            reference: "zoho-pay-2",
            createdAt: "2026-06-01T13:00:00.000Z",
            status: "PAID",
          },
        ],
      },
      {
        id: "inv-already-void",
        status: "PARTIAL",
        total: 120,
        paidAt: null,
        payments: [
          {
            id: "pay-void-survivor",
            amount: 50,
            method: "CASH",
            reference: null,
            createdAt: "2026-06-01T09:00:00.000Z",
            status: "PAID",
          },
          {
            id: "pay-void-twin",
            amount: 50,
            method: "CASH",
            reference: null,
            createdAt: "2026-06-01T15:00:00.000Z",
            status: "VOID",
          },
        ],
      },
    ],
    writes: [],
    listInvoices() {
      return this.invoices.map((inv) => ({
        ...inv,
        payments: inv.payments.map((p) => ({ ...p })),
      }));
    },
    // Pre-write drift check: current live state of one payment + its invoice — including the
    // total and the live payment rows the proposed after-status was DERIVED from, which the
    // status/paidAt pair alone does not pin.
    rereadPair(paymentId, invoiceId) {
      const inv = this.invoices.find((x) => x.id === invoiceId);
      if (!inv) return null;
      const pay = inv.payments.find((p) => p.id === paymentId);
      if (!pay) return null;
      return {
        paymentStatus: pay.status,
        invoiceStatus: inv.status,
        paidAt: inv.paidAt,
        total: inv.total,
        dueDate: inv.dueDate === undefined ? null : inv.dueDate,
        payments: inv.payments.map((p) => ({ id: p.id, amount: p.amount, status: p.status })),
      };
    },
    voidDuplicatePayment(paymentId, invoiceId, nextInvoiceStatus, nextPaidAt) {
      this.writes.push({
        op: "voidDuplicatePayment",
        id: paymentId,
        invoiceId,
        nextInvoiceStatus,
        nextPaidAt,
      });
      const inv = this.invoices.find((x) => x.id === invoiceId);
      const pay = inv && inv.payments.find((p) => p.id === paymentId);
      if (pay) pay.status = "VOID";
      if (inv) {
        inv.status = nextInvoiceStatus;
        inv.paidAt = nextPaidAt;
      }
    },
  };
}

// ONE invoice carrying TWO duplicate pairs — the shape a payments file with two rows for the same
// invoice produces when it is re-uploaded. Total 500; the real payments are 250 CASH (06-01) and
// 60 CHECK (06-05), each doubled 6h later, so 620 is counted against a 500 invoice and it reads
// PAID. Amounts are chosen so voiding the FIRST twin alone already drops the invoice to PARTIAL
// (370 < 500): the second pair therefore has to plan against that moved state, not against the
// invoice as the dry run first found it.
function twoPairStore() {
  const store = freshStore();
  store.invoices = [
    {
      id: "inv-two-pairs",
      status: "PAID",
      total: 500,
      paidAt: "2026-06-05T15:00:00.000Z",
      payments: [
        {
          id: "pay-2p-a1",
          amount: 250,
          method: "CASH",
          reference: null,
          createdAt: "2026-06-01T09:00:00.000Z",
          status: "PAID",
        },
        {
          id: "pay-2p-a2",
          amount: 250,
          method: "CASH",
          reference: null,
          createdAt: "2026-06-01T15:00:00.000Z",
          status: "PAID",
        },
        {
          id: "pay-2p-b1",
          amount: 60,
          method: "CHECK",
          reference: null,
          createdAt: "2026-06-05T09:00:00.000Z",
          status: "PAID",
        },
        {
          id: "pay-2p-b2",
          amount: 60,
          method: "CHECK",
          reference: null,
          createdAt: "2026-06-05T15:00:00.000Z",
          status: "PAID",
        },
      ],
    },
    // The mirror case: total 500 with 100 CASH (06-01) and 250 CHECK (06-05) each doubled, so
    // voiding the FIRST twin still leaves 600 confirmed and the invoice is legitimately PAID
    // until the second twin goes too. The intermediate status differs from the final one here,
    // so a write that recomputed as if every twin were already voided would stamp PARTIAL on an
    // invoice whose own rows still say PAID.
    {
      id: "inv-two-pairs-staged",
      status: "PAID",
      total: 500,
      paidAt: "2026-06-05T15:00:00.000Z",
      payments: [
        {
          id: "pay-2ps-c1",
          amount: 100,
          method: "CASH",
          reference: null,
          createdAt: "2026-06-01T09:00:00.000Z",
          status: "PAID",
        },
        {
          id: "pay-2ps-c2",
          amount: 100,
          method: "CASH",
          reference: null,
          createdAt: "2026-06-01T15:00:00.000Z",
          status: "PAID",
        },
        {
          id: "pay-2ps-d1",
          amount: 250,
          method: "CHECK",
          reference: null,
          createdAt: "2026-06-05T09:00:00.000Z",
          status: "PAID",
        },
        {
          id: "pay-2ps-d2",
          amount: 250,
          method: "CHECK",
          reference: null,
          createdAt: "2026-06-05T15:00:00.000Z",
          status: "PAID",
        },
      ],
    },
  ];
  return store;
}

// THREE invoices, each carrying exactly ONE true duplicate pair — the batch shape a single
// re-uploaded payments file produces when it covers several invoices. They are identical by
// construction so that the only thing distinguishing them is their POSITION in the proposal list:
// a test drifts the middle one out from under the apply pass and the first and third are the
// evidence that a skip does not end the batch.
function threeInvoiceStore() {
  const store = freshStore();
  const invoice = (n) => ({
    id: "inv-batch-" + n,
    status: "PAID",
    total: 150,
    paidAt: "2026-06-01T15:00:00.000Z",
    payments: [
      {
        id: "pay-b" + n + "-first",
        amount: 100,
        method: "CASH",
        reference: null,
        createdAt: "2026-06-01T09:00:00.000Z",
        status: "PAID",
      },
      {
        id: "pay-b" + n + "-second",
        amount: 100,
        method: "CASH",
        reference: null,
        createdAt: "2026-06-01T15:00:00.000Z",
        status: "PAID",
      },
    ],
  });
  store.invoices = [invoice(1), invoice(2), invoice(3)];
  return store;
}
`;

/**
 * Runs `body` (plain JS, `await`-capable) in a fresh Node ESM child process with
 * identifyRepairs/applyRepairs/parseFlags/assertRepairTarget already imported and freshStore()
 * already declared, and returns the JSON the body must print via
 * `console.log("__RESULT__" + JSON.stringify(...))`.
 *
 * Throws — the correct RED shape while the script doesn't exist yet — if the child exits non-zero
 * or never prints the marker (mirrors repair-f03.spec.ts's runRepairDriver()).
 */
function runRepairDriver(body: string): any {
  const moduleUrl = pathToFileURL(SCRIPT).href;
  const driver = `
import {
  identifyRepairs,
  applyRepairs,
  parseFlags,
  assertRepairTarget,
} from ${JSON.stringify(moduleUrl)};
${SEED_STORE_SRC}
${body}
`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  const marker = res.stdout.indexOf("__RESULT__");
  if (res.status !== 0 || marker === -1) {
    throw new Error(
      `driving repair-f17.mjs failed (status ${res.status}):\n${res.stdout}\n${res.stderr}`,
    );
  }
  return JSON.parse(res.stdout.slice(marker + "__RESULT__".length));
}

describe("scripts/repair-f17.mjs — F17 repair lane (T-R17 / REG-B99)", () => {
  // Audit logs the execute pass really writes into the (gitignored) local-assets/ folder. They are
  // read back for assertions and then removed, so a test run leaves nothing behind.
  const writtenLogs: string[] = [];
  afterAll(() => {
    for (const logPath of writtenLogs) {
      try {
        fs.unlinkSync(logPath);
      } catch {
        // Already gone — nothing to clean up.
      }
    }
  });

  describe("dry run (read-only)", () => {
    it("proposes exactly the one true duplicate pair (VOID the later twin + status/paidAt recompute), excludes the different-day pair, the clean control, the distinctly-referenced pair and the already-VOID twin, reports the >2 cluster as unrepairable, and writes nothing", () => {
      const result = runRepairDriver(`
        const store = freshStore();
        const dry = await identifyRepairs(store);
        console.log("__RESULT__" + JSON.stringify({ dry, writes: store.writes }));
      `);

      const { dry, writes } = result;

      // Exactly one — not "at least one": a detector that also flagged the diff-day pair, the
      // cluster, the clean control, the distinctly-referenced pair or the already-VOID twin must
      // go red here just as surely as one that missed the true pair.
      expect(dry.proposals).toHaveLength(1);

      const proposal = dry.proposals[0];
      expect(proposal.class).toBe("duplicate-payment");
      // The LATER twin (createdAt 15:00) is the one proposed for VOID, not the earlier survivor.
      expect(proposal.id).toBe("pay-dup-second");
      expect(proposal.invoiceId).toBe("inv-dup-pair");
      expect(proposal.before).toEqual({
        paymentStatus: "PAID",
        invoiceStatus: "PAID",
        paidAt: "2026-06-01T15:00:00.000Z",
      });
      // $100 confirmed remains against a $150 total once the duplicate is voided — PARTIAL, not
      // PAID, and paidAt is cleared along with it (the invoice is no longer settled).
      expect(proposal.after).toEqual({
        paymentStatus: "VOID",
        invoiceStatus: "PARTIAL",
        paidAt: null,
      });

      // The same-amount-different-day pair is outside the ±1 day window — not the damage
      // signature, so neither of its rows may appear in any proposal.
      const proposedIds = dry.proposals.map((p: any) => p.id);
      expect(proposedIds).not.toEqual(expect.arrayContaining(["pay-diffday-a", "pay-diffday-b"]));

      // The clean control (differing amount AND method) never matches the signature.
      expect(proposedIds).not.toEqual(expect.arrayContaining(["pay-control-a", "pay-control-b"]));

      // Neither eligibility predicate may quietly become a no-op. A pair whose rows carry
      // DISTINCT real references is two genuine payments (the import's reference check already
      // handled that case), and a twin that is already VOID has nothing left to void — both
      // invoices must fall out before pairing, so neither their rows nor their invoices may
      // surface as a proposal or as a report.
      for (const id of ["pay-ref-a", "pay-ref-b", "pay-void-survivor", "pay-void-twin"]) {
        expect(proposedIds).not.toContain(id);
      }
      const reportedInvoiceIds = dry.unrepairable.map((u: any) => u.invoiceId);
      expect(reportedInvoiceIds).not.toContain("inv-referenced-pair");
      expect(reportedInvoiceIds).not.toContain("inv-already-void");

      // The three-row cluster is ambiguous — reported, never auto-voided.
      expect(proposedIds).not.toEqual(
        expect.arrayContaining(["pay-cluster-1", "pay-cluster-2", "pay-cluster-3"]),
      );
      expect(dry.unrepairable).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            invoiceId: "inv-cluster",
            paymentIds: expect.arrayContaining(["pay-cluster-1", "pay-cluster-2", "pay-cluster-3"]),
            reason: expect.stringMatching(/cluster|ambiguous/i),
          }),
        ]),
      );
      // The cluster entry is the only unrepairable entry — the clean control and the diff-day
      // pair are excluded outright, not merely downgraded to "reported".
      expect(dry.unrepairable).toHaveLength(1);

      // The read-only half of the safety shape: a dry run that wrote anything at all is the one
      // mutation this test exists to catch.
      expect(writes).toEqual([]);
    });
  });

  describe("execute guard", () => {
    it("refuses to write without BOTH --execute and --i-have-a-fresh-backup", () => {
      const result = runRepairDriver(`
        const store = freshStore();
        const dry = await identifyRepairs(store);

        let executeOnlyError = null;
        try {
          await applyRepairs(store, dry.proposals, parseFlags(["--execute"]));
        } catch (e) {
          executeOnlyError = String((e && e.message) || e);
        }

        let backupOnlyError = null;
        try {
          await applyRepairs(store, dry.proposals, parseFlags(["--i-have-a-fresh-backup"]));
        } catch (e) {
          backupOnlyError = String((e && e.message) || e);
        }

        console.log(
          "__RESULT__" + JSON.stringify({ executeOnlyError, backupOnlyError, writes: store.writes }),
        );
      `);

      // Both single-flag combinations must be refused — neither flag alone is enough.
      expect(result.executeOnlyError).not.toBeNull();
      expect(result.executeOnlyError).toMatch(/fresh.backup/i);
      expect(result.backupOnlyError).not.toBeNull();
      expect(result.backupOnlyError).toMatch(/execute/i);

      // Neither refused attempt may have written anything.
      expect(result.writes).toEqual([]);
    });

    // R2/P3: "refuses non-prod DB without --force-nonprod". This script's whole purpose is
    // repairing PRODUCTION rows (owner's repair-as-we-go decision, build-plan non-goals), so being
    // pointed at a local/dev database is the accident the entry guard exists to catch — silently
    // "repairing" a dev copy would report success while prod stayed damaged.
    it("refuses a non-production DATABASE_URL unless --force-nonprod is passed", () => {
      const result = runRepairDriver(`
        const call = (url, argv) => {
          try {
            assertRepairTarget(url, parseFlags(argv));
            return null;
          } catch (e) {
            return String((e && e.message) || e);
          }
        };
        const LOCAL = "postgresql://user:redacted@localhost:5432/routeflow";
        const PROD = "postgresql://user:redacted@postgres.railway.internal:5432/railway";
        console.log(
          "__RESULT__" +
            JSON.stringify({
              localRefusal: call(LOCAL, []),
              localForced: call(LOCAL, ["--force-nonprod"]),
              prodAllowed: call(PROD, []),
            }),
        );
      `);

      // Red today: the stub never throws, so a local database sails straight through.
      expect(result.localRefusal).not.toBeNull();
      expect(result.localRefusal).toMatch(/force-nonprod/i);
      // The opt-out works, and the production target it was written for is never blocked.
      expect(result.localForced).toBeNull();
      expect(result.prodAllowed).toBeNull();
    });
  });

  describe("execute (both flags)", () => {
    it("voids the later twin and recomputes the invoice via exactly one write, and files the before-state in a local-assets/ JSONL audit log", () => {
      const result = runRepairDriver(`
        const store = freshStore();
        const dry = await identifyRepairs(store);
        const applied = await applyRepairs(
          store,
          dry.proposals,
          parseFlags(["--execute", "--i-have-a-fresh-backup"]),
        );
        console.log(
          "__RESULT__" + JSON.stringify({ applied, writes: store.writes, invoices: store.invoices }),
        );
      `);

      expect(result.applied.applied.map((r: any) => r.id)).toEqual(["pay-dup-second"]);
      expect(result.applied.skipped).toEqual([]);

      // Exactly one write for the one duplicate pair — not zero (never applied), not two
      // (payment and invoice written separately, or the pair double-applied).
      expect(result.writes).toHaveLength(1);

      const invoice = result.invoices.find((i: any) => i.id === "inv-dup-pair");
      const later = invoice.payments.find((p: any) => p.id === "pay-dup-second");
      const survivor = invoice.payments.find((p: any) => p.id === "pay-dup-first");
      expect(later.status).toBe("VOID");
      expect(survivor.status).toBe("PAID"); // untouched
      expect(invoice.status).toBe("PARTIAL");
      expect(invoice.paidAt).toBeNull();

      // Every other invoice is left exactly as seeded — the repair touches only its one target.
      const control = result.invoices.find((i: any) => i.id === "inv-clean-control");
      expect(control.status).toBe("PAID");

      // The audit trail a rollback is reconstructed from — the path has to come back to the
      // caller or the operator can't file it on the board, and the file behind it has to actually
      // exist and carry the before-state. A returned path with nothing written behind it would let
      // a production run void payments with no recoverable trail.
      const logPath: string = result.applied.logPath;
      expect(typeof logPath).toBe("string");
      expect(logPath.replace(/\\/g, "/")).toContain("local-assets/");
      writtenLogs.push(logPath);

      expect(fs.existsSync(logPath)).toBe(true);
      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      // One repaired row, one JSONL line — not zero (never written) and not two (double-logged).
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      expect(entry.id).toBe("pay-dup-second");
      expect(entry.invoiceId).toBe("inv-dup-pair");
      // The before-state is the whole point of the log: it is what the rollback restores.
      expect(entry.before).toEqual({
        paymentStatus: "PAID",
        invoiceStatus: "PAID",
        paidAt: "2026-06-01T15:00:00.000Z",
      });
    });

    it("re-reads the row before writing and skips it if it drifted since the dry run, without voiding or recomputing anything", () => {
      // Between the dry run and the execute pass, something else changes the later twin out of
      // band (e.g. an operator already voided it by hand) — exactly the window
      // scripts/repair-integrity.mjs's per-row re-read-and-compare exists to close. The apply pass
      // must notice the row no longer matches what it planned against and skip it, not silently
      // recompute the invoice on top of a state it never verified.
      const result = runRepairDriver(`
        const store = freshStore();
        const dry = await identifyRepairs(store);

        const inv = store.invoices.find((x) => x.id === "inv-dup-pair");
        inv.payments.find((p) => p.id === "pay-dup-second").status = "VOID";

        const applied = await applyRepairs(
          store,
          dry.proposals,
          parseFlags(["--execute", "--i-have-a-fresh-backup"]),
        );
        console.log(
          "__RESULT__" + JSON.stringify({ applied, writes: store.writes, invoices: store.invoices }),
        );
      `);

      expect(result.applied.applied).toEqual([]);
      expect(result.applied.skipped.map((r: any) => r.id)).toEqual(["pay-dup-second"]);

      // No write was ever attempted for the drifted row — the guard fires BEFORE the write, not
      // as a rollback after one.
      expect(result.writes).toEqual([]);

      // The out-of-band VOID, and the invoice's original (never-recomputed) status, are left
      // exactly as they were — the repair script must not clobber or half-apply either one.
      const invoice = result.invoices.find((i: any) => i.id === "inv-dup-pair");
      const later = invoice.payments.find((p: any) => p.id === "pay-dup-second");
      expect(later.status).toBe("VOID");
      expect(invoice.status).toBe("PAID");
      expect(invoice.paidAt).toBe("2026-06-01T15:00:00.000Z");
    });

    // The blind spot a status/paidAt-only guard leaves open. The proposed after-status is computed
    // from the invoice's TOTAL and its PAYMENT ROWS — neither of which those two fields pin. On a
    // live database the window between the dry run and the execute pass is real: here a customer
    // pays $50 in between. The invoice is still PAID with the same paidAt, so both the pre-write
    // re-read and the in-transaction compare-and-set sail straight through — yet the surviving
    // confirmed payments ($100 + $50) now exactly settle the $150 total. Writing the planned
    // PARTIAL / paidAt null there leaves a fully-paid customer carrying an outstanding balance on
    // receivables and on their documents.
    it("skips a row whose payments moved since the dry run even though its status and paidAt did not", () => {
      const result = runRepairDriver(`
        const store = freshStore();
        const dry = await identifyRepairs(store);

        // Between the two passes: a real customer payment lands on the same invoice.
        const inv = store.invoices.find((x) => x.id === "inv-dup-pair");
        inv.payments.push({
          id: "pay-late-customer",
          amount: 50,
          method: "CASH",
          reference: null,
          createdAt: "2026-06-02T09:00:00.000Z",
          status: "PAID",
        });

        const applied = await applyRepairs(
          store,
          dry.proposals,
          parseFlags(["--execute", "--i-have-a-fresh-backup"]),
        );
        console.log(
          "__RESULT__" + JSON.stringify({ applied, writes: store.writes, invoices: store.invoices }),
        );
      `);

      // The proposal planned PARTIAL; a recompute against the invoice as it stands now says PAID,
      // so the row must be skipped — with a reason that names the drift, not silently dropped.
      expect(result.applied.applied).toEqual([]);
      expect(result.applied.skipped.map((r: any) => r.id)).toEqual(["pay-dup-second"]);
      expect(result.applied.skipped[0].reason).toMatch(/drift/i);
      expect(result.applied.skipped[0].reason).toMatch(/PAID/);

      // Nothing was written: no twin voided, no status recomputed.
      expect(result.writes).toEqual([]);

      const invoice = result.invoices.find((i: any) => i.id === "inv-dup-pair");
      expect(invoice.status).toBe("PAID");
      expect(invoice.paidAt).toBe("2026-06-01T15:00:00.000Z");
      expect(invoice.payments.find((p: any) => p.id === "pay-dup-second").status).toBe("PAID");
      expect(invoice.payments.find((p: any) => p.id === "pay-dup-first").status).toBe("PAID");
    });

    // TWO duplicate pairs on ONE invoice — what a payments file carrying two rows for the same
    // invoice produces when it is re-uploaded, i.e. the central B99 shape, not an exotic edge.
    // Each twin is voided by its own write, so the state the FIRST write leaves behind has to be
    // the state the second one plans against. A shared "as if both were already voided"
    // after-state makes the second proposal's pre-write re-read look like outside drift: only one
    // twin gets voided, the invoice is left carrying a status that contradicts its own surviving
    // payments, and the operator is pointed at a concurrent writer that never existed.
    it("applies every duplicate pair on one invoice, stepping the status through each write instead of skipping the later pairs as drifted", () => {
      const result = runRepairDriver(`
        const store = twoPairStore();
        const dry = await identifyRepairs(store);
        const applied = await applyRepairs(
          store,
          dry.proposals,
          parseFlags(["--execute", "--i-have-a-fresh-backup"]),
        );
        console.log(
          "__RESULT__" +
            JSON.stringify({ dry, applied, writes: store.writes, invoices: store.invoices }),
        );
      `);

      const proposalsFor = (invoiceId: string) =>
        result.dry.proposals.filter((p: any) => p.invoiceId === invoiceId);
      const ORIGINAL_PAID_AT = "2026-06-05T15:00:00.000Z";

      // One proposal per pair — the later twin of each, in createdAt order.
      const moved = proposalsFor("inv-two-pairs");
      expect(moved.map((p: any) => p.id)).toEqual(["pay-2p-a2", "pay-2p-b2"]);

      // The dry run is the only human gate before money is voided, so each proposal has to say
      // WHAT it voids — amount, method, both timestamps and the twin that survives. Two identical
      // same-day payments are also a legitimate shape; only the operator can tell them apart.
      expect(moved[0]).toEqual(
        expect.objectContaining({
          amount: 250,
          method: "CASH",
          createdAt: "2026-06-01T15:00:00.000Z",
          survivorId: "pay-2p-a1",
          survivorCreatedAt: "2026-06-01T09:00:00.000Z",
        }),
      );

      // The first write voids one 250 twin, leaving 370 against a 500 total — PARTIAL, paidAt
      // cleared. The SECOND proposal must plan against exactly that, or its pre-write re-read
      // reads the first write as outside drift and the pair is never repaired.
      expect(moved[0].before).toEqual({
        paymentStatus: "PAID",
        invoiceStatus: "PAID",
        paidAt: ORIGINAL_PAID_AT,
      });
      expect(moved[0].after).toEqual({
        paymentStatus: "VOID",
        invoiceStatus: "PARTIAL",
        paidAt: null,
      });
      expect(moved[1].before).toEqual({
        paymentStatus: "PAID",
        invoiceStatus: "PARTIAL",
        paidAt: null,
      });
      expect(moved[1].after).toEqual({
        paymentStatus: "VOID",
        invoiceStatus: "PARTIAL",
        paidAt: null,
      });

      // The mirror invoice: after the first twin goes, 600 is still confirmed against 500, so the
      // invoice is genuinely still PAID at that point. A recompute that assumed BOTH twins were
      // already voided would write PARTIAL here — a status the invoice's own rows contradict
      // until the second write lands.
      const staged = proposalsFor("inv-two-pairs-staged");
      expect(staged.map((p: any) => p.id)).toEqual(["pay-2ps-c2", "pay-2ps-d2"]);
      expect(staged[0].after).toEqual({
        paymentStatus: "VOID",
        invoiceStatus: "PAID",
        paidAt: ORIGINAL_PAID_AT,
      });
      expect(staged[1].before).toEqual({
        paymentStatus: "PAID",
        invoiceStatus: "PAID",
        paidAt: ORIGINAL_PAID_AT,
      });
      expect(staged[1].after).toEqual({
        paymentStatus: "VOID",
        invoiceStatus: "PARTIAL",
        paidAt: null,
      });

      // EVERY pair is written — nothing is skipped as "drifted" by the script's own earlier write.
      expect(result.applied.applied.map((r: any) => r.id)).toEqual([
        "pay-2p-a2",
        "pay-2p-b2",
        "pay-2ps-c2",
        "pay-2ps-d2",
      ]);
      expect(result.applied.skipped).toEqual([]);
      expect(result.writes).toHaveLength(4);
      writtenLogs.push(result.applied.logPath);

      const statusesOf = (invoiceId: string) => {
        const inv = result.invoices.find((i: any) => i.id === invoiceId);
        return {
          status: inv.status,
          paidAt: inv.paidAt,
          payments: Object.fromEntries(inv.payments.map((p: any) => [p.id, p.status])),
        };
      };

      // 250 + 60 = 310 and 100 + 250 = 350, both against a 500 total: each invoice now agrees
      // with its own surviving rows, and only the later twins were voided.
      expect(statusesOf("inv-two-pairs")).toEqual({
        status: "PARTIAL",
        paidAt: null,
        payments: {
          "pay-2p-a1": "PAID",
          "pay-2p-a2": "VOID",
          "pay-2p-b1": "PAID",
          "pay-2p-b2": "VOID",
        },
      });
      expect(statusesOf("inv-two-pairs-staged")).toEqual({
        status: "PARTIAL",
        paidAt: null,
        payments: {
          "pay-2ps-c1": "PAID",
          "pay-2ps-c2": "VOID",
          "pay-2ps-d1": "PAID",
          "pay-2ps-d2": "VOID",
        },
      });
    });

    // A skip is a PER-ROW verdict, not a batch verdict — and nothing else in this file proves it.
    // Every other drift test drives a single proposal (where "skipped one row" and "aborted the
    // whole run" produce identical output), and the multi-pair test has no skips at all. So
    // turning the skip path's `continue` into a `break` — or letting it throw — would leave all of
    // them green while a production run silently stopped at the first drifted row and left every
    // later invoice damaged, reporting a plausible "Applied N · skipped 1" on the way out.
    // Three invoices, one pair each, drift in the MIDDLE: the third one being written is the whole
    // assertion.
    it("skips only the drifted row in the middle of a batch and still applies the rows after it", () => {
      const result = runRepairDriver(`
        const store = threeInvoiceStore();
        const dry = await identifyRepairs(store);

        // Between the dry run and the execute pass, a real customer payment lands on the MIDDLE
        // invoice only. Its status and paidAt are untouched, but 100 surviving + 50 now settles
        // the 150 total, so a fresh recompute says PAID where the proposal planned PARTIAL.
        const middle = store.invoices.find((x) => x.id === "inv-batch-2");
        middle.payments.push({
          id: "pay-b2-late-customer",
          amount: 50,
          method: "CASH",
          reference: null,
          createdAt: "2026-06-02T09:00:00.000Z",
          status: "PAID",
        });

        const applied = await applyRepairs(
          store,
          dry.proposals,
          parseFlags(["--execute", "--i-have-a-fresh-backup"]),
        );
        console.log(
          "__RESULT__" +
            JSON.stringify({ dry, applied, writes: store.writes, invoices: store.invoices }),
        );
      `);

      // One proposal per invoice, in invoice order — so the drifted row really is the MIDDLE of
      // the batch and not, say, the last one (where a `break` would be indistinguishable).
      expect(result.dry.proposals.map((p: any) => p.id)).toEqual([
        "pay-b1-second",
        "pay-b2-second",
        "pay-b3-second",
      ]);

      // The batch carries on: the row AFTER the skip is applied, not abandoned.
      expect(result.applied.applied.map((r: any) => r.id)).toEqual([
        "pay-b1-second",
        "pay-b3-second",
      ]);
      expect(result.applied.skipped.map((r: any) => r.id)).toEqual(["pay-b2-second"]);
      expect(result.applied.skipped[0].reason).toMatch(/drift/i);

      // Read from the store's own recorded writes, so this cannot be satisfied by a return value
      // that merely claims the third row was applied.
      expect(result.writes.map((w: any) => w.id)).toEqual(["pay-b1-second", "pay-b3-second"]);
      writtenLogs.push(result.applied.logPath);

      const statusesOf = (invoiceId: string) => {
        const inv = result.invoices.find((i: any) => i.id === invoiceId);
        return {
          status: inv.status,
          paidAt: inv.paidAt,
          payments: Object.fromEntries(inv.payments.map((p: any) => [p.id, p.status])),
        };
      };

      // First and third: repaired — later twin VOID, 100 against a 150 total, paidAt cleared.
      expect(statusesOf("inv-batch-1")).toEqual({
        status: "PARTIAL",
        paidAt: null,
        payments: { "pay-b1-first": "PAID", "pay-b1-second": "VOID" },
      });
      expect(statusesOf("inv-batch-3")).toEqual({
        status: "PARTIAL",
        paidAt: null,
        payments: { "pay-b3-first": "PAID", "pay-b3-second": "VOID" },
      });

      // The drifted middle is left exactly as the out-of-band payment left it — nothing voided,
      // no status recomputed on top of a state the script never verified.
      expect(statusesOf("inv-batch-2")).toEqual({
        status: "PAID",
        paidAt: "2026-06-01T15:00:00.000Z",
        payments: {
          "pay-b2-first": "PAID",
          "pay-b2-second": "PAID",
          "pay-b2-late-customer": "PAID",
        },
      });
    });
  });

  // createPgStore's SQL is the one part of this script no test can execute (the driver injects a
  // fake store, and the dry run never writes), and the failure it can carry silently is an
  // identifier that does not exist: Postgres raises 42703, applyRepairs catches it per row, and a
  // production run prints "Applied 0 · skipped N" that reads exactly like ordinary drift. Standing
  // guard — every column the script assigns must exist on the model it writes, AND every
  // table/alias/column the in-transaction re-derivation SELECT reads must exist too. The SELECT
  // needs its own check because the assignment guard below regexes `UPDATE "<table>" … SET` only:
  // a wrong column or a stale alias inside a read is invisible to it, and `InvoicePayment` in
  // particular has NO `updatedAt` column to reach for (a repair UPDATE that set one was a blocker
  // earlier in this batch — the same mistake made in a SELECT fails just as silently).
  describe("createPgStore SQL vs the Prisma schema", () => {
    const script = fs.readFileSync(SCRIPT, "utf8");
    // The datamodel is a FOLDER of *.prisma files (item 10a) — concatenate them all, and fail
    // loudly if the folder is missing or empty rather than checking against an empty string.
    const schemaDir = path.join(REPO_ROOT, "apps", "api", "prisma", "schema");
    const schemaFiles = fs.readdirSync(schemaDir).filter((f) => f.endsWith(".prisma"));
    if (schemaFiles.length === 0) {
      throw new Error(`no *.prisma files under ${schemaDir} — the Prisma schema folder moved`);
    }
    const schema = schemaFiles
      .sort()
      .map((f) => fs.readFileSync(path.join(schemaDir, f), "utf8"))
      .join("\n");

    /** Field names declared on a Prisma model. */
    const fieldsOf = (model: string): string[] => {
      const body = new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
      expect(body).not.toBeNull();
      return (body as RegExpExecArray)[1]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("//") && !line.startsWith("@@"))
        .map((line) => line.split(/\s+/)[0]);
    };

    /** Columns the script's UPDATE of `table` assigns. */
    const assignedColumns = (table: string): string[] => {
      const stmt = new RegExp(`UPDATE "${table}"[\\s\\S]*?WHERE`).exec(script);
      expect(stmt).not.toBeNull();
      const setClause = (stmt as RegExpExecArray)[0].replace(/^[\s\S]*?SET/, "");
      return [...setClause.matchAll(/"?([A-Za-z_][A-Za-z0-9_]*)"?\s*=/g)].map((m) => m[1]);
    };

    it.each([["InvoicePayment"], ["Invoice"]])(
      "assigns only columns that exist on %s",
      (table: string) => {
        const fields = fieldsOf(table);
        const assigned = assignedColumns(table);
        expect(assigned.length).toBeGreaterThan(0);
        expect(assigned.filter((column) => !fields.includes(column))).toEqual([]);
      },
    );

    /**
     * The re-derivation SELECT inside `voidDuplicatePayment` — the read that decides, inside the
     * transaction, whether the status about to be written is still the right one. Returned as raw
     * SQL text so its identifiers can be checked; it is the FIRST template literal in that
     * function that opens with SELECT.
     */
    const freshDerivationSelect = (): string => {
      const start = script.indexOf("async voidDuplicatePayment(");
      expect(start).toBeGreaterThan(-1);
      const sql = /`(\s*SELECT[\s\S]*?)`/.exec(script.slice(start));
      expect(sql).not.toBeNull();
      return (sql as RegExpExecArray)[1];
    };

    /** `FROM "Table" alias` / `JOIN "Table" alias` → alias -> table. */
    const tableAliases = (sql: string): Map<string, string> => {
      const aliases = new Map<string, string>();
      for (const m of sql.matchAll(
        /\b(?:FROM|JOIN)\s+"([A-Za-z_][A-Za-z0-9_]*)"\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/gi,
      )) {
        aliases.set(m[2], m[1]);
      }
      return aliases;
    };

    /**
     * Every `alias.column` / `alias."column"` reference in the SQL. Output labels (`AS "foo"`) are
     * unqualified and so never match — only real column reads are collected.
     */
    const qualifiedRefs = (sql: string): Array<{ alias: string; column: string }> =>
      [...sql.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.("?)([A-Za-z_][A-Za-z0-9_]*)\2/g)].map((m) => ({
        alias: m[1],
        column: m[3],
      }));

    it("reads only tables and columns that exist in the in-transaction re-derivation SELECT", () => {
      const sql = freshDerivationSelect();

      // Every aliased table has to BE a model — fieldsOf fails the test if the regex finds no
      // `model <Table> {` block in the prisma/schema folder.
      const aliases = tableAliases(sql);
      expect(aliases.size).toBeGreaterThanOrEqual(2);
      for (const table of aliases.values()) {
        expect(fieldsOf(table).length).toBeGreaterThan(0);
      }

      // Non-vacuous: the SELECT really does qualify its columns through those aliases, so an
      // empty `unknown` below means "all checked", not "nothing found".
      const refs = qualifiedRefs(sql);
      expect(refs.length).toBeGreaterThan(0);

      // An unresolvable alias is as fatal at runtime as a missing column (42P01/42703), so both
      // land in the same list.
      const unknown = refs.filter(({ alias, column }) => {
        const table = aliases.get(alias);
        return !table || !fieldsOf(table).includes(column);
      });
      expect(unknown).toEqual([]);
    });
  });
});
