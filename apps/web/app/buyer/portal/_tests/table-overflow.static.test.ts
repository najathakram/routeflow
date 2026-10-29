import * as fs from "fs";
import * as path from "path";

/**
 * B540 class guard: a multi-column <table> wrapped in `overflow-hidden` clips rows wider than the
 * viewport at 390px instead of scrolling. House pattern (vendor-bills/[id]): an `overflow-x-auto`
 * wrapper directly around a table with an explicit `min-w-[Npx]`.
 *
 * Per-file scan: for each `<table`, look back over the few lines of wrapper JSX; the NEAREST
 * `overflow-*` class decides. `overflow-hidden` nearest => the table is clipped => fail.
 */
const WEB_ROOT = path.join(__dirname, "..", "..", "..", "..");
const SCAN_DIRS = ["app/buyer/portal", "app/(dashboard)", "app/(platform-admin)", "components"];
const LOOKBACK_LINES = 8;

/** Explicit false positives: "<file suffix>:<reason>" - keep empty unless justified. */
const ALLOWLIST: Record<string, string> = {
  // 2-column P&L statement (label + amount): never wider than a phone.
  "app/(dashboard)/finance/reports/page.tsx": "two-column statement, fits 390px",
};

/** Tables that restack into cards below `sm` (display:block rows) cannot clip. */
const CARD_LAYOUT_TABLE = /<table[^>]*className="[^"]*block[^"]*(sm|md):table/;

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      walk(p, out);
    } else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) out.push(p);
  }
}

export function findClippedTables(src: string): number[] {
  const lines = src.split("\n");
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (!/<table[\s>]/.test(line) || CARD_LAYOUT_TABLE.test(line)) return;
    for (let j = i; j >= Math.max(0, i - LOOKBACK_LINES); j--) {
      const l = j === i ? line.slice(0, line.indexOf("<table")) : lines[j];
      if (j < i && /<table[\s>]|<\/table>/.test(l)) break;
      if (/overflow-x-(auto|scroll)|overflow-auto|overflow-scroll/.test(l)) return;
      if (/overflow-hidden/.test(l)) {
        hits.push(i + 1);
        return;
      }
    }
  });
  return hits;
}

describe("B540: wide tables scroll instead of clipping", () => {
  it("no <table> sits directly inside an overflow-hidden wrapper", () => {
    const files: string[] = [];
    for (const d of SCAN_DIRS) walk(path.join(WEB_ROOT, d), files);
    const bad: string[] = [];
    for (const f of files) {
      const rel = path.relative(WEB_ROOT, f).split(path.sep).join("/");
      if (Object.keys(ALLOWLIST).some((k) => rel.endsWith(k))) continue;
      for (const ln of findClippedTables(fs.readFileSync(f, "utf8"))) bad.push(`${rel}:${ln}`);
    }
    expect(bad).toEqual([]);
  });

  it("the scanner flags a clipped table and accepts the house pattern", () => {
    const clipped = `<div className="rounded overflow-hidden">\n<table className="w-full">`;
    const ok = `<div className="rounded overflow-hidden">\n<div className="overflow-x-auto">\n<table className="min-w-[640px]">`;
    expect(findClippedTables(clipped)).toEqual([2]);
    expect(findClippedTables(ok)).toEqual([]);
  });
});
