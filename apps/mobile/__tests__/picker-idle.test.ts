/**
 * F30 hunt (2026-09-14), lane "pickers" — `picker-idle.test.ts`
 *
 * design/lazy-catalog.json: the catalogue fetch on the three OTHER catalogue
 * surfaces (invoices/new.tsx's builder, recurring-invoices/new.tsx's
 * ProductPickerModal, and the shared ProductPickerSheet) is gated on a typed
 * term or a deliberate "Browse catalogue" tap instead of loading — or, for
 * ProductPickerSheet, fetching the WHOLE catalog via the `limit: 0`
 * fetch-all sentinel — at mount/open. Plus design/scan-guard.json edits 1-4
 * for invoices/new.tsx (its accept already clears the field, so edit 5 does
 * not apply) and the discard-confirm on the composer's own back button
 * (RULINGS.md R4, lib/discard-guard.ts#hasUnsavedInvoiceDraft).
 *
 * Source-text spec, comment-stripped, in the style of
 * `edit-items-scan-price.test.ts` / `product-picker-active.test.ts`: nothing
 * renders under mobile Jest (pure-logic env only), so this reads the three
 * owned files as text and pins substrings/ordering, never a rendered tree.
 * Paths resolve from `__dirname`, never `process.cwd()`.
 */
import { readFileSync } from "fs";
import { join } from "path";

const MOBILE_ROOT = join(__dirname, "..");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function readSource(relPath: string): string {
  return stripComments(readFileSync(join(MOBILE_ROOT, relPath), "utf8"));
}

const pickerSheetSrc = readSource("components/ProductPickerSheet.tsx");
const recurringSrc = readSource("app/(operator)/recurring-invoices/new.tsx");
const invoiceSrc = readSource("app/(operator)/(tabs)/invoices/new.tsx");

