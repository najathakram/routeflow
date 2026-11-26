import * as fs from "fs";
import * as path from "path";

/**
 * R-137 class pin: ONE URL writer per page. A page that keeps filters in the URL (`useUrlFilters`, a `router.replace`)
 * and a sort in the URL (`useUrlSort`) must hand the sort the filters' `writeParams`. Left to its own
 * `history.replaceState`, the sort write landing beside a filter write made Next drop the filter write: "Clear
 * filters" reset the sort and left every filter on.
 *
 * What is pinned: in every non-test source file under `app/` that calls `useUrlFilters(`, EVERY `useUrlSort(` call
 * names `writeParams` among its arguments (R-142: the first version read only the first call in a file). It is a
 * text check: it does not prove the name is the filters' own writer, and it does not see a page that splits the
 * two hooks across files.
 */
const APP = path.join(__dirname, "..", "..", "app");
const SORT_CALL = "useUrlSort(";
const FILTERS_CALL = "useUrlFilters(";

const isSource = (name: string) =>
  (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.includes(".test.");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return isSource(entry.name) ? [full] : [];
  });
}

/** The argument text of EVERY `useUrlSort(...)` call in a file, in order. */
function sortCallArgs(src: string): string[] {
  const calls: string[] = [];
  let from = src.indexOf(SORT_CALL);
  while (from !== -1) {
    const start = from + SORT_CALL.length;
    let depth = 1;
    let i = start;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    calls.push(src.slice(start, i - 1));
    from = src.indexOf(SORT_CALL, i);
  }
  return calls;
}

/** How many `useUrlSort` calls in a file with URL filters do NOT share the filters' writer. */
function unsharedSortCalls(src: string): number {
  if (!src.includes(FILTERS_CALL)) return 0;
  return sortCallArgs(src).filter((args) => !args.includes("writeParams")).length;
}

const relative = (file: string) => path.relative(APP, file).split(path.sep).join("/");

describe("one URL writer per page", () => {
  const users = sourceFiles(APP)
    .map((file) => ({ file, src: fs.readFileSync(file, "utf8") }))
    .filter(({ src }) => src.includes(SORT_CALL));

  it("the scan sees the orders list (it is not reading an empty folder)", () => {
    expect(users.map((u) => relative(u.file))).toContain("(dashboard)/orders/page.tsx");
  });

  it("every useUrlSort call on a page with URL filters passes the filters' writeParams", () => {
    const offenders = users
      .filter(({ src }) => unsharedSortCalls(src) > 0)
      .map(({ file }) => relative(file));
    expect(offenders).toEqual([]);
  });
});

describe("the pin's own reader", () => {
  const FILTERS = "const [f, set, clear, setMany, writeParams] = useUrlFilters({ status: '' });\n";
  const GOOD = 'const [a, b, setA] = useUrlSort(COLS, pick("a"), "desc", writeParams);\n';
  const BAD = 'const [c, d, setC] = useUrlSort(OTHER_COLS, "name", "asc");\n';

  it("returns the whole argument text of each call, nested brackets included", () => {
    expect(sortCallArgs(GOOD + BAD)).toEqual([
      'COLS, pick("a"), "desc", writeParams',
      'OTHER_COLS, "name", "asc"',
    ]);
  });

  it("a second call without the writer, after a good first call, is caught (R-142)", () => {
    expect(unsharedSortCalls(FILTERS + GOOD + BAD)).toBe(1);
  });

  it("a first call without the writer is caught, and two bad calls count as two", () => {
    expect(unsharedSortCalls(FILTERS + BAD + GOOD)).toBe(1);
    expect(unsharedSortCalls(FILTERS + BAD + BAD)).toBe(2);
  });

  it("every call sharing the writer is clean", () => {
    expect(unsharedSortCalls(FILTERS + GOOD + GOOD)).toBe(0);
  });

  it("a page with a URL sort and no URL filters is not held to the rule", () => {
    expect(unsharedSortCalls(BAD)).toBe(0);
  });
});
