import { readFileSync } from "fs";
import { join } from "path";

/**
 * B923 (B2): "Start route" is PATCH /route-runs/:id, which is online-only now. Offline it used to vanish
 * into the queue with a success-looking flag; now the interceptor rejects it, so the screen must say so
 * instead of silently doing nothing. Jest here is pure-logic, so the wiring is source-pinned.
 */
const screen = readFileSync(join(__dirname, "..", "app", "(driver)", "route", "index.tsx"), "utf8");

describe("driver Start route when the request is refused offline", () => {
  it("startRun reports 'needs a connection' on isOnlineRequired, and a generic message otherwise", () => {
    const fn = screen.slice(screen.indexOf("const startRun"), screen.indexOf("const onStart"));
    expect(fn).toMatch(/onError/);
    expect(fn).toMatch(/isOnlineRequired/);
    expect(fn).toMatch(/needs a connection/i);
    expect(fn).toMatch(/showToast\(/);
  });
});
