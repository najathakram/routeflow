import * as fs from "fs";
import * as path from "path";

/**
 * Row 510, L-305: the mobile staff write flows are ENUMERATED BY SEARCH. Every non-test source that calls a staff write
 * hook of the plan's path inventory must be wired to the warning modal (`useRestrictionWarningRetry`: it sends
 * `rw.attach(...)`, routes its error through `rw.handle(...)` and renders `rw.modal`), or be on the EXEMPT list with a
 * reason. A flow that forgets the modal would swallow the 409 RESTRICTION_WARNING behind its generic "Couldn't save".
 */
const MOBILE = path.resolve(__dirname, "..");
const STAFF_WRITE_HOOKS = [
  "useCreateOrderAsDriver",
  "useCreateAdminOrder",
  "useCreateSale",
  "useUpdateOrderItems",
  "useChangeOrderStatus",
  "useReopenOrder",
  "useSwitchOrderToDelivery",
  "useCreateInvoice",
  "useUpdateInvoice",
  "useDuplicateInvoice",
  "useConvertEstimateToInvoice",
  "useRunRecurringInvoice",
  "useGenerateTemplateOrder",
];
const CALL = new RegExp(`\\b(${STAFF_WRITE_HOOKS.join("|")})\\b`);

/** file (relative to apps/mobile) -> why it needs no modal. */
const EXEMPT: Record<string, string> = {
  "lib/sale-mode.ts": "a comment names useCreateSale; the file calls no hook",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "__tests__" || e.name === ".expo") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(MOBILE, p).split(path.sep).join("/");
const read = (f: string) => fs.readFileSync(path.join(MOBILE, f), "utf8");
const callers = ["app", "components", "lib"]
  .flatMap((d) => walk(path.join(MOBILE, d)))
  .filter((p) => !rel(p).startsWith("lib/api/"))
  .filter((p) => CALL.test(fs.readFileSync(p, "utf8")))
  .map(rel);

/** The plan's mobile flow list (section F), by file. */
const PLAN_FLOWS = [
  "components/NewOrderScreen.tsx",
  "app/(operator)/(tabs)/orders/[id]/edit-items.tsx",
  "app/(operator)/(tabs)/orders/[id].tsx",
  "app/(operator)/(tabs)/invoices/new.tsx",
  "app/(operator)/(tabs)/invoices/[id]/edit.tsx",
  "app/(operator)/(tabs)/invoices/[id].tsx",
  "app/(operator)/estimates/[id].tsx",
  "app/(operator)/recurring-invoices/[id].tsx",
  "app/(operator)/order-templates/[id].tsx",
];

