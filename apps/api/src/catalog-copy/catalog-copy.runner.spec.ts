/** SA-1027 C-G17: a run that left an error row (a family not copied, or an undo that failed) exits non-zero. */
import { exitCodeFor } from "./catalog-copy.runner";

describe("catalog-copy exit code", () => {
  it("0 when nothing went wrong, a dry run, or a resume", () => {
    expect(exitCodeFor({ errors: [] } as never)).toBe(0);
    expect(exitCodeFor({ mode: "dry-run" } as never)).toBe(0);
    expect(exitCodeFor({ photosCopied: 3 })).toBe(0);
  });

  it("3 when the report holds any error row", () => {
    expect(exitCodeFor({ errors: [{ rootId: "r", kind: "copy", message: "m" }] } as never)).toBe(3);
    expect(exitCodeFor({ errors: [{ rootId: "r", kind: "undo", message: "m" }] } as never)).toBe(3);
  });
});
