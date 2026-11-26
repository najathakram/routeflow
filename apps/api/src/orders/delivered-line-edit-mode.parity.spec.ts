/**
 * L-072 pattern: the API cannot value-import @routeflow/types, so it keeps its own literals and sentences; web and
 * mobile read the shared ones. They must stay equal, word for word.
 */
import { CORRECTION_BASES, LINE_EDIT_MODES, LOCKED_REASONS } from "./delivered-line-edit-mode";
import {
  CORRECT_IDENTITY_MESSAGE,
  LOCKED_COPY,
  OPERATOR_NOTE,
  STATUS_COPY,
  lockedCopy,
  statusCopy,
} from "./delivered-line-copy";

type Shared = {
  LINE_EDIT_MODE_VALUES?: readonly string[];
  LOCKED_REASON_VALUES?: readonly string[];
  CORRECTION_BASIS_VALUES?: readonly string[];
  LINE_LOCKED_COPY?: Record<string, string>;
  LINE_STATUS_COPY?: Record<string, string>;
  OPERATOR_CORRECT_NOTE?: string;
  fillLockedCopy?: (r: string, w?: object) => string;
};

function shared(): Shared {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("@routeflow/types") as Shared;
}

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("line edit mode parity (@routeflow/types vs api)", () => {
  it("the modes are set-equal", () => {
    expect(sorted(shared().LINE_EDIT_MODE_VALUES ?? [])).toEqual(sorted(LINE_EDIT_MODES));
  });

  it("the locked reasons are set-equal", () => {
    expect(sorted(shared().LOCKED_REASON_VALUES ?? [])).toEqual(sorted(LOCKED_REASONS));
  });

  it("the correction bases are set-equal", () => {
    expect(sorted(shared().CORRECTION_BASIS_VALUES ?? [])).toEqual(sorted(CORRECTION_BASES));
  });

  it("the status sentences are word-for-word equal", () => {
    expect(shared().LINE_STATUS_COPY).toEqual({ ...STATUS_COPY });
    expect(shared().fillLockedCopy?.("STATUS", { status: "REFUSED" })).toBe(statusCopy("REFUSED"));
  });

  it("the sentence table is word-for-word equal, one row per reason but ROLE", () => {
    expect(shared().LINE_LOCKED_COPY).toEqual({ ...LOCKED_COPY });
    expect(Object.keys(LOCKED_COPY).sort()).toEqual(
      sorted(LOCKED_REASONS.filter((r) => r !== "ROLE" && r !== "STATUS")),
    );
  });

  it("the operator note and the fill rule agree", () => {
    expect(shared().OPERATOR_CORRECT_NOTE).toBe(OPERATOR_NOTE);
    for (const reason of Object.keys(LOCKED_COPY) as Array<keyof typeof LOCKED_COPY>) {
      const words = { item: "Acme Widget", invoiceNumber: "INV-1" };
      expect(shared().fillLockedCopy?.(reason, words)).toBe(lockedCopy(reason, words));
    }
    expect(shared().fillLockedCopy?.("UNIT", {})).toBe(lockedCopy("UNIT", {}));
  });

  it("no sentence tells an admin a delivered line can never be changed (W-1441)", () => {
    for (const s of [
      ...Object.values(LOCKED_COPY),
      ...Object.values(STATUS_COPY),
      OPERATOR_NOTE,
      CORRECT_IDENTITY_MESSAGE,
    ])
      expect(s).not.toMatch(/can never|never be changed|can't ever|cannot ever|no way to change/i);
  });
});
