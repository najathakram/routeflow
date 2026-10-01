import * as fs from "fs";
import * as path from "path";
import { activeLeafHref } from "./nav-active";

/**
 * The sidebar lights up exactly ONE leaf. A plain `pathname.startsWith(href)` lit both "Today's
 * route" (/routes/my-runs) and "My Routes" (/routes) on /routes/my-runs for a driver; the longest
 * segment-boundary prefix wins instead.
 */
const DRIVER_LEAVES = [
  { href: "/routes/my-runs" },
  { href: "/dashboard" },
  { href: "/routes" },
  { href: "/settings" },
];

describe("activeLeafHref (web nav, two items active at once)", () => {
  it("/routes/my-runs lights only Today's route, not My Routes", () => {
    expect(activeLeafHref(DRIVER_LEAVES, "/routes/my-runs")).toBe("/routes/my-runs");
  });

  it("a deeper page under my-runs still lights Today's route", () => {
    expect(activeLeafHref(DRIVER_LEAVES, "/routes/my-runs/abc123")).toBe("/routes/my-runs");
  });

  it("/routes (and /routes/<id>) light My Routes, not Today's route", () => {
    expect(activeLeafHref(DRIVER_LEAVES, "/routes")).toBe("/routes");
    expect(activeLeafHref(DRIVER_LEAVES, "/routes/xyz")).toBe("/routes");
  });

  it("matches on a segment boundary: /routes-archive does not light /routes", () => {
    expect(activeLeafHref(DRIVER_LEAVES, "/routes-archive")).toBeNull();
    expect(activeLeafHref(DRIVER_LEAVES, "/settings-old")).toBeNull();
  });

  it("the dashboard leaf is exact-or-child like every other leaf", () => {
    expect(activeLeafHref(DRIVER_LEAVES, "/dashboard")).toBe("/dashboard");
    expect(activeLeafHref(DRIVER_LEAVES, "/dashboardx")).toBeNull();
  });

  it("no leaf matches an unrelated path", () => {
    expect(activeLeafHref(DRIVER_LEAVES, "/orders")).toBeNull();
  });
});

describe("layout.tsx wires the top-level leaves through activeLeafHref", () => {
  const layout = fs.readFileSync(path.resolve(__dirname, "../layout.tsx"), "utf8");

  it("imports activeLeafHref and no longer highlights a leaf with a bare startsWith(entry.href)", () => {
    expect(layout).toMatch(/activeLeafHref/);
    expect(layout).not.toMatch(/pathname\.startsWith\(entry\.href\)/);
  });
});
