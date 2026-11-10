import * as fs from "fs";
import * as path from "path";

/**
 * SA-1124 PR-1b (lead answers Q3 and Q4): every `invoicePayment.create` site in apps/api/src is classified GATED
 * (the enclosing function calls `assertOrderReviewed` before the write) or EXEMPT (with the reason it must keep
 * recording), and the exemption list is COUNT-PINNED. A new create site, or any `createMany` / `upsert` / nested
 * `payments: { create` write, FAILS the build until it is classified here and, if it is staff money on an order
 * invoice, put behind the guard. Same structural idiom as the row-498 census (payment-ref-writers.census.spec.ts),
 * a second axis on the same sites.
 *
 * `recordStandalonePayment` takes a REQUIRED typed `source`: STAFF_ALLOCATION is gated per allocated invoice,
 * STRIPE_SETTLE (money that already moved at the processor, B269) is the one exempt value, and only the Stripe settle
 * path may pass it.
 */
const SRC = path.resolve(__dirname, "..");
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
const read = (r: string) => fs.readFileSync(path.join(SRC, r), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts") && !e.name.includes(".fake-"))
      out.push(p);
  }
  return out;
}

/** Source text with block and line comments removed (a comment naming a call is not a call). */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function"]);
/** The name of the class method (indent 2) or top-level function (indent 0) that contains `index`, and where it starts. */
function enclosing(text: string, index: number): { name: string; start: number } {
  const head = text.slice(0, index);
  const re =
    /^(?: {2})?(?:export\s+)?(?:(?:private|public|protected|static)\s+)*(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\(/gm;
  let found = { name: "?", start: 0 };
  for (let m = re.exec(head); m; m = re.exec(head)) {
    if (!KEYWORDS.has(m[1])) found = { name: m[1], start: m.index };
  }
  return found;
}

const CREATE_RE = /invoicePayment\s*\.\s*create\b/g;
/** createMany / upsert / nested create: never allowed without a new classification (the row-498 regex plus the typed forms). */
const OTHER_WRITE_RE =
  /invoicePayment\s*\.\s*(?:createMany|createManyAndReturn|upsert)\b|(?:payments|invoicePayments|applications):\s*\{\s*(?:create|createMany|connectOrCreate|upsert)\b/g;

type Gate = "GATED" | "GATED_BY_SOURCE" | "GATED_SKIP" | "EXEMPT";
interface Site {
  file: string;
  fn: string;
  gate: Gate;
  why: string;
  caller: string;
}

/** Every `invoicePayment.create` site, in file order. Nine at the PR-1b base. */
const SITES: Site[] = [
  {
    file: "bookkeeping/bookkeeping.service.ts",
    fn: "writeLedgerPayment",
    gate: "GATED",
    why: "POST /bookkeeping/transactions/:id/payments: a staff payment on any invoice, order-linked ones included (it reads inv.orderId for the counter close).",
    caller: "BookkeepingController.recordPayment",
  },
  {
    file: "credit-notes/credit-notes.service.ts",
    fn: "applyCreditInTx",
    gate: "GATED",
    why: "applies stored value to an invoice. The manual apply (applyToInvoice) refuses; the two system callers (send-time sweep, order-intent settle) skip a flagged order before reaching it.",
    caller: "applyToInvoice, autoApplyOldestCreditsInTx, settleOrderCreditsInTx",
  },
  {
    file: "customers/customers.service.ts",
    fn: "applyAdvancePaymentToInvoiceLocked",
    gate: "GATED",
    why: "a staff application of a wallet advance to an issued invoice: the same act as a credit-note application.",
    caller: "CustomersController apply-advance route",
  },
  {
    file: "import/import.service.ts",
    fn: "importInvoices",
    gate: "GATED_SKIP",
    why: "the re-import by Invoice ID: its status sync can flip an order-linked prior to PAID/PARTIAL with a synthetic payment; the locked row asks hasOpenReviewBlock and the row is skipped with a stated reason (SA-1130).",
    caller: "ImportService (upload)",
  },
  {
    file: "import/import.service.ts",
    fn: "importInvoices",
    gate: "EXEMPT",
    why: "creates a new invoice with no order link, so no review flag can apply (its synthetic payment reproduces the source ledger).",
    caller: "ImportService (upload)",
  },
  {
    file: "import/import.service.ts",
    fn: "importPayments",
    gate: "GATED_SKIP",
    why: "a payments file reaches any invoice by number, order-linked ones included; the locked row asks hasOpenReviewBlock and the row is skipped with a stated reason, the zoho-import placeholder kept (SA-1130).",
    caller: "ImportService (upload)",
  },
  {
    file: "invoices/invoices.service.ts",
    fn: "writeInvoicePayment",
    gate: "GATED",
    why: "recordPayment: a staff payment on one invoice (also the counter tender, whose orders carry no flag).",
    caller: "InvoicesController.recordPayment, counter-sale tender, pickup-complete",
  },
  {
    file: "invoices/invoices.service.ts",
    fn: "recordDeliveryPaymentInTx",
    gate: "EXEMPT",
    why: "the driver holds the cash at the door: refusing would lose the record of money already taken.",
    caller:
      "RoutesService.completeWithPayment (OPERATOR-reachable: office staff can record door cash through it, bounded to one stop completion)",
  },
  {
    file: "invoices/invoices.service.ts",
    fn: "writeStandalonePayment",
    gate: "GATED_BY_SOURCE",
    why: "STAFF_ALLOCATION is gated per allocated invoice; STRIPE_SETTLE is exempt (the money moved: refusing is the B269 settlement stall).",
    caller: "InvoicesController.recordStandalonePayment, PaymentRequestsService.approve, settle",
  },
];

/** The exemption lists, count-pinned (OP-7). Growing either one is a decision, made here and nowhere else. */
const EXEMPT_CREATE_SITES = 2; // driver cash at the door, and the brand-new imported invoice (SA-1130: 4 -> 2)
const EXEMPT_SOURCES = ["STRIPE_SETTLE"];

describe("the InvoicePayment write census, review-gate axis (SA-1124 PR-1b)", () => {
  const found: Array<{ file: string; fn: string; text: string; at: number }> = [];
  for (const f of walk(SRC)) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(CREATE_RE)) {
      const e = enclosing(text, m.index!);
      found.push({ file: rel(f), fn: e.name, text: text.slice(e.start, m.index!), at: m.index! });
    }
  }

  it("lists every create site with the function that holds it (a new site fails until classified)", () => {
    const actual = found.map((s) => `${s.file}#${s.fn}`).sort((a, b) => a.localeCompare(b));
    const expected = SITES.map((s) => `${s.file}#${s.fn}`).sort((a, b) => a.localeCompare(b));
    expect(actual).toEqual(expected);
  });

  it("every site names its caller and a reason (nothing is classified by silence)", () => {
    for (const s of SITES) {
      expect({ s: s.fn, why: s.why.length > 20, caller: s.caller.length > 3 }).toEqual({
        s: s.fn,
        why: true,
        caller: true,
      });
    }
  });

  it("the exemption lists are count-pinned", () => {
    expect(SITES.filter((s) => s.gate === "EXEMPT")).toHaveLength(EXEMPT_CREATE_SITES);
    expect(EXEMPT_SOURCES).toEqual(["STRIPE_SETTLE"]);
  });

  it("a GATED site calls assertOrderReviewed before the write; a GATED_SKIP site asks hasOpenReviewBlock in the write's own transaction, after the refusal check; an EXEMPT site never throws the guard", () => {
    // SITES lists the sites in file order, so a repeated file#fn pairs with its n-th write
    const seen = new Map<string, number>();
    for (const site of SITES) {
      const key = `${site.file}#${site.fn}`;
      const nth = seen.get(key) ?? 0;
      seen.set(key, nth + 1);
      const here = found.filter((f) => f.file === site.file && f.fn === site.fn)[nth]!;
      const body = stripComments(here.text);
      const calls = /assertOrderReviewed\(/.test(body);
      if (site.gate === "EXEMPT" || site.gate === "GATED_SKIP")
        expect({ site: site.fn, throws: calls }).toEqual({ site: site.fn, throws: false });
      else expect({ site: site.fn, gate: calls }).toEqual({ site: site.fn, gate: true });
      if (site.gate === "GATED_SKIP") {
        // from the start of the write's own tenantTransaction to the write: the refusal check, then the skip
        const text = read(site.file);
        const tx = text.slice(text.lastIndexOf("tenantTransaction(", here.at), here.at);
        const txBody = stripComments(tx);
        const refusal = txBody.indexOf("importPaymentRefusal(");
        const ask = txBody.indexOf("hasOpenReviewBlock(");
        expect({ site: site.fn, order: refusal >= 0 && ask > refusal }).toEqual({
          site: site.fn,
          order: true,
        });
        expect(txBody).toContain("new ImportRowRefused(IMPORT_REVIEW_REQUIRED_REASON)");
      }
    }
  });

  it("import.service.ts asks the non-throwing predicate in exactly 3 places (the 3 existing-invoice branches) and never the throwing guard (SA-1130)", () => {
    const text = stripComments(read("import/import.service.ts"));
    expect((text.match(/hasOpenReviewBlock\(/g) ?? []).length).toBe(3);
    expect((text.match(/assertOrderReviewed\(/g) ?? []).length).toBe(0);
    // one named reason, shared by the three skips
    expect(
      (text.match(/new ImportRowRefused\(IMPORT_REVIEW_REQUIRED_REASON\)/g) ?? []).length,
    ).toBe(3);
  });

  it("no createMany / upsert / nested payments create exists anywhere (it would bypass this census)", () => {
    const hits: string[] = [];
    for (const f of walk(SRC)) {
      const n = (fs.readFileSync(f, "utf8").match(OTHER_WRITE_RE) ?? []).length;
      if (n) hits.push(`${rel(f)} x${n}`);
    }
    expect(hits).toEqual([]);
  });
});

describe("recordStandalonePayment: the required typed discriminant (lead answer Q4)", () => {
  const callSites = () => {
    const out: Array<{ file: string; args: string }> = [];
    for (const f of walk(SRC)) {
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.matchAll(/\.recordStandalonePayment\(/g)) {
        let depth = 1;
        let i = m.index! + m[0].length;
        const from = i;
        while (i < text.length && depth > 0) {
          const c = text[i++];
          if (c === "(") depth++;
          else if (c === ")") depth--;
        }
        out.push({ file: rel(f), args: text.slice(from, i - 1) });
      }
    }
    return out;
  };

  it("every caller passes a source, and the declaration has no default for it", () => {
    const calls = callSites();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls)
      expect({ file: c.file, typed: /source:\s*"/.test(c.args) }).toEqual({
        file: c.file,
        typed: true,
      });
    const dto = read("invoices/dto/create-invoice.dto.ts");
    expect(dto).toMatch(/source:\s*StandalonePaymentSource;/); // required: no `?`
    expect(dto).toMatch(/StandalonePaymentSource\s*=\s*"STAFF_ALLOCATION"\s*\|\s*"STRIPE_SETTLE"/);
    expect(read("invoices/invoices.service.ts")).toMatch(
      /recordStandalonePayment\(dto: StandalonePaymentDto, opts: StandalonePaymentOpts\)/,
    );
  });

  it("only the Stripe settle path passes the exempt value", () => {
    const passers: string[] = [];
    for (const f of walk(SRC)) {
      const text = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      const n = (text.match(/source:\s*"STRIPE_SETTLE"/g) ?? []).length;
      for (let i = 0; i < n; i++) passers.push(rel(f));
    }
    expect(passers).toEqual(["payment-requests/payment-requests.service.ts"]);
    // and it is the settle writer (the capturedExternally STRIPE capture), never the staff approve
    const pr = read("payment-requests/payment-requests.service.ts");
    const at = pr.indexOf('source: "STRIPE_SETTLE"');
    expect(pr.slice(Math.max(0, at - 400), at + 400)).toContain("capturedExternally: capture");
  });

  it("the staff callers pass STAFF_ALLOCATION: the controller and the cash approval", () => {
    const staff = callSites()
      .filter((c) => /STAFF_ALLOCATION/.test(c.args))
      .map((c) => c.file);
    expect(staff.sort()).toEqual([
      "invoices/invoices.controller.ts",
      "payment-requests/payment-requests.service.ts",
    ]);
  });
});

describe("the send paths and the DRAFT paths (SA-1124 PR-1b)", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const methodBody = (file: string, name: string) => {
    const text = read(file);
    const re = new RegExp(`^  (?:private\\s+)?(?:async\\s+)?${name}\\(`, "m");
    const m = re.exec(text);
    if (!m) throw new Error(`${name} not found in ${file}`);
    const next =
      /^ {2}(?:\/\*\*|(?:private\s+|public\s+)?(?:async\s+)?[A-Za-z_$][\w$]*\s*(?:<[^>\n]*>)?\()/gm;
    next.lastIndex = m.index + m[0].length;
    let end = text.length;
    for (let n = next.exec(text); n; n = next.exec(text)) {
      if (!KEYWORDS.has(n[0].trim().replace(/\W.*$/, ""))) {
        end = n.index;
        break;
      }
    }
    return strip(text.slice(m.index, end));
  };

  it("send() calls the guard beside assertOrderInvoiceUnlocked", () => {
    const body = methodBody("invoices/invoices.service.ts", "send");
    expect(body).toContain("assertOrderInvoiceUnlocked(");
    expect(body).toContain("assertOrderReviewed(");
  });

  it("sendEmail does not route through send(), so deliverEmail carries the same guard", () => {
    const body = methodBody("invoices/invoices.service.ts", "deliverEmail");
    expect(body).not.toMatch(/this\.send\(/);
    expect(body).toContain("assertOrderReviewed(");
  });

  it("the guard is called from exactly these places in invoices.service.ts: send, deliverEmail, recordPayment, standalone payment", () => {
    const text = strip(read("invoices/invoices.service.ts"));
    expect((text.match(/assertOrderReviewed\(/g) ?? []).length).toBe(4);
  });

  it("the deposit-mirror issuance steps ask the non-throwing predicate, never the throwing guard (G4)", () => {
    const text = strip(read("invoices/invoices.service.ts"));
    expect((text.match(/hasOpenReviewBlock\(/g) ?? []).length).toBe(2);
    for (const name of ["createInvoiceFromOrder", "createInvoiceFromOrderWithTenant"]) {
      const body = methodBody("invoices/invoices.service.ts", name);
      expect({ name, throws: /assertOrderReviewed\(/.test(body) }).toEqual({ name, throws: false });
      expect({ name, asks: /hasOpenReviewBlock\(/.test(body) }).toEqual({ name, asks: true });
    }
  });

  it("sendReminder carries the guard (driver cash can issue a flagged invoice) and pickup-complete judges it before any write", () => {
    expect(strip(read("invoices/invoice-reminder-email.ts"))).toMatch(/assertOrderReviewed\(/);
    const pc = strip(read("orders/counter-sale/pickup-complete.service.ts"));
    const guard = pc.indexOf("assertOrderReviewed(");
    expect(guard).toBeGreaterThan(0);
    // before the claim, the path switch and the hand-over
    for (const write of ["changeStatus(", "updateFulfillPath(", "recordPayment(", ".send("]) {
      expect({ write, after: pc.indexOf(write, pc.indexOf("async complete(")) > guard }).toEqual({
        write,
        after: true,
      });
    }
  });

  it("route completion's DRAFT invoice never reaches the guard (G3)", () => {
    expect(strip(read("invoices/delivered-reconcile.ts"))).not.toMatch(
      /assertOrderReviewed|order-review-gate/,
    );
    expect(strip(read("routes/routes.service.ts"))).not.toMatch(
      /assertOrderReviewed|order-review-gate/,
    );
  });

  it("the guard module is the only place that names the blocking kind for a refusal", () => {
    const gate = strip(read("orders/offline/order-review-gate.ts"));
    expect(gate).toContain("PRICE_CHANGED_OFFLINE");
    expect(gate).toContain("ORDER_REVIEW_REQUIRED");
  });
});
