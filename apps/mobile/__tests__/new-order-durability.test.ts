/**
 * REG-NEWORDER — source pins for the create surface (hunt 2026-09-14).
 *
 * Mobile Jest is pure-logic only (testEnvironment "node", no React renderer),
 * so JSX wiring is pinned as comment-stripped source text, in the style of
 * `edit-items-scan-price.test.ts` and `product-picker-active.test.ts`.
 *
 * What these stop from coming back, one describe each:
 *  - the scan accept guard (one input event, one add; Enter reads the CURRENT
 *    term, not the one captured in a stale render closure);
 *  - the stale miss pill that outlived the next successful scan;
 *  - the $0 unlisted line that was shown, counted, and then dropped from the
 *    POST;
 *  - a draft write that failed silently at every layer, with no background
 *    flush at all on the shipping platform;
 *  - the at-door cart that had no durability of any kind because the run/stop
 *    row was wrongly believed to hold it;
 *  - the price affordance the scan tray never had, and the SPECIAL-tier lock
 *    it has to honour;
 *  - the catalogue fetch that fired at screen mount even though the screen
 *    renders quiet.
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

const screen = readSource("components/NewOrderScreen.tsx");
const sheet = readSource("components/ScanOrderSheet.tsx");

describe("NewOrderScreen scan accept guard (REG-NEWORDER-GUARD)", () => {
  it("REG-NEWORDER-GUARD-A: the screen shares the one guard module with the ladder", () => {
    expect(screen).toMatch(/from\s+["']\.\.\/lib\/scan-accept-guard["']/);
    expect(screen).toMatch(/useRef\(createScanAcceptGuard<Product>\(\)\)/);
    expect(screen).toMatch(/acceptGuard:\s*scanGuardRef\.current,/);
  });

  it("REG-NEWORDER-GUARD-B: the settled-search effect offers its match to the open claim", () => {
    // Order matters: the REG-B201 nonce is consumed FIRST so a parked attempt
    // cannot re-park on a later settle of the same attempt.
    expect(screen).toMatch(
      /shouldAutoAdd\(code\)\)\s*return;[\s\S]{0,400}?if\s*\(!scanGuardRef\.current\.offer\(code,\s*match,\s*level\)\)\s*return;/,
    );
    // The nonce itself must survive — a guard is not a reason to "simplify" it
    // away, and neither may a time window come back in its place.
    expect(screen).toMatch(/createScanAttempt\(\)/);
    expect(screen).not.toMatch(/lastAutoAdd/);
  });

  it("REG-NEWORDER-GUARD-C: Enter reads the CURRENT term ref, never the captured one", () => {
    expect(screen).toMatch(
      /handleSearchSubmit\s*=\s*\(\)\s*=>\s*wedgeSubmitRef\.current\(searchTermRef\.current\)/,
    );
    expect(screen).not.toMatch(/wedgeSubmitRef\.current\(searchTerm\)/);
    // clearSearch empties the ref synchronously with the field, and every
    // scan-path clear goes through it.
    expect(screen).toMatch(/const clearSearch = \(\) => \{\s*searchTermRef\.current = "";/);
    expect(screen).not.toMatch(/clearSearch:\s*\(\)\s*=>\s*setSearch\(""\)/);
  });
});

describe("ScanOrderSheet feedback pill (REG-NEWORDER-PILL)", () => {
  it("REG-NEWORDER-PILL-A: the sheet drives the pill through the shared state machine", () => {
    expect(sheet).toMatch(/from\s+["']\.\.\/lib\/scan-feedback-slot["']/);
    expect(sheet).toMatch(/reduceScanSlot\(prev,\s*\{\s*type:\s*"outcome",\s*outcome\s*\}\)/);
  });

  it("REG-NEWORDER-PILL-B: the write-only-on-error path is gone", () => {
    // Pre-fix: `showError` was the only writer and the success branch returned
    // without touching `error`, so a miss outlived the next add.
    expect(sheet).not.toMatch(/showError\s*\(/);
    expect(sheet).not.toMatch(/const\s+\[error,\s*setError\]/);
    // The pill's own lifetimes now live in the pure module.
    expect(sheet).not.toMatch(/const\s+(ERROR|ACTION)_PILL_MS\s*=/);
  });

  it("REG-NEWORDER-PILL-C: closing the sheet does not leave a pill for the next open", () => {
    expect(sheet).toMatch(/reduceScanSlot\(prev,\s*\{\s*type:\s*"reset"\s*\}\)/);
  });
});

describe("NewOrderScreen unlisted $0 line (REG-NEWORDER-ZERO)", () => {
  it("REG-NEWORDER-ZERO-A: a $0 ad-hoc line is submitted, not silently dropped", () => {
    // The line stays on screen and still counts toward ITEMS, so excluding it
    // from the POST deleted a real (comped) line with no signal at all. The
    // server allows it: CreateOrderItemDto.unitPrice is @Min(0), and
    // OrdersService only rejects `unitPrice == null`.
    expect(screen).not.toMatch(/u\.unitPrice\s*>\s*0/);
    expect(screen).toMatch(
      /unlisted\s*\n?\s*\.filter\(\(u\) => u\.qty > 0 && u\.name\.trim\(\) !== ""\)/,
    );
  });
});

describe("NewOrderScreen draft-save signal and flush points (REG-NEWORDER-DRAFT)", () => {
  it("REG-B339: the autosave engine's error hook is actually wired", () => {
    expect(screen).toMatch(/onSaveError:\s*noteDraftSaveError,/);
    expect(screen).toMatch(/setDraftSaveFailed\(true\)/);
  });

  it("REG-B339: a failed save is visible to the operator", () => {
    expect(screen).toMatch(/draftSaveFailed \?/);
    expect(screen).toMatch(/Draft not saved/);
  });

  it("REG-B339: the two empty catches are gone; success clears the flag", () => {
    expect(screen).not.toMatch(/flushDraft\(\)\.catch\(\(\) => \{\}\)/);
    expect(screen).toMatch(
      /flushDraft\(\)\.then\(\(\) => setDraftSaveFailed\(false\), noteDraftSaveError\)/,
    );
    // submitOrder's pre-mutate flush routes through the same handler.
    expect(screen).toMatch(/await flushDraftQuietly\(\);/);
  });

  it("REG-B339: backgrounding the app flushes on native, and so does unmount", () => {
    // Pre-fix the ONLY flush triggers were React Navigation's beforeRemove and
    // a `visibilitychange` handler that returns early off web — so the
    // shipping platform had no background trigger at all. Pattern copied from
    // app/(operator)/products/stock-count/[id].tsx.
    expect(screen).toMatch(/AppState\.addEventListener\("change",/);
    expect(screen).toMatch(/if \(state !== "active"\) void flushDraftQuietly\(\)/);
    expect(screen).toMatch(/useEffect\(\(\) => \(\) => void flushDraftQuietly\(\)/);
    // The pre-existing web handler stays.
    expect(screen).toMatch(/document\.visibilityState === "hidden"/);
  });
});

describe("NewOrderScreen at-door cart snapshot (REG-NEWORDER-STOPCART)", () => {
  it("REG-NEWORDER-STOPCART-A: seeded from the store only when there is no server draft", () => {
    expect(screen).toMatch(/from\s+["']\.\.\/store\/stopCartStore["']/);
    expect(screen).toMatch(
      /if \(draftSeedRef\.current === null && !initialDraft && stopId\) \{[\s\S]{0,300}?useStopCartStore\.getState\(\)\.carts\[stopId\]/,
    );
    expect(screen).toMatch(/fromOrderDraftPayload\(snapshot\.payload\)/);
  });

  it("REG-NEWORDER-STOPCART-B: written on a debounce, from the same payload the server draft uses", () => {
    expect(screen).toMatch(/store\.setSnapshot\(stopId,\s*draftPayload\)/);
    expect(screen).toMatch(/\}, 900\);/);
    // Emptying the cart removes the snapshot rather than leaving the last
    // non-empty one to be restored after a kill.
    expect(screen).toMatch(/if \(stopCartParkable\) store\.setSnapshot[\s\S]{0,80}?store\.clear/);
  });

  it("REG-NEWORDER-STOPCART-C: cleared on a live 201 AND on the queued-offline branch", () => {
    const clears = screen.match(/clearStopCartSnapshot\(\);/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(2);
    // REG-B308: a queued create is a pending success, so it must clear there
    // too — otherwise re-opening the stop restores a cart already on its way.
    expect(screen).toMatch(
      /outcome\.kind === "queued"\) \{[\s\S]{0,400}?clearStopCartSnapshot\(\);/,
    );
  });

  it("REG-NEWORDER-STOPCART-D: the comment claiming the run/stop IS the draft is gone", () => {
    const raw = readFileSync(join(MOBILE_ROOT, "components", "NewOrderScreen.tsx"), "utf8");
    expect(raw).not.toMatch(/the run\/stop itself is the/);
  });
});

describe("NewOrderScreen scan-tray price affordance (REG-NEWORDER-TRAYPRICE)", () => {
  it("REG-NEWORDER-TRAYPRICE-A: the sheet threads the tray's price callback", () => {
    expect(sheet).toMatch(/onEditPrice\?:\s*\(id: string\) => void;/);
    expect(sheet).toMatch(/onEditPrice=\{onEditPrice\}/);
    expect(screen).toMatch(/onEditPrice=\{onTrayEditPrice\}/);
  });

  it("REG-NEWORDER-TRAYPRICE-B: it lands on the screen's existing setLinePrice, rounded", () => {
    const mount = (screen.match(/<LinePriceModal[\s\S]*?\/>/) ?? [""])[0];
    expect(mount).toBeTruthy();
    expect(mount).toMatch(/roundMoney\(value\)/);
    expect(mount).toMatch(/setLinePrice\(target\.id,/);
    expect(mount).toMatch(/updateUnlistedPrice\(target\.id, price\)/);
    // No line total is ever written here — the tray and footer re-derive it.
    expect(mount).not.toMatch(/lineTotal|\*\s*qty|qty\s*\*/);
    // SA-085i(b): an untouched pre-fill (price === the resolved base) must never be stored as
    // a redundant override. #2696(c): the save goes through decideTrayPrice (pricing's
    // decideStaffOverride, value-tested in special-override-2696.test.ts), which CLEARS within
    // half a cent of the base; the base is the unitPriceBase the target resolves (TRAYPRICE-E).
    expect(mount).toMatch(/decideTrayPrice\(\{ typed: price, \.\.\.target\.rule, reason \}\)/);
    expect(mount).toMatch(/d\.kind === "clear"\) setLinePrice\(target\.id, null\)/);
  });

  it("REG-NEWORDER-TRAYPRICE-E: the pre-fill and the tray's price both call the lib's price functions (SA-085i(b)), not tierPriceFor directly", () => {
    const target = (screen.match(/const priceEditTarget = \(\(\)[\s\S]*?\}\)\(\);/) ?? [""])[0];
    expect(target).toMatch(/priceEditorPrefill\(line, p, effectiveTierFor\(p\.id\)\)/);
    expect(target).toMatch(/const line = items\[priceEditId\];/);
    expect(target).toMatch(/base: unitPriceBase\(line \?\? \{\}, tierPriceFor\(p\)\)/);
    const tray = (screen.match(/trayRowsFrom\(\{[\s\S]*?\}\),/) ?? [""])[0];
    expect(tray).toMatch(/lineUnitFor\(items\[p\.id\], full, effectiveTierFor\(p\.id\)\)/);
  });

  it("REG-NEWORDER-TRAYPRICE-C (#2696(c)): a SPECIAL-tier line opens the editor — the reason is asked there", () => {
    // B901: the handler lives in lib/use-scan-price-edit.ts (size ratchet); it no longer refuses.
    const hook = readFileSync(join(__dirname, "..", "lib", "use-scan-price-edit.ts"), "utf8");
    const handler = (hook.match(/const onTrayEditPrice = useCallback\([\s\S]*?\n {2}\);/) ?? [
      "",
    ])[0];
    expect(handler).toBeTruthy();
    expect(handler).not.toMatch(/isSpecialLine/);
    expect(hook).not.toMatch(/isSpecialLine/);
    expect(screen).not.toMatch(/isSpecialLine/);
    expect(screen).toMatch(/isSpecial: isSpecialFor\(p\)/);
  });

  it("REG-NEWORDER-TRAYPRICE-D: the camera pauses while the price sheet is over it", () => {
    expect(screen).toMatch(
      /paused=\{createCode != null \|\| pickCode != null \|\| priceEditId != null\}/,
    );
  });
});

