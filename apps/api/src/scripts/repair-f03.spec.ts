import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

// T-R10 / R10 — the F03 repair lane's script contract.
//
// `.claude/pipeline/2026-08-31-f03-payment-truth/{discovery,spec,test-plan}.md` (F03) put this
// batch's own bugs' damage in five classes: four MECHANICALLY repairable (status drift / B74,
// stale PERCENT_OF_SALE categoryTaxAmount / B57, stranded explicit OrderCreditNote selections /
// B85, invoicedQty conservation drift / B84) and one that is NOT — a reclassified
// CREDIT_NOTE/ADVANCE payment method (B81) is unidentifiable post-hoc because the very thing that
// would prove the damage (the original method) is what got overwritten. `scripts/repair-f03.mjs`
// is this batch's whole R10 deliverable; on the untouched tree it does not exist, so every
// assertion below is red.
//
// The script is ESM (`.mjs`); this project's Jest runs CommonJS with a `.ts`-only transform
// (apps/api/package.json's `jest.transform` matches `^.+\.(t|j)s$`, which a `.mjs` filename never
// satisfies), so it cannot be `require`d or statically `import`ed from here. Following the
// established convention for exactly this boundary (apps/api/src/prisma/rls-preflight.spec.ts,
// REG-G8c/R10 of a different batch), the script is driven for real in a child Node process
// (native ESM via `--input-type=module`) and its result is read back as JSON over a stdout
// marker — the assertions stay in this file, not in a grep.
//
// CONTRACT this spec fixes for the implementation (the file exists only as a signature stub —
// this spec is where the behaviour is decided): `scripts/repair-f03.mjs` exports
//   parseFlags(argv) -> { execute: boolean, backupAttested: boolean, forceNonprod: boolean }
//   assertRepairTarget(databaseUrl, flags) -> void (throws on a non-production target)
//   identifyRepairs(store) -> Promise<{ proposals: Proposal[], unrepairable: Unrepairable[] }>
//   applyRepairs(store, proposals, flags) -> Promise<{ applied: Ref[], skipped: Ref[], logPath }>
// where a Proposal is `{ class, id, before, after }` and identifyRepairs is READ-ONLY — it must
// never call any store mutator. applyRepairs must refuse (reject) unless BOTH
// flags.execute AND flags.backupAttested are true, and — mirroring scripts/repair-integrity.mjs's
// per-row "re-read inside the transaction and byte-compare to the dry-run snapshot" safety shape
// — must re-read each row's current state before writing it, skipping (not applying) any row
// whose state no longer matches what identifyRepairs saw.
//
// OUT OF THIS FILE'S REACH (recorded in the test plan under T-R10, verified by hand on the
// post-deploy repair flight, not here): the real Prisma read/write path and the per-row
// transaction — the store is injected precisely so the contract can be proven without a
// database, which means the Prisma binding itself is not what these assertions exercise. What IS
// pinned here is everything that does not need a DB: the proposals, the read-only dry run, the
// two-flag refusal, the drift skip, the non-prod entry guard, and the JSONL log path.
//
// The `store` is a seeded fake (not Postgres): five rows, one per damage class plus one clean
// control that must never produce a proposal. Each store method is hand-rolled against a plain
// in-memory object (not a blind pass-through) specifically so "wrote nothing" and "wrote exactly
// once, with the right value" are provable by inspecting the fake's own recorded `writes`, not by
// asserting on a mock this file half-configured to already agree with the code under test.

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "repair-f03.mjs");

