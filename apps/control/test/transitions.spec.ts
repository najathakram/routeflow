/**
 * T10 (R5) — the spec §2 status-transition matrix, 8 states x 8 events = 64 cells.
 * The matrix below is this test's OWN copy (never read from the implementation).
 * Contract under test: `transition(from, event, prior?) -> Status | null` in
 * src/domain/transitions.ts (null = refused).
 */

type Status =
  | "proposed"
  | "planned"
  | "in-progress"
  | "blocked"
  | "code-complete"
  | "released"
  | "reconsider"
  | "dropped";
type Ev =
  "started" | "done" | "released" | "blocked" | "unblocked" | "reconsider" | "reopened" | "dropped";
type Cell = Status | "prior" | null;

const EVENTS: Ev[] = [
  "started",
  "done",
  "released",
  "blocked",
  "unblocked",
  "reconsider",
  "reopened",
  "dropped",
];

// Column order = EVENTS. null = refused; "prior" = back to the status before `blocked`.
const MATRIX: Record<Status, Cell[]> = {
  proposed: [null, null, null, null, null, "reconsider", null, "dropped"],
  planned: ["in-progress", null, "released", "blocked", null, "reconsider", null, "dropped"],
  "in-progress": [
    "in-progress",
    "code-complete",
    "released",
    "blocked",
    null,
    "reconsider",
    "planned",
    "dropped",
  ],
  blocked: [null, null, null, "blocked", "prior", "reconsider", "planned", "dropped"],
  "code-complete": [
    null,
    "code-complete",
    "released",
    null,
    null,
    "reconsider",
    "planned",
    "dropped",
  ],
  released: [null, null, null, null, null, null, "planned", null],
  reconsider: [null, null, null, null, null, null, "planned", "dropped"],
  dropped: [null, null, null, null, null, null, null, null],
};

function tryRequire(load: () => unknown): any {
  try {
    return load();
  } catch (e: any) {
    if (e && e.code === "MODULE_NOT_FOUND") return undefined;
    throw e;
  }
}
const mod = tryRequire(() => require("../src/domain/transitions"));

const CASES = (Object.keys(MATRIX) as Status[]).flatMap((from) =>
  EVENTS.map((ev, i) => [from, ev, MATRIX[from][i]] as const),
);

describe("transition matrix (T10)", () => {
  it("has 64 cases", () => {
    expect(CASES).toHaveLength(64);
  });

  it("exports transition()", () => {
    expect(mod).toBeDefined();
    expect(typeof mod.transition).toBe("function");
  });

  it.each(CASES)("%s + %s -> %s", (from, ev, want) => {
    expect(mod).toBeDefined();
    if (want === "prior") {
      expect(mod.transition(from, ev, "in-progress")).toBe("in-progress");
      expect(mod.transition(from, ev, "code-complete")).toBe("code-complete");
      expect(mod.transition(from, ev)).toBe("planned"); // no remembered prior -> planned
    } else {
      expect(mod.transition(from, ev, "in-progress")).toBe(want);
      expect(mod.transition(from, ev)).toBe(want);
    }
  });
});
