/**
 * Lane form-guards (hunt-mobile-scan, design/discard-guards.json) —
 * `form-guard-callers.test.ts`
 *
 * Wave 1 landed `lib/discard-guard.ts` (the pure predicates, pinned by
 * `discard-guard.test.ts`) and changed `FormSheet.tsx`'s `handleCancel` to
 * route through `confirm()` when `confirmDiscardIfDirty` is true, keeping the
 * old `warnIfDirty` prop only as a deprecated alias. This suite pins the
 * CALLER side: every FormSheet caller this lane owns must (a) import the
 * matching predicate from `lib/discard-guard.ts`, (b) pass it as
 * `confirmDiscardIfDirty` with a REAL per-screen dirty expression (not a bare
 * `warnIfDirty` truthy prop, which prompts even on a pristine form), and
 * (c) never reference the deprecated `warnIfDirty` prop name anywhere in the
 * repo outside FormSheet.tsx's own definition.
 *
 * Source-text spec in the style of `edit-items-scan-price.test.ts`: nothing
 * renders under mobile Jest (`jest.config.js` — testEnvironment node, no
 * RTL), so this reads each screen as text and pins the wiring, never a
 * rendered tree. Paths resolve from `__dirname`, never `process.cwd()`.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const MOBILE_ROOT = join(__dirname, "..");

/**
 * Recursively lists every .ts/.tsx file under `dir`, skipping node_modules
 * and build output — a plain fs walk rather than `git grep`, so this suite
 * has no dependency on git being on PATH or on the process cwd, and cannot
 * pick up a concurrent, unrelated in-progress edit from another builder's
 * `git` index state in this shared worktree.
 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".expo" || entry === "dist" || entry === "__tests__")
      continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function readScreen(...segments: string[]): string {
  return readFileSync(join(MOBILE_ROOT, ...segments), "utf8");
}

const standingOrderSrc = readScreen(
  "app",
  "(operator)",
  "customers",
  "[id]",
  "standing-orders",
  "new.tsx",
);
const invoiceEditSrc = readScreen("app", "(operator)", "(tabs)", "invoices", "[id]", "edit.tsx");
const paymentRecordSrc = readScreen("app", "(operator)", "payments", "record.tsx");
const customerFormSrc = readScreen("components", "CustomerForm.tsx");
const receiveSrc = readScreen("app", "(operator)", "purchase-orders", "[id]", "receive.tsx");
const formSheetSrc = readScreen("components", "FormSheet.tsx");

// REG-FG-06: hoisted to module scope (mirrors apps/api/src/common/no-bare-cron.spec.ts) so the
// walk runs once and its result is fed to a sanity check — an fs walk that silently starts
// returning [] (a bad cwd, a renamed root) must fail loudly instead of letting the "no
// warnIfDirty hits" assertion pass vacuously over an empty file list.
const ALL_MOBILE_SOURCE_FILES = listSourceFiles(MOBILE_ROOT);

describe("standing-orders/new.tsx discard guard (REG-FG-01)", () => {
  it("REG-FG-01: imports hasUnsavedStandingOrder from lib/discard-guard", () => {
    expect(standingOrderSrc).toMatch(
      /import\s*\{\s*hasUnsavedStandingOrder\s*\}\s*from\s*"[^"]*lib\/discard-guard"/,
    );
  });

  it("REG-FG-01: passes confirmDiscardIfDirty computed from hasUnsavedStandingOrder({ name, lines })", () => {
    expect(standingOrderSrc).toMatch(
      /confirmDiscardIfDirty=\{hasUnsavedStandingOrder\(\{\s*name,\s*lines\s*\}\)\}/,
    );
  });

  it("REG-FG-01: onCancel still routes to router.back() (unchanged by the guard rename)", () => {
    // The design's own risk note: confirming the prop rename must never also
    // change what happens AFTER a confirmed discard.
    expect(standingOrderSrc).toMatch(/onCancel=\{\(\)\s*=>\s*router\.back\(\)\}/);
  });
});

describe("invoices/[id]/edit.tsx discard guard (REG-FG-02)", () => {
  it("REG-FG-02: imports hasUnsavedInvoiceLineEdits + InvoiceEditSnapshot from lib/discard-guard", () => {
    expect(invoiceEditSrc).toMatch(
      /import\s*\{[\s\S]*?hasUnsavedInvoiceLineEdits[\s\S]*?\}\s*from\s*"[^"]*lib\/discard-guard"/,
    );
    expect(invoiceEditSrc).toMatch(/type InvoiceEditSnapshot/);
  });

  it("REG-FG-02: takes a hydration snapshot into originalRef alongside hydratedFor", () => {
    expect(invoiceEditSrc).toMatch(
      /const originalRef = useRef<InvoiceEditSnapshot \| null>\(null\)/,
    );
    // The snapshot must be written INSIDE the same hydration effect that
    // seeds `lines`/header state, not derived on every render — otherwise
    // "dirty" would always compare the live form against itself.
    const hydrationEffect = (invoiceEditSrc.match(
      /useEffect\(\(\) => \{\s*if \(!invoice[\s\S]*?\n {2}\}, \[invoice\]\);/,
    ) ?? [""])[0];
    expect(hydrationEffect).toMatch(/originalRef\.current = \{/);
  });

  it("REG-FG-02: the hydration snapshot strips key/unitsPerBox/taxRate/promoFreeUnits/promoBaseUnits per line", () => {
    const hydrationEffect = (invoiceEditSrc.match(
      /useEffect\(\(\) => \{\s*if \(!invoice[\s\S]*?\n {2}\}, \[invoice\]\);/,
    ) ?? [""])[0];
    expect(hydrationEffect).toMatch(
      /hydratedLines\.map\(\s*\(\{\s*key,\s*unitsPerBox,\s*taxRate,\s*promoFreeUnits,\s*promoBaseUnits,\s*\.\.\.rest\s*\}\)\s*=>\s*rest,?\s*\)/,
    );
  });

  it("REG-FG-02: computes a dirty memo through hasUnsavedInvoiceLineEdits against originalRef.current", () => {
    expect(invoiceEditSrc).toMatch(
      /const dirty = useMemo\(\s*\(\)\s*=>\s*hasUnsavedInvoiceLineEdits\(/,
    );
    expect(invoiceEditSrc).toMatch(/originalRef\.current,\s*\),/);
  });

  it("REG-FG-02: FormSheet's confirmDiscardIfDirty is the dirty memo gated on !updateMut.isPending", () => {
    expect(invoiceEditSrc).toMatch(/confirmDiscardIfDirty=\{dirty && !updateMut\.isPending\}/);
  });
});

describe("payments/record.tsx discard guard (REG-FG-03)", () => {
  it("REG-FG-03: imports hasUnsavedPayment from lib/discard-guard", () => {
    expect(paymentRecordSrc).toMatch(
      /import\s*\{\s*hasUnsavedPayment\s*\}\s*from\s*"[^"]*lib\/discard-guard"/,
    );
  });

  it("REG-FG-03: passes confirmDiscardIfDirty computed from every losable field", () => {
    const propBlock = (paymentRecordSrc.match(
      /confirmDiscardIfDirty=\{hasUnsavedPayment\(\{[\s\S]*?\}\)\}/,
    ) ?? [""])[0];
    expect(propBlock).not.toBe("");
    for (const field of [
      "amount",
      "reference",
      "notes",
      "bankCharges",
      "paidAt",
      "settledAt",
      "photos",
      "asDraft",
    ]) {
      expect(propBlock).toMatch(new RegExp(`\\b${field}\\b`));
    }
  });
});

describe("CustomerForm.tsx discard guard (REG-FG-04)", () => {
  it("REG-FG-04: imports shouldConfirmDiscard from lib/discard-guard", () => {
    expect(customerFormSrc).toMatch(
      /import\s*\{\s*shouldConfirmDiscard\s*\}\s*from\s*"[^"]*lib\/discard-guard"/,
    );
  });

  it("REG-FG-04: passes confirmDiscardIfDirty={shouldConfirmDiscard(isDirty, !!submitting)}", () => {
    expect(customerFormSrc).toMatch(
      /confirmDiscardIfDirty=\{shouldConfirmDiscard\(isDirty, !!submitting\)\}/,
    );
  });

  it("REG-FG-04: the existing per-key isDirty derivation is untouched", () => {
    // The design's own risk note: this lane touches ONLY the FormSheet prop
    // line here, never the isDirty derivation itself.
    expect(customerFormSrc).toMatch(
      /const isDirty = React\.useMemo\(\(\) => \{\s*return \(Object\.keys\(form\)/,
    );
  });
});

describe("purchase-orders/[id]/receive.tsx discard guard (REG-FG-05)", () => {
  it("REG-FG-05: imports hasTouchedReceiveForm from lib/discard-guard", () => {
    expect(receiveSrc).toMatch(
      /import\s*\{\s*hasTouchedReceiveForm\s*\}\s*from\s*"[^"]*lib\/discard-guard"/,
    );
  });

  it("REG-FG-05: FormSheet now receives a confirmDiscardIfDirty prop at all", () => {
    // TODAY (pre-fix): the FormSheet opening tag has no warnIfDirty/
    // confirmDiscardIfDirty prop whatsoever — a typed delta or note is
    // dropped silently on Cancel with zero prompt.
    const formSheetOpen = (receiveSrc.match(/<FormSheet\b[\s\S]*?\n {4}>/) ?? [""])[0];
    expect(formSheetOpen).toMatch(
      /confirmDiscardIfDirty=\{hasTouchedReceiveForm\(\{\s*qtys,\s*boxQtys,\s*pieceQtys,\s*notes\s*\}\)\}/,
    );
  });
});

describe("form-guard-callers: repo-wide warnIfDirty retirement (REG-FG-06)", () => {
  it("REG-FG-06: walks a non-trivial number of source files (guards against an empty scan reporting green)", () => {
    // Without this, a walk that starts returning [] (bad cwd, renamed root,
    // an over-eager exclusion) would make the "zero hits" assertion below
    // pass vacuously — exactly the bug class this finding flagged.
    expect(ALL_MOBILE_SOURCE_FILES.length).toBeGreaterThan(100);
  });

  it("REG-FG-06: no caller outside FormSheet.tsx still references warnIfDirty", () => {
    // A whole-app fs walk, not a fixed file list, so a caller this lane
    // forgot (or a future new one) cannot slip through with the deprecated,
    // always-true-by-default prop name. Matches the risk note in
    // design/discard-guards.json ("a whole-repo grep for warnIfDirty after
    // the change should return zero hits outside FormSheet.tsx").
    const formSheetPath = join(MOBILE_ROOT, "components", "FormSheet.tsx");
    const hits = ALL_MOBILE_SOURCE_FILES.filter((file) => file !== formSheetPath)
      .filter((file) => readFileSync(file, "utf8").includes("warnIfDirty"))
      .map((file) => relative(MOBILE_ROOT, file));
    expect(hits).toEqual([]);
  });
});

describe("FormSheet.tsx handleCancel discard guard (REG-FG-07)", () => {
  it("REG-FG-07: imports shouldConfirmDiscard from lib/discard-guard", () => {
    expect(formSheetSrc).toMatch(
      /import\s*\{\s*shouldConfirmDiscard\s*\}\s*from\s*"[^"]*lib\/discard-guard"/,
    );
  });

  it("REG-FG-07: handleCancel gates the confirm() call on shouldConfirmDiscard(confirmDiscardIfDirty, submitting)", () => {
    // Non-empty-locator discipline (house rule): a regex over a string that
    // came back empty must never be allowed to pass by itself, so the match
    // is asserted before anything is checked against it.
    const handleCancelBlock = (formSheetSrc.match(
      /const handleCancel = \(\) => \{[\s\S]*?\n {2}\};/,
    ) ?? [""])[0];
    expect(handleCancelBlock).not.toBe("");
    expect(handleCancelBlock).toMatch(
      /if \(shouldConfirmDiscard\(!!confirmDiscardIfDirty, !!submitting\)\)/,
    );
    expect(handleCancelBlock).toMatch(/confirm\(\s*"Discard changes\?"/);
    expect(handleCancelBlock).toMatch(/"Your unsaved changes will be lost\."/);
    expect(handleCancelBlock).toMatch(/confirmText:\s*"Discard"/);
    expect(handleCancelBlock).toMatch(/destructive:\s*true/);
  });

  it("REG-FG-07: the deprecated warnIfDirty prop is gone from FormSheet.tsx itself", () => {
    // FormSheet.tsx is the one file REG-FG-06 above excludes from the
    // repo-wide "zero hits" scan, so its own retirement needs its own pin —
    // reverting finding #2 would otherwise slip through undetected.
    expect(formSheetSrc).not.toMatch(/warnIfDirty/);
  });
});
