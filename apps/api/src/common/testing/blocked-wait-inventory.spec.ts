/**
 * W-1003 — static pin: a DB spec asks Postgres "who is blocked" only through `blocked-wait.ts`.
 *
 * `pg_stat_activity` is read from a per-transaction stats snapshot, so a poller on a connection in
 * an open transaction misses a backend that blocks later (the W-739 / #3691 flake). The helper
 * clears the snapshot on every probe; this walks `apps/api/src` so a NEW raw `pg_blocking_pids`
 * poll anywhere fails here instead of becoming the next flake.
 *
 * `CLEARS_INLINE` is a closed set of specs that predate the helper and clear the snapshot by hand.
 * They may only leave the list (migrate to the helper); each must still clear, so a pin cannot go
 * stale quietly. LATER: move these 14 onto the helper (W-1003 follow-up).
 */

import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..", "..");
const HELPER = path.join(SRC_ROOT, "common", "testing", "blocked-wait.ts");
const SELF = __filename.replace(/\.js$/, ".ts");

const CLEARS_INLINE = [
  "billing/billing-cron-paying-2641.db.spec.ts",
  "billing/lock-order-2551.db.spec.ts",
  "billing/upgrade-override-guard-2470.db.spec.ts",
  "customers/customer-delete-fk-race-2572.db.spec.ts",
  "customers/customer-delete-race-2558.db.spec.ts",
  "invoices/billing-lock-race-sa760.db.spec.ts",
  "invoices/invoice-send-void-race.db.spec.ts",
  "invoices/order-lock-first-sa706.db.spec.ts",
  "invoices/partial-invoice-cas-2070.db.spec.ts",
  "invoices/split-invoice-cas-2612.db.spec.ts",
  "orders/edit-overpay-race-sa763.db.spec.ts",
  "routes/run-stop-reorder-lock.db.spec.ts",
  "routes/run-terminal-vs-stop-completion-sa706f.db.spec.ts",
  "routes/stop-completion-order-first-sa706d.db.spec.ts",
];

const RAW_POLL = /pg_blocking_pids/;
const CLEARS = /pg_stat_clear_snapshot/;

function collectTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      collectTs(full, out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f: string) => path.relative(SRC_ROOT, f).split(path.sep).join("/");

/** Files that ask `pg_blocking_pids` themselves, minus the helper and this pin. */
export function rawPollers(files: string[], read: (f: string) => string): string[] {
  return files
    .filter((f) => f !== HELPER && f !== SELF && RAW_POLL.test(read(f)))
    .map(rel)
    .sort();
}

describe("W-1003 blocked-wait inventory", () => {
  const files = collectTs(SRC_ROOT);
  const pollers = rawPollers(files, (f) => fs.readFileSync(f, "utf8"));

  it("no spec polls pg_blocking_pids outside the shared helper, except the closed legacy set", () => {
    const offenders = pollers.filter((f) => !CLEARS_INLINE.includes(f));
    expect(offenders).toEqual([]);
  });

  it("every legacy inline poller still polls AND still clears the snapshot", () => {
    const stale = CLEARS_INLINE.filter((f) => !pollers.includes(f));
    expect(stale).toEqual([]); // migrated to the helper: remove it from CLEARS_INLINE
    const notClearing = CLEARS_INLINE.filter(
      (f) => !CLEARS.test(fs.readFileSync(path.join(SRC_ROOT, f), "utf8")),
    );
    expect(notClearing).toEqual([]);
  });

  it("the helper itself clears the snapshot before it probes", () => {
    const src = fs.readFileSync(HELPER, "utf8");
    expect(src).toMatch(RAW_POLL);
    expect(src).toMatch(/await clearStatSnapshot\(db\);\s*\n\s*const exclude/);
  });

  it("the scanner flags a planted raw poll and ignores a helper user", () => {
    const fake = {
      "/x/a.ts": "WHERE pg_blocking_pids(pid)",
      "/x/b.ts": "waitUntilBlockedBy(pool, pid)",
    };
    const got = rawPollers(Object.keys(fake), (f) => fake[f as keyof typeof fake]);
    expect(got).toHaveLength(1);
  });
});
