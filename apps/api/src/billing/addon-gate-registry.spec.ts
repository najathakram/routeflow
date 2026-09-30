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

  it("P1c: every dark row's reviewBy date is not in the past (UTC)", () => {
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const darkRows = Object.entries(ADDON_GATE_REGISTRY).filter(([, row]) => row.state === "dark");

    // Collected so a failure names the offending key and date (Jest expect() takes ONE argument).
    const expired = darkRows
      .filter(([, row]) => reviewByExpired(row.reviewBy, todayUtc))
      .map(([key, row]) => `${key}:${row.reviewBy ?? "missing"}`);
    expect(expired).toEqual([]);
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
