/**
 * Source-text pins for the order-item editor's four owner fixes (2026-09-14):
 * the lazy catalogue's idle state, the reachable price affordance, the picker's
 * pull-out drawer, and the staged-edit autosave.
 *
 * Nothing renders under mobile Jest (`jest.config.js` — `testEnvironment:
 * "node"`), so this reads `edit-items.tsx` as text in the style of
 * `edit-items-scan-price.test.ts` and pins the WIRING. The behaviour these
 * pins sit on top of is unit-tested in `edit-items-draft.test.ts`.
 */
import { readFileSync } from "fs";
import { join } from "path";

const SCREEN_PATH = join(
  __dirname,
  "..",
  "app",
  "(operator)",
  "(tabs)",
  "orders",
  "[id]",
  "edit-items.tsx",
);
const MODULE_PATH = join(__dirname, "..", "lib", "edit-items-draft.ts");
const source = readFileSync(SCREEN_PATH, "utf8");
const moduleSource = readFileSync(MODULE_PATH, "utf8");

/** A source-text assertion must never be satisfied (or defeated) by prose. */
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// Same split as edit-items-scan-price.test.ts: `ProductPicker` owns the whole
// scan-add surface, so a picker-branch assertion can never be satisfied by the
// line branch (or the reverse).
const splitIndex = source.indexOf("function ProductPicker");
const parentSrc = source.slice(0, splitIndex === -1 ? source.length : splitIndex);
const pickerSrc = source.slice(splitIndex);
const pickerMount = (parentSrc.match(/<ProductPicker\b[\s\S]*?\n\s*\/>/) ?? [""])[0];

