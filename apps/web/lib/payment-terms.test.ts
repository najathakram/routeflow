import * as fs from "fs";
import * as path from "path";
import { PAYMENT_TERM_PRESETS, netLabel, termDays } from "@routeflow/types/payment-terms";
import { addDaysIso, getDaysForTerms } from "./invoice-terms";

const { GENERATED_DIRS } = require("../../../scripts/lib/generated-dirs.cjs") as {
  GENERATED_DIRS: readonly string[];
};

/** W-1487: one shared payment-terms table. B-1, B-2, B-3, B-4 and B-8 (the fs-read pin). */
describe("termDays (B-1, B-2)", () => {
  it("B-1: Net 7 is 7 and Net 90 is 90", () => {
    expect(termDays("Net 7")).toBe(7);
    expect(termDays("Net 90")).toBe(90);
  });

  it("every preset reads, and Due on Receipt is 0", () => {
    expect(PAYMENT_TERM_PRESETS).toEqual([
      "Due on Receipt",
      "Net 7",
      "Net 15",
      "Net 30",
      "Net 45",
      "Net 60",
      "Net 90",
    ]);
    for (const p of PAYMENT_TERM_PRESETS) expect(termDays(p)).not.toBeNull();
    expect(termDays("Due on Receipt")).toBe(0);
  });

  it("B-2: Net 21 is 21; 0, 400, 7.5, -3 and 'net 30 days' are null", () => {
    expect(termDays("Net 21")).toBe(21);
    expect(termDays("Net 1")).toBe(1);
    expect(termDays("Net 365")).toBe(365);
    for (const bad of [
      "Net 0",
      "Net 400",
      "Net 366",
      "Net 7.5",
      "Net -3",
      "net 30 days",
      "",
      "Net",
    ]) {
      expect(termDays(bad)).toBeNull();
    }
    expect(termDays(null)).toBeNull();
    expect(termDays(undefined)).toBeNull();
  });

  it("netLabel writes the label termDays reads", () => {
    expect(netLabel(21)).toBe("Net 21");
    expect(netLabel(0)).toBeNull();
    expect(netLabel(366)).toBeNull();
    expect(netLabel(7.5)).toBeNull();
  });
});

describe("web getDaysForTerms + addDaysIso (B-3, B-4)", () => {
  const due = (issue: string, label: string) => addDaysIso(issue, getDaysForTerms(label) ?? 30);

  it("B-3: 2026-03-01 with Net 7 is 2026-03-08; with Net 30 it is 2026-03-31 (DST stays right)", () => {
    expect(due("2026-03-01", "Net 7")).toBe("2026-03-08");
    expect(due("2026-03-01", "Net 30")).toBe("2026-03-31");
  });

  it("B-4: 2026-11-26 with Net 90 is 2027-02-24", () => {
    expect(due("2026-11-26", "Net 90")).toBe("2027-02-24");
  });

  it("a custom Net 21 reads through the same helper", () => {
    expect(getDaysForTerms("Net 21")).toBe(21);
    expect(getDaysForTerms("whatever")).toBeNull();
  });
});

/** B-8: the shared helper is the only day table. Comments may still say "Net 45"; code may not. */
describe("B-8: no second payment-terms day table in apps/web or apps/mobile", () => {
  const repo = path.resolve(__dirname, "../../..");
  // The shared generated-folder list (generated-dirs.pin.spec): web jest renames temp files under .jest-cache mid-walk.
  const SKIP_DIRS = new Set([...GENERATED_DIRS, "e2e", "__tests__"]);
  // Supplier terms are another row (W-1487 brief): their lists stay as they are.
  const OTHER_ROW = ["app/(dashboard)/suppliers/page.tsx", "app/(dashboard)/vendor-bills/page.tsx"];

  function walk(dir: string, out: string[]): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
    return out;
  }

  it("no source file holds the quoted label Net 45 in code", () => {
    const offenders: string[] = [];
    for (const root of ["apps/web", "apps/mobile"]) {
      for (const file of walk(path.join(repo, root), [])) {
        const rel = path.relative(path.join(repo, root), file).split(path.sep).join("/");
        if (OTHER_ROW.includes(rel)) continue;
        const code = fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .join("\n");
        if (/["']Net 45["']/.test(code)) offenders.push(`${root}/${rel}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
