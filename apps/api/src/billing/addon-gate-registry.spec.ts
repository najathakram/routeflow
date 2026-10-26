import * as fs from "node:fs";
import * as path from "node:path";
import { ADDON_GATE_REGISTRY, addonGateState } from "./addon-gate-registry";

const SRC_ROOT = path.resolve(__dirname, "..");

/** key -> controller files that gate on it (string-literal @RequireAddon sites only, by design). */
function requireAddonSites(): Map<string, string[]> {
  const files = (fs.readdirSync(SRC_ROOT, { recursive: true }) as string[])
    .map(String)
    .filter((f) => f.endsWith(".controller.ts"))
    .map((f) => path.join(SRC_ROOT, f));
  const sites = new Map<string, string[]>();
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const call of text.matchAll(/@RequireAddon\(([^)]*)\)/g)) {
      for (const lit of call[1].matchAll(/"([^"]+)"/g)) {
        const list = sites.get(lit[1]) ?? [];
        list.push(path.relative(SRC_ROOT, file));
        sites.set(lit[1], list);
      }
    }
  }
  return sites;
}

/** A `reviewBy` that is missing, malformed, unparseable, or in the past counts as expired. */
function reviewByExpired(reviewBy: string | undefined, todayUtc: number): boolean {
  if (!reviewBy || !/^\d{4}-\d{2}-\d{2}$/.test(reviewBy)) return true;
  const t = new Date(`${reviewBy}T00:00:00Z`).getTime();
  return !(t >= todayUtc);
}

/**
 * The clock P1c judges "expired" against. PINNED on purpose: a spec must not depend on the
 * calendar, or it turns red by itself on a future date with no code change (W-958). The
 * "this review date is coming up / has passed" nag belongs to the ops monitor, not to CI.
 * Bumping this when a row's reviewBy is actually reviewed is a deliberate edit.
 */
const REVIEW_AS_OF = "2026-10-26";
const REVIEW_AS_OF_UTC = new Date(`${REVIEW_AS_OF}T00:00:00Z`).getTime();

/** Dark rows (as "key:reviewBy") whose reviewBy is missing, malformed, or before `todayUtc`. */
function expiredDarkRows(
  registry: Record<string, { state: string; reviewBy?: string }>,
  todayUtc: number,
): string[] {
  return Object.entries(registry)
    .filter(([, row]) => row.state === "dark")
    .filter(([, row]) => reviewByExpired(row.reviewBy, todayUtc))
    .map(([key, row]) => `${key}:${row.reviewBy ?? "missing"}`);
}

describe("ADDON_GATE_REGISTRY pins (P1)", () => {
  const sites = requireAddonSites();
  const registryKeys = Object.keys(ADDON_GATE_REGISTRY);

  it("P1a: every @RequireAddon key found in a controller has a registry row", () => {
    const missing = [...sites.keys()].filter((key) => !registryKeys.includes(key));
    expect(missing).toEqual([]);
  });

  it("P1f: the registry is non-empty", () => {
    expect(registryKeys).not.toEqual([]);
  });

  it("P1b: every registry key has at least one live call site", () => {
    const stale = registryKeys.filter(
      (key) => !sites.has(key) || (sites.get(key)?.length ?? 0) === 0,
    );
    expect(stale).toEqual([]);
  });

  it("P1c: every dark row's reviewBy date is not in the past (as of the pinned REVIEW_AS_OF)", () => {
    // Collected so a failure names the offending key and date (Jest expect() takes ONE argument).
    expect(expiredDarkRows(ADDON_GATE_REGISTRY, REVIEW_AS_OF_UTC)).toEqual([]);
  });

  describe("REG-W958: P1c must not depend on the calendar", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it.each(["2027-06-01T12:00:00Z", "2099-01-01T00:00:00Z"])(
      "the real-registry check is unaffected by a system clock of %s",
      (systemNow) => {
        jest.useFakeTimers({ now: new Date(systemNow) });
        expect(expiredDarkRows(ADDON_GATE_REGISTRY, REVIEW_AS_OF_UTC)).toEqual([]);
      },
    );

    it("the helper reports the dark rows once the injected clock passes its reviewBy", () => {
      const farFuture = Date.UTC(2027, 5, 1);
      const offenders = expiredDarkRows(ADDON_GATE_REGISTRY, farFuture);
      expect(offenders).toEqual(
        expect.arrayContaining([
          "ocr:2027-03-31",
          "crm_gohighlevel:2027-03-11",
          "email.connected_mailbox:2027-03-17",
        ]),
      );
    });
  });

  describe("expiredDarkRows (injected clock, fixture registry)", () => {
    const today = Date.UTC(2026, 9, 26);
    const row = (state: "dark" | "enforced", reviewBy?: string) => ({ state, reviewBy });

    it("reports a dark row whose reviewBy is before today", () => {
      expect(expiredDarkRows({ a: row("dark", "2026-10-25") }, today)).toEqual(["a:2026-10-25"]);
    });

    it("does not report a dark row whose reviewBy is today or later", () => {
      expect(
        expiredDarkRows({ a: row("dark", "2026-10-26"), b: row("dark", "2026-10-27") }, today),
      ).toEqual([]);
    });

    it("reports a dark row with a missing or malformed reviewBy", () => {
      expect(
        expiredDarkRows(
          { a: row("dark"), b: row("dark", "tomorrow"), c: row("dark", "2026-13-45") },
          today,
        ),
      ).toEqual(["a:missing", "b:tomorrow", "c:2026-13-45"]);
    });

    it("ignores a non-dark row even when its reviewBy is expired or missing", () => {
      expect(
        expiredDarkRows({ a: row("enforced", "2020-01-01"), b: row("enforced") }, today),
      ).toEqual([]);
    });
  });

  it("P1d: every row's added date is YYYY-MM-DD, and ocr is dark", () => {
    const badAdded = Object.entries(ADDON_GATE_REGISTRY)
      .filter(([, row]) => !/^\d{4}-\d{2}-\d{2}$/.test(row.added))
      .map(([key, row]) => `${key}:${row.added}`);
    expect(badAdded).toEqual([]);
    expect(ADDON_GATE_REGISTRY.ocr?.state).toBe("dark");
  });

  it("P1e: the source scan finds at least the expected key counts today", () => {
    expect(sites.get("ocr")?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(sites.get("tobacco_dealer")?.length ?? 0).toBeGreaterThanOrEqual(8);
    expect(sites.get("recurring_routes")?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(sites.get("order_delivery")?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(sites.get("developer_mode")?.length ?? 0).toBeGreaterThanOrEqual(7);
  });

  it("P1g: addonGateState falls closed to enforced for an unregistered key", () => {
    expect(addonGateState("not_in_registry")).toBe("enforced");
    expect(addonGateState("ocr")).toBe("dark");
  });

  it("P1h: a malformed or unparseable reviewBy counts as expired", () => {
    const today = Date.UTC(2026, 0, 1);
    expect(reviewByExpired("2026-10-5", today)).toBe(true);
    expect(reviewByExpired("tomorrow", today)).toBe(true);
    expect(reviewByExpired("2026-13-45", today)).toBe(true);
    expect(reviewByExpired(undefined, today)).toBe(true);
    expect(reviewByExpired("2025-12-31", today)).toBe(true);
    expect(reviewByExpired("2026-01-01", today)).toBe(false);
    expect(reviewByExpired("2999-01-01", today)).toBe(false);
  });
});