describe("edit-items.tsx last-added strip reachability (REG-EDIT-STRIP)", () => {
  // RULINGS R5 / CORRECTIONS C1: `lastScannedId` is set by EVERY add-and-stay
  // path, including a hardware wedge and a typed code + Enter, neither of which
  // touches `scanOpen`. Gating the strip on `scanOpen` is what made the price
  // affordance unreachable after those adds.
  const stripStart = pickerSrc.indexOf("{lastAdded && !trayExpanded ? (");
  const strip =
    stripStart === -1
      ? ""
      : pickerSrc.slice(stripStart, pickerSrc.indexOf("canEditPrice && pickerPriceEditItem"));

  it("REG-EDIT-STRIP: the last-added strip no longer depends on scanOpen", () => {
    expect(stripStart).toBeGreaterThan(-1);
    const guard = (pickerSrc.match(/\{\s*lastAdded\s*&&\s*!trayExpanded\s*\?/) ?? [""])[0];
    expect(guard).toMatch(/\{\s*lastAdded\s*&&\s*!trayExpanded\s*\?/);
    expect(guard).not.toContain("scanOpen");
    // Fixture sanity: the slice really is the strip, not an empty string.
    expect(strip).toContain("styles.pickerLastAdded");
  });

  it("REG-EDIT-STRIP: the camera closing no longer wipes the last-added line", () => {
    // The clears on picker close / row tap / scan-session START stay (they are
    // what REG-B263-F pins); only the session-END clear goes.
    const endHandler = (pickerMount.match(/onScanSessionEnd=\{[^\n]*\}/) ?? [""])[0];
    expect(endHandler).toMatch(/onScanSessionEnd=\{/);
    expect(endHandler).not.toContain("setLastScannedId");
    expect(pickerMount).toMatch(/onScanSessionStart=\{[^\n]*setLastScannedId\(null\)/);
  });
});

describe("edit-items.tsx picker drawer (REG-EDIT-DRAWER)", () => {
  it("REG-EDIT-DRAWER: the drawer mounts inside ProductPicker, after the camera, and renders ScanTray", () => {
    const scannerAt = pickerSrc.indexOf("<BarcodeScanner");
    const trayAt = pickerSrc.indexOf("<ScanTray");
    expect(scannerAt).toBeGreaterThan(-1);
    expect(trayAt).toBeGreaterThan(scannerAt);
    expect(pickerSrc).toContain("styles.pickerTray");
    expect(pickerSrc).toMatch(
      /height:\s*trayExpanded\s*\?\s*pickerTrayExpandedHeight\([\s\S]*?:\s*PICKER_TRAY_HANDLE_HEIGHT/,
    );
  });

  it("REG-EDIT-DRAWER: the handle both taps and drags", () => {
    const handleAt = pickerSrc.indexOf("style={styles.pickerTrayHandle}");
    expect(handleAt).toBeGreaterThan(-1);
    const handle = pickerSrc.slice(handleAt, pickerSrc.indexOf("pickerTrayGrabber"));
    expect(handle).toMatch(/onPress=\{\(\) => setTrayExpanded\(\(v\) => !v\)\}/);
    expect(handle).toMatch(/panHandlers/);
    expect(pickerSrc).toMatch(/PanResponder\.create\(/);
    expect(pickerSrc).toMatch(/onStartShouldSetPanResponder:\s*\(\)\s*=>\s*false/);
  });

  it("REG-EDIT-DRAWER: the drawer's rows and total come from the screen's single money derivations", () => {
    expect(pickerMount).toMatch(/trayRows=\{trayRows\}/);
    expect(pickerMount).toMatch(/trayTotal=\{total\}/);
    expect(pickerMount).toMatch(/trayItemCount=\{itemCount\}/);
    expect(parentSrc).toMatch(/useMemo\(\s*\(\) => draftTrayRows\(/);
    // MONEY: the picker half derives no subtotal of its own.
    expect(pickerSrc).not.toContain("computeLineSubtotal");
  });

  it("REG-EDIT-DRAWER: the last product row clears the collapsed handle", () => {
    expect(pickerSrc).toMatch(/paddingBottom:\s*24\s*\+\s*PICKER_TRAY_HANDLE_HEIGHT/);
  });
});

describe("edit-items.tsx lazy catalogue idle state (REG-EDIT-IDLE)", () => {
  it("REG-EDIT-IDLE: the picker's search is gated and destructures idle", () => {
    expect(pickerSrc).toMatch(/useProductSearch<\{ id: string \}>\(\{\s*browsing\s*\}\)/);
    expect(pickerSrc).toMatch(/\n\s*idle,\n/);
    expect(pickerSrc).toMatch(/const \[browsing, setBrowsing\] = useState\(false\)/);
  });

  it("REG-EDIT-IDLE: idle renders its own copy and a Browse tap, never 'No products match.'", () => {
    const idleBranch = (pickerSrc.match(/\) : idle \? \([\s\S]*?\) : products\.length === 0/) ?? [
      "",
    ])[0];
    expect(idleBranch).toContain("Scan or search to add items.");
    expect(idleBranch).toContain("Browse catalogue");
    expect(idleBranch).toMatch(/setBrowsing\(true\)/);
    expect(idleBranch).not.toContain("No products match.");
    // The idle branch sits BEFORE the empty branch, so "no match" is only
    // reachable once the operator has actually asked for something.
    expect(pickerSrc.indexOf(") : idle ? (")).toBeLessThan(pickerSrc.indexOf("No products match."));
  });
});

describe("edit-items.tsx per-line price gate (REG-EDIT-PRICE-GATE)", () => {
  it("REG-EDIT-PRICE-GATE: the SPECIAL-tier lock mirrors the create surface", () => {
    expect(parentSrc).toContain(
      "const isSpecialFor = (productId: string) => effectiveTierFor(productId) !== 1;",
    );
    expect(parentSrc).toContain(
      "const effectiveTierFor = (productId: string) => cpMap.get(productId) ?? customerTier ?? 1;",
    );
  });

  it("REG-EDIT-PRICE-GATE: the order gate is web's edit window, not 'any status but CANCELLED'", () => {
    expect(parentSrc).toMatch(
      /const orderPriceEditable =[\s\S]*?order\.editWindow\?\.editable \?\?[\s\S]*?"DRAFT"[\s\S]*?"PENDING"[\s\S]*?"CONFIRMED"/,
    );
    expect(source).not.toContain('order.status !== "CANCELLED"');
  });

  it("REG-EDIT-PRICE-GATE: both price surfaces gate on the LINE, through one helper", () => {
    expect(parentSrc).toMatch(
      /const canEditPriceFor = \(productId: string\) =>\s*orderPriceEditable && pricingReady && !isSpecialFor\(productId\)/,
    );
    expect(parentSrc).toMatch(/canEditPrice=\{canEditPriceFor\(it\.productId\)\}/);
    expect(pickerMount).toMatch(
      /canEditPrice=\{lastAddedLine \? canEditPriceFor\(lastAddedLine\.productId\) : false\}/,
    );
  });
});

describe("edit-items.tsx staged-edit autosave (REG-EDIT-AUTOSAVE)", () => {
  it("REG-EDIT-AUTOSAVE: leaving the screen flushes the snapshot on every exit path", () => {
    // Both NavBackButton handlers route through the flush; no bare back remains.
    expect(source).not.toMatch(/onPress=\{\(\) => router\.back\(\)\}/);
    expect(parentSrc).toMatch(/onPress=\{handleBackWithSnapshot\}/);
    expect(parentSrc).toMatch(/void flushSnapshot\(\);\s*\n\s*router\.back\(\);/);
    // The NewOrderScreen shape: beforeRemove (Android back + iOS swipe) and
    // the web visibilitychange branch, plus stock-count's AppState flush.
    expect(parentSrc).toMatch(/addListener\("beforeRemove"/);
    expect(parentSrc).toMatch(
      /AppState\.addEventListener\("change",[\s\S]*?state !== "active"[\s\S]*?flushSnapshot\(\)/,
    );
    expect(parentSrc).toMatch(/addEventListener\("visibilitychange"/);
  });

  it("REG-EDIT-AUTOSAVE: the restore effect is declared AFTER the hydration effect", () => {
    // React runs effects in declaration order, so this ordering is the whole
    // reason a restored edit survives the hydration effect's unconditional
    // re-`setDraft` on every order identity change.
    const hydrateAt = parentSrc.indexOf("hydrateFromOrder(order)");
    const restoreAt = parentSrc.indexOf('setRestoreState("applied")');
    expect(hydrateAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeGreaterThan(hydrateAt);
    // One-shot: the apply is guarded on restoreState.
    expect(parentSrc).toMatch(/if \(!order \|\| !restored \|\| restoreState !== "idle"\) return;/);
    expect(parentSrc).toMatch(/if \(isSnapshotStale\(restored, baselineOrder\)\)/);
  });

  it("REG-EDIT-AUTOSAVE: a saved edit is never offered for restore again", () => {
    const onSuccess = (parentSrc.match(/onSuccess: \(\) => \{[\s\S]*?\},/) ?? [""])[0];
    expect(onSuccess).toMatch(/clearSnapshot\(\)/);
  });

  it("REG-EDIT-AUTOSAVE: the screen owns all storage I/O and the module stays pure", () => {
    expect(parentSrc).toMatch(/AsyncStorage\.(getItem|setItem|removeItem)\(/);
    const moduleCode = stripComments(moduleSource);
    expect(moduleCode).not.toMatch(/from "react-native"/);
    expect(moduleCode).not.toMatch(/async-storage/);
  });
});

/**
 * FINDING 1 (money) — the `[order]` hydration effect was unconditional, so any
 * background refetch overwrote the staged edit; the one-shot restore effect
 * could not put it back, and the autosave effect then took its `removeItem`
 * branch and destroyed the on-disk copy too. The rule is unit-tested in
 * `edit-items-draft.test.ts` (REG-EDIT-REHYDRATE); this pins the WIRING.
 */
describe("edit-items.tsx hydration guard (REG-EDIT-REHYDRATE)", () => {
  const parentCode = stripComments(parentSrc);
  const hydrateAt = parentCode.indexOf("hydrateFromOrder(order)");
  const effectStart = hydrateAt === -1 ? -1 : parentCode.lastIndexOf("useEffect(", hydrateAt);
  const hydrationEffect = effectStart === -1 ? "" : parentCode.slice(effectStart, hydrateAt);

  it("REG-EDIT-REHYDRATE: the hydration effect opens with the guard, before any setDraft", () => {
    // Locator sanity FIRST — a regex over an empty slice passes vacuously.
    expect(hydrateAt).toBeGreaterThan(-1);
    expect(effectStart).toBeGreaterThan(-1);
    expect(hydrationEffect).toContain("if (!order) return;");

    expect(hydrationEffect).toContain("shouldRehydrateFromOrder({");
    expect(hydrationEffect).toMatch(/hydrated:\s*hydratedOrderRef\.current === orderKey/);
    expect(hydrationEffect).toMatch(/dirty:\s*dirtyRef\.current/);
    expect(hydrationEffect).toMatch(/justSaved:\s*savedRef\.current/);
    // The predicate really is imported from the pure module, not re-inlined.
    expect(parentCode).toContain("  shouldRehydrateFromOrder,");
  });

  it("REG-EDIT-REHYDRATE: dirtyRef mirrors the dirty predicate on every render", () => {
    const dirtyAt = parentCode.indexOf("const dirty = useMemo(");
    expect(dirtyAt).toBeGreaterThan(-1);
    // Assigned during render (not inside an effect), so the effect that runs
    // after this render reads this render's answer.
    expect(parentCode.slice(dirtyAt, dirtyAt + 220)).toMatch(
      /hasUnsavedWork\(staged, originals\)[\s\S]*?dirtyRef\.current = dirty;/,
    );
    expect(parentCode).toMatch(/const dirtyRef = useRef\(false\);/);
    expect(parentCode).toMatch(/const hydratedOrderRef = useRef<string \| null>\(null\);/);
  });
});

/**
 * The shared SearchBar grew an `autoFocus` prop for the wedge-scan fix but no
 * caller passed it, so a hardware wedge scanner still typed into a focus-less
 * screen and the first scan was dropped.
 */
describe("edit-items.tsx picker wedge focus (REG-EDIT-WEDGE-FOCUS)", () => {
  const sbAt = pickerSrc.indexOf("<SearchBar");
  const searchBar =
    sbAt === -1 ? "" : pickerSrc.slice(sbAt, pickerSrc.indexOf("<ScrollView", sbAt));

  it("REG-EDIT-WEDGE-FOCUS: the picker's SearchBar autofocuses, gated to the add-and-stay surface", () => {
    // Locator sanity FIRST.
    expect(sbAt).toBeGreaterThan(-1);
    expect(searchBar).toContain("Scan or search products");

    expect(stripComments(searchBar)).toMatch(/autoFocus=\{!!onPickAndStay && !initialScanOpen\}/);
  });

  it("REG-EDIT-WEDGE-FOCUS: the picker's search box is the ONLY SearchBar on this screen", () => {
    // The gate above is meaningless if a second (substitute / customer-select)
    // SearchBar ever appears and quietly inherits an autoFocus.
    expect((stripComments(source).match(/<SearchBar\b/g) ?? []).length).toBe(1);
    expect(stripComments(parentSrc)).not.toContain("<SearchBar");
  });
});

describe("edit-items.tsx scan-accept guard on the picker (REG-EDIT-SCAN-GUARD)", () => {
  it("REG-EDIT-SCAN-GUARD: the ladder and the settled effect share one claim", () => {
    expect(pickerSrc).toMatch(/createScanAcceptGuard</);
    expect(pickerSrc).toMatch(/acceptGuard: scanGuardRef\.current,/);
    // Consume the attempt FIRST, then offer — a parked attempt must not
    // re-park on a later settle.
    expect(pickerSrc).toMatch(
      /shouldAutoAdd\(code\)\) return;[\s\S]*?if \(!scanGuardRef\.current\.offer\(code, match, kind\)\) return;/,
    );
  });

  it("REG-EDIT-SCAN-GUARD: every scan-path clear goes through the synchronous clearSearch", () => {
    expect(pickerSrc).toMatch(/const clearSearch = \(\) => \{\s*searchTermRef\.current = "";/);
    expect(pickerSrc).toMatch(/return wedgeSubmitRef\.current\(searchTermRef\.current\);/);
    // No scan path may call the async setter directly any more: the ONLY
    // `setSearch("")` left in the picker is the one inside `clearSearch`.
    const pickerCode = stripComments(pickerSrc);
    expect((pickerCode.match(/setSearch\(""\)/g) ?? []).length).toBe(1);
    expect(pickerCode).toMatch(/searchTermRef\.current = "";\s*\n\s*setSearch\(""\);/);
  });

  it("REG-EDIT-SCAN-GUARD: an add-and-stay drops a stale scan code but keeps a typed name", () => {
    expect(pickerSrc).toMatch(
      /if \(looksLikeScanCode\(searchTermRef\.current\)\) clearSearch\(\);/,
    );
  });
});

describe("edit-items.tsx B246 scan FAB survives (PIN-B246, unchanged)", () => {
  it("PIN-B246: pickerScanIntent is still armed and still reset", () => {
    // CORRECTIONS C1: `setPickerScanIntent` is NOT dead — the FAB arms it and
    // two paths reset it. Deleting it as "dead state" removes B246's entry
    // point, so pin that it is still written from more than one place.
    expect((source.match(/setPickerScanIntent\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(parentSrc).toMatch(/setPickerScanIntent\(true\)/);
    expect(pickerMount).toMatch(/initialScanOpen=\{pickerScanIntent\}/);
  });
});
