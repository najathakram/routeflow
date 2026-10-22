import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Row 342 OWNER RULING: the hand-over stamp (cashier, register, time) is on STAFF views only, never on a customer copy: the
 * receipt, the invoice print / PDF and the emails. Only the two staff detail pages render it; anything else naming the
 * stamp (a receipt, a print view, a buyer page) is a new leak and goes red here.
 */
const ROOT = join(__dirname, "..");
// Jest's own transform cache (.jest-cache) lives in this tree and other workers add and remove files in it while we walk
// (row 734: ENOENT from a statSync on a cache file another worker had just removed). It is not source: skip it.
const SKIP = new Set(["node_modules", ".next", "e2e", "coverage", ".jest-cache", "test-results"]);
type Fs = Pick<typeof import("node:fs"), "readdirSync" | "statSync">;
const isGone = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const walk = (dir: string, fs: Fs = { readdirSync, statSync }): string[] => {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (isGone(e)) return []; // the directory went away mid-walk
    throw e;
  }
  return names.flatMap((n) => {
    if (SKIP.has(n)) return [];
    const p = join(dir, n);
    let isDir: boolean;
    try {
      isDir = fs.statSync(p).isDirectory();
    } catch (e) {
      if (isGone(e)) return []; // removed between readdir and stat
      throw e;
    }
    if (isDir) return walk(p, fs);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.(ts|tsx)$/.test(n) ? [p] : [];
  });
};

/** The names a customer copy must never carry: the stamp's helpers and the two stamped fields (row 374 e). */
const STAMP_NAMES = /handOverStampLine|HandOverStamp|handover-stamp|handedOverBy|registerKey/;

describe("the walker survives Jest's own cache (row 734)", () => {
  const enoent = () =>
    Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  const dirStat = { isDirectory: () => true };
  const fileStat = { isDirectory: () => false };
  const slash = (p: string) => p.replace(/\\/g, "/");

  it("never descends into .jest-cache", () => {
    const seen: string[] = [];
    const fake = {
      readdirSync: (d: string) => {
        seen.push(slash(d));
        return slash(d) === "/w" ? [".jest-cache", "a.ts"] : ["x.ts"];
      },
      statSync: (p: string) => (p.endsWith(".jest-cache") ? dirStat : fileStat),
    } as unknown as Fs;
    expect(walk("/w", fake).map(slash)).toEqual(["/w/a.ts"]);
    expect(seen).toEqual(["/w"]);
  });

  it("tolerates a file that vanishes between readdir and stat, and a directory that vanishes", () => {
    const fake = {
      readdirSync: (d: string) => {
        if (d.endsWith("gone-dir")) throw enoent();
        return slash(d) === "/w" ? ["race.ts", "gone-dir", "ok.ts"] : [];
      },
      statSync: (p: string) => {
        if (p.endsWith("race.ts")) throw enoent();
        return p.endsWith("gone-dir") ? dirStat : fileStat;
      },
    } as unknown as Fs;
    expect(walk("/w", fake).map(slash)).toEqual(["/w/ok.ts"]);
  });

  it("still fails loudly on any other error", () => {
    const fake = {
      readdirSync: () => ["a.ts"],
      statSync: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    } as unknown as Fs;
    expect(() => walk("/w", fake)).toThrow("EACCES");
  });
});

describe("hand-over stamp stays off customer copies (row 342)", () => {
  it("the scan catches each name (planted references)", () => {
    for (const planted of [
      "renderHandOverStamp(order)",
      'import { handOverStampLine } from "@/lib/handover-stamp";',
      "<p>{order.handedOverBy}</p>",
      "const r = invoice.order.registerKey;",
    ]) {
      expect(STAMP_NAMES.test(planted)).toBe(true);
    }
    expect(STAMP_NAMES.test("const cashier = receipt.cashier;")).toBe(false);
  });

  it("only the lib, the component, the staff reads' types, the staff detail pages and Today's hand-over rows name it", () => {
    const users = walk(ROOT)
      .filter((p) => STAMP_NAMES.test(readFileSync(p, "utf8")))
      .map((p) =>
        p
          .slice(ROOT.length + 1)
          .split(sep)
          .join("/"),
      )
      .sort();
    expect(users).toEqual([
      "app/(dashboard)/invoices/[id]/page.tsx",
      "app/(dashboard)/orders/[id]/page.tsx",
      "app/(dashboard)/orders/_components/CounterDayClose.tsx", // day close is staff-only; it reads the register key for the draft key
      "app/(dashboard)/orders/_components/HandOverRows.tsx", // Today's sales hand-over rows (staff)
      "components/HandOverStamp.tsx",
      "lib/api/invoices.ts", // the staff read's type
      "lib/api/orders.ts", // the staff read's type
      "lib/counter-day-close-draft.ts", // the day-close draft key carries registerKey (staff-only surface, BUILD-BRIEF G2)
      "lib/handover-stamp.ts",
    ]);
  });
});
