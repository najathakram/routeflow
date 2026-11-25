import * as fs from "fs";
import * as path from "path";

/**
 * R-137 class pin: ONE URL writer per page. A page that keeps filters in the URL (`useUrlFilters`, a `router.replace`)
 * and a sort in the URL (`useUrlSort`) must hand the sort the filters' `writeParams`. Left to its own
 * `history.replaceState`, the sort write landing beside a filter write made Next drop the filter write: "Clear
 * filters" reset the sort and left every filter on.
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

/** The argument text of the first `useUrlSort(...)` call in a file. */
function sortCallArgs(src: string): string {
  const start = src.indexOf(SORT_CALL) + SORT_CALL.length;
  let depth = 1;
  let i = start;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") depth--;
  }
  return src.slice(start, i - 1);
}

const relative = (file: string) => path.relative(APP, file).split(path.sep).join("/");

describe("one URL writer per page", () => {
  const users = sourceFiles(APP)
    .map((file) => ({ file, src: fs.readFileSync(file, "utf8") }))
    .filter(({ src }) => src.includes(SORT_CALL));

  it("the scan sees the orders list (it is not reading an empty folder)", () => {
    expect(users.map((u) => relative(u.file))).toContain("(dashboard)/orders/page.tsx");
  });

  it("every page with URL filters and a URL sort passes the filters' writeParams to the sort", () => {
    const offenders = users
      .filter(({ src }) => src.includes(FILTERS_CALL))
      .filter(({ src }) => !sortCallArgs(src).includes("writeParams"))
      .map(({ file }) => relative(file));
    expect(offenders).toEqual([]);
  });

  it("the argument reader returns the whole call, nested brackets included", () => {
    expect(sortCallArgs('const x = useUrlSort(COLS, pick("a"), "desc", writeParams);')).toBe(
      'COLS, pick("a"), "desc", writeParams',
    );
  });
});