/**
 * The seeded fake store, as a plain-JS source fragment (no backticks/`${}` inside — it is itself
 * interpolated into an outer template literal below). One row per damage class:
 *
 *   inv-status-drift      (B74) — stored status "PAID" is the pre-fix bug's own damage: the old
 *                          `not: VOID` sum counted the $50 DRAFT payment (80+50=130 >= total),
 *                          flipping status early. The CONFIRMED-only ($80) recompute says PARTIAL.
 *   inv-clean-control      — byte-identical payments/total to inv-status-drift, but ALREADY
 *                          stores the correct "PARTIAL" — proves the detector doesn't fire on
 *                          data that merely resembles the damaged shape.
 *   line-stale-tax         (B57) — categoryTaxAmount 7.00 was computed against a subtotal of 100
 *                          that later dropped to 50; 7% of the CURRENT subtotal is 3.50, and the
 *                          invoice's single-line taxAmount header must resum to the same 3.50.
 *   credit-stranded        (B85) — an explicit-amount credit selection on an order that has since
 *                          been invoiced, never settled.
 *   oi-qty-drift           (B84) — invoicedQty double-released to 20; live non-VOID invoice lines
 *                          for it only ever amounted to 10 (conservedQty).
 *
 * If an implementation summed non-VOID (not CONFIRMED-only) payments for the status check, it
 * would compute 130 for inv-status-drift, see it already matches nothing-to-flag arithmetic
 * differently — the point pinned by T-B11s/T-B74 elsewhere — and this fixture keeps that same
 * predicate load-bearing here: reverting to a `not: VOID` sum changes what counts as "drift".
 */
const SEED_STORE_SRC = `
function freshStore() {
  return {
    invoices: [
      {
        id: "inv-status-drift",
        status: "PAID",
        total: 130,
        dueDate: null,
        payments: [
          { amount: 80, status: "PAID" },
          { amount: 50, status: "DRAFT" },
        ],
      },
      {
        id: "inv-clean-control",
        status: "PARTIAL",
        total: 130,
        dueDate: null,
        payments: [
          { amount: 80, status: "PAID" },
          { amount: 50, status: "DRAFT" },
        ],
      },
    ],
    percentOfSaleLines: [
      {
        id: "line-stale-tax",
        invoiceId: "inv-stale-tax",
        subtotal: 50,
        categoryTaxRate: 0.07,
        categoryTaxAmount: 7,
      },
    ],
    invoiceTaxHeaders: [{ id: "inv-stale-tax", taxAmount: 7 }],
    creditSelections: [
      {
        id: "credit-stranded",
        orderId: "order-stranded",
        invoiced: true,
        settled: false,
        explicitAmount: 25,
      },
    ],
    orderItems: [{ id: "oi-qty-drift", qty: 10, invoicedQty: 20, conservedQty: 10 }],
    writes: [],
    listInvoices() {
      return this.invoices.map((r) => ({ ...r }));
    },
    listPercentOfSaleLines() {
      return this.percentOfSaleLines.map((l) => ({
        ...l,
        invoiceTaxAmount:
          (this.invoiceTaxHeaders.find((h) => h.id === l.invoiceId) || {}).taxAmount,
      }));
    },
    listCreditSelections() {
      return this.creditSelections.map((r) => ({ ...r }));
    },
    listOrderItems() {
      return this.orderItems.map((r) => ({ ...r }));
    },
    rereadInvoice(id) {
      const r = this.invoices.find((x) => x.id === id);
      return r ? { ...r } : null;
    },
    rereadPercentOfSaleLine(id) {
      const l = this.percentOfSaleLines.find((x) => x.id === id);
      if (!l) return null;
      const h = this.invoiceTaxHeaders.find((x) => x.id === l.invoiceId);
      return { ...l, invoiceTaxAmount: h ? h.taxAmount : null };
    },
    rereadCreditSelection(id) {
      const r = this.creditSelections.find((x) => x.id === id);
      return r ? { ...r } : null;
    },
    rereadOrderItem(id) {
      const r = this.orderItems.find((x) => x.id === id);
      return r ? { ...r } : null;
    },
    updateInvoiceStatus(id, status) {
      this.writes.push({ op: "updateInvoiceStatus", id, status });
      const r = this.invoices.find((x) => x.id === id);
      if (r) r.status = status;
    },
    updateLineTax(lineId, categoryTaxAmount, invoiceTaxAmount) {
      this.writes.push({ op: "updateLineTax", id: lineId, categoryTaxAmount, invoiceTaxAmount });
      const l = this.percentOfSaleLines.find((x) => x.id === lineId);
      if (l) {
        l.categoryTaxAmount = categoryTaxAmount;
        const h = this.invoiceTaxHeaders.find((x) => x.id === l.invoiceId);
        if (h) h.taxAmount = invoiceTaxAmount;
      }
    },
    settleCreditSelection(id, amountApplied) {
      this.writes.push({ op: "settleCreditSelection", id, amountApplied });
      const r = this.creditSelections.find((x) => x.id === id);
      if (r) {
        r.settled = true;
        r.amountApplied = amountApplied;
      }
    },
    updateOrderItemQty(id, qty) {
      this.writes.push({ op: "updateOrderItemQty", id, qty });
      const r = this.orderItems.find((x) => x.id === id);
      if (r) r.invoicedQty = qty;
    },
  };
}
`;