describe("row 510: every mobile staff write flow uses the warning hook (search-derived)", () => {
  it("finds every flow the plan lists (a vacuous list would prove nothing)", () => {
    expect(callers).toEqual(expect.arrayContaining(PLAN_FLOWS));
  });

  it.each(callers)("%s", (file) => {
    if (EXEMPT[file]) {
      expect(EXEMPT[file].length).toBeGreaterThan(10);
      return;
    }
    const src = read(file);
    expect(src).toContain("useRestrictionWarningRetry()");
    expect(src).toMatch(/rw\.attach\(/);
    expect(src).toMatch(/rw\.handle\(/);
    expect(src).toContain("{rw.modal}");
  });

  it("the invoice detail's Duplicate and inline edit, and the order detail's reopen, status and path switch, are wrapped", () => {
    const inv = read("app/(operator)/(tabs)/invoices/[id].tsx");
    expect(inv).toMatch(/duplicateMut\.mutate\(rw\.attach\(id\)/);
    expect(inv).toMatch(/updateMut\.mutate\(\s*rw\.attach\(/);
    const ord = read("app/(operator)/(tabs)/orders/[id].tsx");
    expect(ord).toMatch(/reopenMut\.mutate\(rw\.attach\(order\.id\)/);
    expect(ord).toMatch(/changeMut\.mutate\(\s*rw\.attach\(/);
    expect(ord).toMatch(/switchToDeliveryMut\.mutate\(rw\.attach\(order\.id\)/);
  });

  it("the driver path of New order still reaches the 'Ask the office' block through the same hook", () => {
    const src = read("components/NewOrderScreen.tsx");
    expect(src).toMatch(/useCreateOrderAsDriver\(\)/);
    expect(src).toMatch(/rw\.handle\(err, \(\) => submitOrder\(mergeChoice, asDraft\)\)/);
  });
});

describe("row 510: staff-only display", () => {
  it("the note is rendered on the staff order and invoice detail rows", () => {
    expect(read("app/(operator)/(tabs)/orders/[id].tsx")).toContain("<RestrictionOverrideNote");
    expect(read("app/(operator)/(tabs)/invoices/[id].tsx")).toContain("<RestrictionOverrideNote");
  });
  it("the note fetches nothing: no /users call (admin-only; an operator would get a false 'former user')", () => {
    for (const f of [
      "components/RestrictionOverrideNote.tsx",
      "lib/restriction-override-note.ts",
    ]) {
      expect(read(f)).not.toMatch(/\/users|apiClient|useQuery|api-client/);
    }
  });
  it("the name comes from the API's restrictionOverrideByName field", () => {
    expect(read("components/RestrictionOverrideNote.tsx")).toContain("restrictionOverrideByName");
  });
  it("no customer (buyer) screen or component mentions the note, the modal or an override column", () => {
    const customerFiles = [
      ...walk(path.join(MOBILE, "app/(customer)")),
      ...walk(path.join(MOBILE, "app/(auth)")),
    ];
    expect(customerFiles.length).toBeGreaterThan(0);
    for (const p of customerFiles) {
      expect(fs.readFileSync(p, "utf8")).not.toMatch(
        /RestrictionOverrideNote|RestrictionWarningModal|useRestrictionWarningRetry|restrictionOverride/,
      );
    }
  });
});

describe("row 510: POS 'Confirm & invoice' (the finish) carries the ack", () => {
  it("usePosFinish takes the ack in its variables and builds BOTH status bodies with posStatusBody", () => {
    const src = read("lib/api/pos-orders.ts");
    const at = src.indexOf("export function usePosFinish()");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("/** Release the hand-over's Idempotency-Key", at));
    expect(body).toMatch(/RestrictionAck/);
    expect(body).toMatch(/\.\.\.ack/);
    expect(body.match(/posStatusBody\(status, ack\)/g)).toHaveLength(1); // inside the status loop
    expect(body).not.toMatch(/\{ status \}\)/); // no bare { status } body left behind
  });

  it("the POS finish sends rw.attach(...) and routes the failed step's cause through rw.handle(...)", () => {
    const src = read("lib/use-pos-mode.ts");
    expect(src).toMatch(/rw\.attach\(/);
    expect(src).toMatch(/rw\.handle\(/);
    // PosFinishError wraps the axios error: the dialog must read the CAUSE
    expect(src).toMatch(/\.cause/);
  });

  it("New order hands its rw to the POS finish, so a confirm into a judged DRAFT opens the same modal", () => {
    const src = read("components/NewOrderScreen.tsx");
    const at = src.indexOf("pos.finishAndOpen(");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).toMatch(/\brw\b/);
  });
});

describe("row 510: the repeat-409 notice and the modal's small accessibility fixes", () => {
  it("the hook drops the kept reason and passes listChanged to the modal on a repeat (isRepeatWarning)", () => {
    const src = read("lib/use-restriction-warning-retry.tsx");
    expect(src).toMatch(/isRepeatWarning\(sentHashRef\.current, warning\.warningHash\)/);
    expect(src).toMatch(/if \(repeat \|\| !warning\) forgetReason\(\)/);
    expect(src).toMatch(/listChanged=\{listChanged\}/);
  });
  it("a repeat is keyed on the previous warningHash, never a clock: no timer, and a fresh send forgets the old hash", () => {
    const src = read("lib/use-restriction-warning-retry.tsx");
    expect(src).not.toMatch(/setTimeout|clearTimeout|REASON_KEPT_MS/);
    expect(src).toMatch(/sentHashRef\.current = ack\.warningHash/);
    // attach() with no pending ack = a fresh attempt, not our re-send
    expect(src).toMatch(/if \(!ack\) \{[^}]*sentHashRef\.current = null/s);
  });
  it("the modal shows it in a polite live region (role=status, aria-live=polite)", () => {
    const src = read("components/RestrictionWarningModal.tsx");
    expect(src).toMatch(/listChanged\s*\?/);
    expect(src).toMatch(/role="status"/);
    expect(src).toMatch(/aria-live="polite"/);
    expect(src).toContain("COPY.listChanged");
  });
  it("the reason input takes focus on open, and a disabled Sell anyway says so to assistive tech", () => {
    const src = read("components/RestrictionWarningModal.tsx");
    expect(src).toMatch(/<FormTextInput[^>]*\bautoFocus\b/s);
    expect(src).toMatch(/accessibilityState=\{\{ disabled: !check\.ok \}\}/);
  });
  it("the modal lists rule lines through lineRuleRows / driverBlockRows (identically worded rules show once), never the raw rule list", () => {
    const src = read("components/RestrictionWarningModal.tsx");
    expect(src).toMatch(/lineRuleRows\(l\.rules\)/);
    expect(src).toMatch(/driverBlockRows\(/);
    expect(src).not.toMatch(/l\.rules\.map/);
  });
  it("the blocked modal's title follows the server's message (a support session reads 'Ask the account admin')", () => {
    expect(read("components/RestrictionWarningModal.tsx")).toMatch(/blocked \? view\.message/);
  });
  it("the blocked modal's OK can resume the caller (the driver's at-stop batch continues behind it)", () => {
    const src = read("lib/use-restriction-warning-retry.tsx");
    expect(src).toMatch(/onDismiss/);
  });
});