/**
 * SA-085i: the catalog row (renderProduct) still passed the pack's tierPriceFor to
 * ProductRow regardless of unitLabel — a Case line at $220 showed "$24.00 / each" in the
 * catalog list next to its count, while the tray and footer already showed $440.
 */
describe("NewOrderScreen catalog row prices/labels a unit-sold line correctly (SA-085i)", () => {
  it("renderProduct's price is lineUnitFor when a line exists, tierPriceFor only for an unadded product", () => {
    const fn = (screen.match(/const renderProduct = useCallback\([\s\S]*?\n    \[/) ?? [""])[0];
    expect(fn).toBeTruthy();
    expect(fn).toMatch(
      /const price = line \? lineUnitFor\(line, p, effectiveTierFor\(p\.id\)\) : tierPriceFor\(p\);/,
    );
  });

  it("passes the line's unitLabel to ProductRow so it shows next to the price, never a bare unitSold boolean", () => {
    const fn = (screen.match(/const renderProduct = useCallback\([\s\S]*?\n    \[/) ?? [""])[0];
    expect(fn).toMatch(/unitLabel=\{line\?\.unitLabel\}/);
    expect(fn).not.toMatch(/unitSold=/);
  });
});

/**
 * SA-085h LOW: a PIECE-barcode hit on a line already sold by a unit adds a whole unit
 * (240 pieces for a Case, not one loose piece) — confirmed before committing rather than
 * silently added.
 */
describe("NewOrderScreen piece-scan-on-a-unit-line confirm (SA-085h LOW)", () => {
  it("gates a piece-kind accept on the line's unitLabel before calling addOne, via the confirm dialog", () => {
    const fn = (screen.match(/const acceptScannedProduct\b[\s\S]*?\n  \};/) ?? [""])[0];
    expect(fn).toBeTruthy();
    // The gate is now the shared predicate (piece kind + the line's unitLabel + a real case size).
    expect(fn).toMatch(/!needsUnitLabelConfirm\(level, product, label\)\) return finishAccept/);
    expect(screen).toMatch(
      /import \{ needsUnitLabelConfirm \} from "\.\.\/lib\/scan-unit-confirm";/,
    );
    expect(fn).toMatch(/confirm\(/);
    // Declining does nothing: addOne only happens inside finishAccept, called from onYes.
    expect(fn).not.toMatch(/^\s*addOne\(/m);
  });

  it("a non-unit line's piece scan is unaffected — no confirm, straight to finishAccept", () => {
    const fn = (screen.match(/const acceptScannedProduct\b[\s\S]*?\n  \};/) ?? [""])[0];
    expect(fn).toMatch(/return finishAccept\(product, level, ao\);/);
  });
});

describe("NewOrderScreen lazy catalogue fetch (REG-NEWORDER-LAZY)", () => {
  it("REG-NEWORDER-LAZY-A: the fetch is gated on browse, and browse is declared before its reader", () => {
    expect(screen).toMatch(/useProductSearch<Product>\(\{ category, browsing \}\)/);
    // A `const` declared after the hook that reads it is a TDZ
    // ReferenceError, not a type error — pin the ordering.
    expect(screen.indexOf("const [browsing, setBrowsing] = useState(false)")).toBeGreaterThan(-1);
    expect(screen.indexOf("const [browsing, setBrowsing] = useState(false)")).toBeLessThan(
      screen.indexOf("useProductSearch<Product>("),
    );
  });

  it("REG-NEWORDER-LAZY-B: the scan fast path reads every row the screen can price", () => {
    // With no preloaded page 1, a plain `products` array would lose the local
    // fast path for lines already on the order.
    expect(screen).toMatch(/products:\s*\(\) => Array\.from\(productById\.values\(\)\),/);
    // The wedge auto-add effect deliberately still matches SERVER rows only.
    expect(screen).toMatch(/findExactScanMatch\(code, products\)/);
  });

  it("REG-NEWORDER-LAZY-C: the idle copy and the way into the catalogue both survive", () => {
    expect(readSource("lib/visible-cart.ts")).toMatch(
      /Scan, search, or browse the catalogue to add items\./,
    );
    expect(screen).toMatch(/Browse catalogue/);
    expect(screen).toMatch(/onPress=\{\(\) => setBrowsing\(true\)\}/);
  });
});