/**
 * Runs `body` (plain JS, `await`-capable) in a fresh Node ESM child process with
 * identifyRepairs/applyRepairs/parseFlags and freshStore() already imported/declared, and returns
 * the JSON the body must print via `console.log("__RESULT__" + JSON.stringify(...))`.
 *
 * Throws — the correct RED shape while the script doesn't exist yet — if the child exits non-zero
 * or never prints the marker (mirrors rls-preflight.spec.ts's driveCounter()).
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
      `driving repair-f03.mjs failed (status ${res.status}):\n${res.stdout}\n${res.stderr}`,
    );
  }
  return JSON.parse(res.stdout.slice(marker + "__RESULT__".length));
}

describe("scripts/repair-f03.mjs — F03 repair lane (T-R10 / R10)", () => {
  describe("dry run (read-only) — REG-B74 REG-B57 REG-B85 REG-B84", () => {
    it("lists exactly the four repairable-class proposals with before→after, leaves the clean control out, reports B81 as unrepairable, and writes nothing", () => {
      const result = runRepairDriver(`
        const store = freshStore();
        const dry = await identifyRepairs(store);
        console.log("__RESULT__" + JSON.stringify({ dry, writes: store.writes }));
      `);

      const { dry, writes } = result;

      // Exactly 4 — not "at least 4": a detector that also flagged the control, or duplicated a
      // class, must go red here just as surely as one that missed a class.
      expect(dry.proposals).toHaveLength(4);

      const byId = Object.fromEntries(dry.proposals.map((p: any) => [p.id, p]));
      expect(Object.keys(byId).sort()).toEqual(
        ["credit-stranded", "inv-status-drift", "line-stale-tax", "oi-qty-drift"].sort(),
      );
      // The control never appears — same payments/total as the damaged twin, differing only by
      // already holding the status recompute would produce.
      expect(byId["inv-clean-control"]).toBeUndefined();

      // REG-B74 — status drift: the pre-fix bug's own non-VOID sum (80+50=130 >= total) is what
      // put "PAID" on the row; the CONFIRMED-only ($80) recompute says PARTIAL.
      expect(byId["inv-status-drift"].class).toBe("status-drift");
      expect(byId["inv-status-drift"].before).toEqual({ status: "PAID" });
      expect(byId["inv-status-drift"].after).toEqual({ status: "PARTIAL" });

      // REG-B57 — stale categoryTaxAmount: 7% of the CURRENT subtotal (50), not the 100 it was
      // last computed against; the invoice's taxAmount header resums to the same value.
      expect(byId["line-stale-tax"].class).toBe("stale-category-tax");
      expect(byId["line-stale-tax"].before).toEqual({ categoryTaxAmount: 7, invoiceTaxAmount: 7 });
      expect(byId["line-stale-tax"].after).toEqual({
        categoryTaxAmount: 3.5,
        invoiceTaxAmount: 3.5,
      });

      // REG-B85 — stranded explicit credit selection on an invoiced order, never settled.
      expect(byId["credit-stranded"].class).toBe("stranded-credit");
      expect(byId["credit-stranded"].before).toEqual({ settled: false });
      expect(byId["credit-stranded"].after).toEqual({ settled: true, amountApplied: 25 });

      // REG-B84 — invoicedQty conservation drift: double-released to 20, conserved value is 10.
      expect(byId["oi-qty-drift"].class).toBe("qty-conservation-drift");
      expect(byId["oi-qty-drift"].before).toEqual({ invoicedQty: 20 });
      expect(byId["oi-qty-drift"].after).toEqual({ invoicedQty: 10 });

      // B81 — reclassified CREDIT_NOTE/ADVANCE payment method: unidentifiable post-hoc (the
      // method itself was overwritten), so it is documented, not detected from any seeded row.
      expect(dry.unrepairable).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ticket: "B81", status: "unrepairable, not modified" }),
        ]),
      );

      // The read-only half of the safety shape: a dry run that wrote anything at all is the one
      // mutation this test exists to catch (repair-integrity.mjs's default-read-only stance).
      expect(writes).toEqual([]);
    });

    // Two live-data shapes the sweep must NOT damage. The production SQL scopes both out (see
    // DETECTION SCOPE in scripts/repair-f03.mjs), but that query is out of this file's reach —
    // what IS in reach, and what these assertions pin, is the store-agnostic half of each guard,
    // which is the layer any future store binding also has to pass through.
    it("never demotes a PAID invoice with no payment rows, and clamps a conserved qty to the order line's qty", () => {
      const result = runRepairDriver(`
        const store = freshStore();

        // A CSV-imported invoice: import.service.ts's "existing" branch writes {status, dueDate,
        // paidAt} and creates NO InvoicePayment at all; findAll/findOne honour that status via
        // isSettled. A blanket recompute sees 0 confirmed, proposes PAID -> SENT, and re-opens a
        // settled receivable (also nulling paidAt, which the revenue windows read).
        store.invoices.push({
          id: "inv-imported-paid",
          status: "PAID",
          total: 100,
          dueDate: null,
          payments: [],
        });

        // An order line re-invoiced and then reduced: the live invoice lines conserve MORE than
        // the line now carries. invoicedQty is documented "Capped at qty" (the Prisma schema) and
        // adjustInvoicedQtyForInvoice's adjust() clamps to it, so the proposal must be the cap
        // (10) and never the raw sum (25) — an over-cap write turns every remaining-qty reader's
        // qty - invoicedQty negative.
        store.orderItems[0].conservedQty = 25;

        const dry = await identifyRepairs(store);
        console.log("__RESULT__" + JSON.stringify({ dry, writes: store.writes }));
      `);

      const byId = Object.fromEntries(result.dry.proposals.map((p: any) => [p.id, p]));
      expect(byId["inv-imported-paid"]).toBeUndefined();
      expect(byId["oi-qty-drift"].before).toEqual({ invoicedQty: 20 });
      expect(byId["oi-qty-drift"].after).toEqual({ invoicedQty: 10 });
      expect(result.writes).toEqual([]);
    });
  });

  // The REG tokens belong on this describe too: the red gate selects by
  // `-t "REG-B(11|57|74|81|84|85|102|103)|REG-B50s"`, so a guard case without them is invisible to
  // the gate — R10's safety half would sit outside the very filter that proves it red.
  describe("execute guard — REG-B74 REG-B57 REG-B85 REG-B84", () => {
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

      // Both single-flag combinations must be refused — neither flag alone is enough, mirroring
      // repair-integrity.mjs's `EXECUTE && !BACKUP_ATTESTED` guard extended to both directions.
      expect(result.executeOnlyError).not.toBeNull();
      expect(result.executeOnlyError).toMatch(/fresh.backup/i);
      expect(result.backupOnlyError).not.toBeNull();
      expect(result.backupOnlyError).toMatch(/execute/i);

      // Neither refused attempt may have written anything.
      expect(result.writes).toEqual([]);
    });

    // R10: "refuses non-prod DB without --force-nonprod". This script's whole purpose is
    // repairing PRODUCTION rows (build-plan P5, owner's repair-as-we-go decision), so being
    // pointed at a local/dev database is the accident the entry guard exists to catch —
    // silently "repairing" a dev copy would report success while prod stayed damaged.
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

  describe("execute (both flags) — REG-B74 REG-B57 REG-B85 REG-B84", () => {
    it("applies each of the four repairs via exactly one write per row, leaving the control and B81 untouched", () => {
      const result = runRepairDriver(`
        const store = freshStore();
        const dry = await identifyRepairs(store);
        const applied = await applyRepairs(
          store,
          dry.proposals,
          parseFlags(["--execute", "--i-have-a-fresh-backup"]),
        );
        console.log(
          "__RESULT__" +
            JSON.stringify({
              applied,
              writes: store.writes,
              invoices: store.invoices,
              percentOfSaleLines: store.percentOfSaleLines,
              invoiceTaxHeaders: store.invoiceTaxHeaders,
              creditSelections: store.creditSelections,
              orderItems: store.orderItems,
            }),
        );
      `);

      const appliedIds = result.applied.applied.map((r: any) => r.id).sort();
      expect(appliedIds).toEqual(
        ["credit-stranded", "inv-status-drift", "line-stale-tax", "oi-qty-drift"].sort(),
      );
      expect(result.applied.skipped).toEqual([]);

      // Exactly one write per repaired row — not zero (never applied), not two (double-applied).
      expect(result.writes).toHaveLength(4);

      const invoice = result.invoices.find((i: any) => i.id === "inv-status-drift");
      expect(invoice.status).toBe("PARTIAL");
      const control = result.invoices.find((i: any) => i.id === "inv-clean-control");
      expect(control.status).toBe("PARTIAL"); // unchanged — it was already correct

      const line = result.percentOfSaleLines.find((l: any) => l.id === "line-stale-tax");
      expect(line.categoryTaxAmount).toBe(3.5);
      const header = result.invoiceTaxHeaders.find((h: any) => h.id === "inv-stale-tax");
      expect(header.taxAmount).toBe(3.5);

      const credit = result.creditSelections.find((c: any) => c.id === "credit-stranded");
      expect(credit.settled).toBe(true);
      expect(credit.amountApplied).toBe(25);

      const orderItem = result.orderItems.find((o: any) => o.id === "oi-qty-drift");
      expect(orderItem.invoicedQty).toBe(10);

      // R10's audit half: every applied repair is journalled (JSONL, with the before-state)
      // under local-assets/ — that log is what a rollback is reconstructed from, and the
      // path has to come back to the caller or the operator can't file it on the board.
      expect(typeof result.applied.logPath).toBe("string");
      expect(result.applied.logPath.replace(/\\/g, "/")).toContain("local-assets/");
    });

    it("re-reads a row before writing and skips it if it drifted since the dry run, while still applying the untouched rows", () => {
      // Between the dry run and the execute pass, something else changes inv-status-drift out of
      // band (e.g. another repair run, or the invoice was voided in the app in the meantime) —
      // exactly the window scripts/repair-integrity.mjs's per-row re-read-and-compare exists to
      // close. The apply pass must notice the row no longer matches what it planned against and
      // skip ONLY that row, not silently overwrite it and not abort the whole batch.
      const result = runRepairDriver(`
        const store = freshStore();
        const dry = await identifyRepairs(store);

        store.invoices.find((x) => x.id === "inv-status-drift").status = "VOID";

        const applied = await applyRepairs(
          store,
          dry.proposals,
          parseFlags(["--execute", "--i-have-a-fresh-backup"]),
        );
        console.log(
          "__RESULT__" + JSON.stringify({ applied, writes: store.writes, invoices: store.invoices }),
        );
      `);

      const appliedIds = result.applied.applied.map((r: any) => r.id).sort();
      const skippedIds = result.applied.skipped.map((r: any) => r.id);

      // The drifted row is skipped, not applied — and the other three still land normally.
      expect(skippedIds).toEqual(["inv-status-drift"]);
      expect(appliedIds).toEqual(["credit-stranded", "line-stale-tax", "oi-qty-drift"].sort());

      // No write was ever attempted for the drifted row — the guard fires BEFORE the write, not
      // as a rollback after one.
      expect(result.writes.some((w: any) => w.id === "inv-status-drift")).toBe(false);
      expect(result.writes).toHaveLength(3);

      // The out-of-band VOID is left exactly as it was — the repair script must not clobber it.
      const invoice = result.invoices.find((i: any) => i.id === "inv-status-drift");
      expect(invoice.status).toBe("VOID");
    });
  });
});