describe("ProductPickerSheet — gated fetch replaces the limit:0 fetch-all (REG-picker-idle-A)", () => {
  it("REG-picker-idle-A: no longer requests the fetch-all sentinel", () => {
    // TODAY (pre-fix): `useAdminProducts({ ..., limit: 0 })` — the server
    // clamps `limit: 0` to a 10,000-row fetch-all, one presigned thumbnail
    // URL per row.
    expect(pickerSheetSrc).not.toMatch(/limit:\s*0\b/);
  });

  it("REG-picker-idle-A: uses the debounced, gated useAdminProductSearch hook", () => {
    // TODAY: imports/calls `useAdminProducts` directly with no `enabled`.
    expect(pickerSheetSrc).toMatch(/useAdminProductSearch<AdminProduct>\(/);
    const callMatch = pickerSheetSrc.match(/useAdminProductSearch<AdminProduct>\(\{[\s\S]*?\}\)/);
    const callBlock = callMatch ? callMatch[0] : "";
    expect(callBlock).toMatch(/enabled:\s*visible/);
    // B142 pin must survive the refactor byte-identical (product-picker-active.test.ts
    // reads this same expression out of the query block).
    expect(callBlock).toMatch(/isActive:\s*activeOnly\s*\?\s*true\s*:\s*undefined/);
  });

  it("REG-picker-idle-A: the sheet gains near-bottom paging", () => {
    // TODAY: the ScrollView has no onScroll/paging at all — the fetch-all made it moot.
    expect(pickerSheetSrc).toMatch(/hasNextPage/);
    expect(pickerSheetSrc).toMatch(/fetchNextPage\(\)/);
    expect(pickerSheetSrc).toMatch(/isFetchingNextPage/);
  });
});

describe("ProductPickerSheet — idle state tells the operator what to do (REG-picker-idle-B)", () => {
  it("REG-picker-idle-B: carries the idle copy and the deliberate way in", () => {
    // TODAY: no idle branch exists at all — isLoading falls straight to the
    // "No matches."/"No products yet." branch.
    expect(pickerSheetSrc).toMatch(/Scan or search to find a product\./);
    expect(pickerSheetSrc).toMatch(/Browse catalogue/);
  });

  it('REG-picker-idle-B: the lying "No products yet." idle copy is gone', () => {
    // TODAY: `{search ? "No matches." : "No products yet."}` — under a gate
    // this is shown to a tenant with a full catalogue, which is a lie.
    expect(pickerSheetSrc).not.toMatch(/No products yet\./);
    expect(pickerSheetSrc).toMatch(/No matches\./);
  });

  it("REG-picker-idle-B: the idle branch is reachable BEFORE the no-matches branch", () => {
    // Ordering guard: idle must never be shadowed by the no-matches text.
    const idleAt = pickerSheetSrc.indexOf("Scan or search to find a product.");
    const noMatchAt = pickerSheetSrc.indexOf("No matches.");
    expect(idleAt).toBeGreaterThan(-1);
    expect(noMatchAt).toBeGreaterThan(-1);
    expect(idleAt).toBeLessThan(noMatchAt);
  });
});

describe("ProductPickerSheet — scanned-variant parent resolution survives the gate (REG-picker-idle-C)", () => {
  it("REG-picker-idle-C: resolves a scanned variant's parent via a direct fetch, not the page rows", () => {
    // TODAY: `products.find((p) => p.id === hit.parentProductId)` — a lookup
    // into page rows that are now empty until the operator acts, so a
    // scanned variant would always report "No product for ...".
    expect(pickerSheetSrc).not.toMatch(/products\.find\(\(p\) => p\.id === hit\.parentProductId\)/);
    expect(pickerSheetSrc).toMatch(
      /apiClient\.get<AdminProduct>\(\s*`\/products\/\$\{hit\.parentProductId\}`/,
    );
  });
});

describe("recurring-invoices/new.tsx ProductPickerModal — gated + idle (REG-picker-idle-D)", () => {
  it("REG-picker-idle-D: the picker's useProductSearch call carries browsing", () => {
    // TODAY: `useProductSearch<{ id: string }>({ enabled: open })` — no browsing.
    const callMatch = recurringSrc.match(/useProductSearch<\{ id: string \}>\(\{[\s\S]*?\}\)/);
    const callBlock = callMatch ? callMatch[0] : "";
    expect(callBlock).toMatch(/enabled:\s*open/);
    expect(callBlock).toMatch(/\bbrowsing\b/);
  });

  it("REG-picker-idle-D: browse resets when the modal closes", () => {
    // TODAY: no such effect exists — the modal is mounted for the screen's
    // whole life (unconditionally), so without a reset a browse from one
    // open would leak into the next.
    expect(recurringSrc).toMatch(/if \(!open\) setBrowsing\(false\)/);
  });

  it("REG-picker-idle-D: idle copy and Browse tap exist and precede the row list", () => {
    // TODAY: only an isLoading branch exists; it falls straight to
    // `products.map`, rendering raw page-1 rows before any term is typed.
    expect(recurringSrc).toMatch(/Search for a product, or browse the catalogue\./);
    const idleAt = recurringSrc.indexOf("Search for a product, or browse the catalogue.");
    const rowsAt = recurringSrc.indexOf("products.map((p)");
    expect(idleAt).toBeGreaterThan(-1);
    expect(rowsAt).toBeGreaterThan(-1);
    expect(idleAt).toBeLessThan(rowsAt);
  });
});

describe("invoices/new.tsx builder — lazy catalog wiring (REG-picker-idle-E)", () => {
  it("REG-picker-idle-E: useProductSearch is called with browsing", () => {
    // TODAY: `useProductSearch<Product>({ category })` — no browsing, so the
    // builder always preloaded page 1 at screen mount.
    const callMatch = invoiceSrc.match(/useProductSearch<Product>\(\{[\s\S]*?\}\)/);
    const callBlock = callMatch ? callMatch[0] : "";
    expect(callBlock).toMatch(/\bcategory\b/);
    expect(callBlock).toMatch(/\bbrowsing\b/);
  });

  it("REG-picker-idle-E: browsing is declared BEFORE the hook call (no TDZ)", () => {
    // TODAY: `const [browsing, setBrowsing] = useState(false);` sits ~270
    // lines BELOW the useProductSearch call it now needs to feed — reading it
    // there is a TDZ ReferenceError, not a type error, in some builds.
    const declAt = invoiceSrc.indexOf("const [browsing, setBrowsing] = useState(false)");
    const callAt = invoiceSrc.indexOf("useProductSearch<Product>(");
    expect(declAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(-1);
    expect(declAt).toBeLessThan(callAt);
  });

  it("REG-picker-idle-E: the scan ladder's local rows come from productById, not the raw page", () => {
    // TODAY: `makeScanHandler<Product>({ products, ... })` reads the raw
    // paged array — with page 1 no longer preloaded, a re-scan of a line
    // already on the invoice would miss the local fast path.
    expect(invoiceSrc).toMatch(/products:\s*\(\)\s*=>\s*Array\.from\(productById\.values\(\)\)/);
  });
});

describe("invoices/new.tsx builder — scan-accept guard, edits 1-4 (REG-picker-idle-F)", () => {
  it("REG-picker-idle-F: imports and wires createScanAcceptGuard", () => {
    // TODAY: no import of scan-accept-guard at all.
    expect(invoiceSrc).toMatch(/from ["'][./]*lib\/scan-accept-guard["']/);
    expect(invoiceSrc).toMatch(/const scanGuardRef = useRef\(createScanAcceptGuard<Product>\(\)\)/);
  });

  it("REG-picker-idle-F: the ladder's deps carry the guard", () => {
    // TODAY: `makeScanHandler<Product>({ ... })` has no acceptGuard field, so
    // the camera path and the settled-search effect can each independently
    // add the same physical scan (F30 open interleaving A).
    const ladderMatch = invoiceSrc.match(/makeScanHandler<Product>\(\{[\s\S]*?\n  \}\);/);
    const ladderBlock = ladderMatch ? ladderMatch[0] : "";
    expect(ladderBlock).toMatch(/acceptGuard:\s*scanGuardRef\.current/);
  });

  it("REG-picker-idle-F: the settled effect offers its match to the guard before accepting", () => {
    // TODAY: the effect calls `acceptScannedProduct` unconditionally once
    // shouldAutoAdd passes — no cross-mechanism check with the camera path.
    expect(invoiceSrc).toMatch(/if \(!scanGuardRef\.current\.offer\(code, match, kind\)\) return;/);
  });

  it("REG-picker-idle-F: handleSearchSubmit reads the CURRENT term ref, never the render-scope searchTerm", () => {
    // TODAY: `const handleSearchSubmit = () => wedgeSubmitRef.current(searchTerm);`
    // — a submit dispatched against a stale render can resubmit a code the
    // effect just accepted (F30 open interleaving C).
    expect(invoiceSrc).toMatch(
      /const handleSearchSubmit = \(\) => wedgeSubmitRef\.current\(searchTermRef\.current\);/,
    );
    expect(invoiceSrc).not.toMatch(/wedgeSubmitRef\.current\(searchTerm\)/);
  });

  it("REG-picker-idle-F: the REG-B201 nonce survives and no time window was reintroduced", () => {
    // The fix must not "simplify" the existing per-attempt nonce away, and
    // must not add a code/time-window guard alongside the new claim (that
    // would silently swallow a deliberate re-scan of the same item).
    expect(invoiceSrc).toMatch(/createScanAttempt\(\)/);
    expect(invoiceSrc).toMatch(/shouldAutoAdd\(/);
    expect(invoiceSrc).not.toMatch(/lastAutoAdd|Date\.now\(\)\s*-\s*\w+\s*<\s*\d{3,}/);
  });
});

describe("invoices/new.tsx composer — discard confirm on the composer's own back button (REG-picker-idle-G)", () => {
  it("REG-picker-idle-G: hasUnsavedInvoiceDraft is imported and read from items/unlisted", () => {
    // TODAY: no import of discard-guard, and the NavBackButton calls the raw
    // `onBack` with no confirm — an operator who has scanned lines onto an
    // in-progress invoice can back out and lose them with one tap.
    expect(invoiceSrc).toMatch(/from ["'][./]*lib\/discard-guard["']/);
    expect(invoiceSrc).toMatch(/hasUnsavedInvoiceDraft\(\{\s*items,\s*unlisted\s*\}\)/);
  });

  it("REG-picker-idle-G: a dirty composer confirms before leaving", () => {
    expect(invoiceSrc).toMatch(/confirm\(\s*"Discard invoice\?"/);
    // The composer's own NavBackButton must route through the guarded
    // handler, not the raw onBack prop.
    const composerMarker = invoiceSrc.indexOf("function InvoiceComposer");
    const composerSrc = invoiceSrc.slice(composerMarker);
    expect(composerSrc).toMatch(/<NavBackButton label="Back" onPress=\{handleBack\} \/>/);
  });

  it("REG-picker-idle-G: the preceding CustomerPicker stage stays unguarded (nothing to lose yet)", () => {
    // RULINGS.md / CORRECTIONS.md-adjacent finding narrowing: the customer
    // picker renders before items/unlisted can hold anything, so guarding it
    // would be a prompt with nothing behind it.
    const composerMarker = invoiceSrc.indexOf("function InvoiceComposer");
    const customerPickerSrc = invoiceSrc.slice(0, composerMarker);
    expect(customerPickerSrc).toMatch(/<NavBackButton label="Back" onPress=\{onBack\} \/>/);
    expect(customerPickerSrc).not.toMatch(/handleBack/);
  });
});
