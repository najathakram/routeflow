/**
 * Wave 2: the extracted payment-term constants + due-date math
 * (lib/invoice-terms.ts) — previously duplicated in invoices/new.tsx and
 * SplitInvoiceScreen.tsx with no coverage.
 */
import {
  DEFAULT_TERMS,
  ISO_DATE,
  TERM_CHIPS,
  commitCustomDays,
  customDaysBlocksCreate,
  customTermsFromInput,
  daysForTerms,
  TERM_OPTIONS,
  dueDateFor,
  clearCustomFor,
  settleDraftsForCreate,
  settlePendingCustomTerms,
  todayPlusDays,
} from "../lib/invoice-terms";
import * as fs from "fs";
import * as path from "path";

describe("term constants", () => {
  it("options and chips derive from the shared presets in order", () => {
    expect(TERM_OPTIONS).toEqual([
      "Due on Receipt",
      "Net 7",
      "Net 15",
      "Net 30",
      "Net 45",
      "Net 60",
      "Net 90",
    ]);
    expect(TERM_CHIPS).toEqual(TERM_OPTIONS.map((label) => ({ label })));
    expect(daysForTerms(DEFAULT_TERMS)).toBe(30);
  });
});

describe("dueDateFor", () => {
  it("adds the term's day count to an explicit issue date (UTC, no DST drift)", () => {
    expect(dueDateFor("2026-01-31", "Net 15")).toBe("2026-02-15");
    expect(dueDateFor("2026-08-01", "Net 30")).toBe("2026-08-31");
    expect(dueDateFor("2026-08-01", "Due on Receipt")).toBe("2026-08-01");
  });

  it("crosses a year boundary correctly", () => {
    expect(dueDateFor("2026-12-20", "Net 45")).toBe("2027-02-03");
  });

  it("unknown term falls back to 30 days (web's behaviour)", () => {
    expect(dueDateFor("2026-08-01", "whatever")).toBe("2026-08-31");
  });

  it("blank/invalid issue date falls back to today + term days", () => {
    expect(dueDateFor("", "Net 15")).toBe(todayPlusDays(15));
    expect(dueDateFor("not-a-date", "Due on Receipt")).toBe(todayPlusDays(0));
  });

  it("always returns an ISO date", () => {
    for (const term of TERM_OPTIONS) {
      expect(dueDateFor("2026-06-15", term)).toMatch(ISO_DATE);
      expect(dueDateFor("", term)).toMatch(ISO_DATE);
    }
  });
});

describe("W-1487: Net 7, Net 90 and a custom Net N (B-3, B-4)", () => {
  it("B-3: 2026-03-01 + Net 7 is 2026-03-08 and + Net 30 is 2026-03-31", () => {
    expect(dueDateFor("2026-03-01", "Net 7")).toBe("2026-03-08");
    expect(dueDateFor("2026-03-01", "Net 30")).toBe("2026-03-31");
  });

  it("B-4: 2026-11-26 + Net 90 is 2027-02-24", () => {
    expect(dueDateFor("2026-11-26", "Net 90")).toBe("2027-02-24");
  });

  it("a custom Net 21 runs 21 days; the options offer the shared presets", () => {
    expect(dueDateFor("2026-03-01", "Net 21")).toBe("2026-03-22");
    expect(TERM_OPTIONS).toEqual([
      "Due on Receipt",
      "Net 7",
      "Net 15",
      "Net 30",
      "Net 45",
      "Net 60",
      "Net 90",
    ]);
  });
});

describe("W-1487: the custom days box (B-7, mobile)", () => {
  it("a typed 21 is Net 21; 0, 366, 7.5 and words are refused inline", () => {
    expect(customTermsFromInput("21")).toEqual({ label: "Net 21", error: null });
    for (const bad of ["0", "366", "7.5", "-3", "abc"]) {
      expect(customTermsFromInput(bad).label).toBeNull();
      expect(customTermsFromInput(bad).error).toMatch(/1 to 365/);
    }
    expect(customTermsFromInput("")).toEqual({ label: null, error: null });
  });
});

describe("W-1487: commitCustomDays (the custom box commits only a valid number)", () => {
  it("a valid number commits its label and clears the error", () => {
    expect(commitCustomDays("21", "Net 30")).toEqual({ terms: "Net 21", error: null });
  });

  it("0, 366, 7.5 and words keep the old terms and show the error", () => {
    for (const bad of ["0", "366", "7.5", "abc"]) {
      expect(commitCustomDays(bad, "Net 30")).toEqual({
        terms: "Net 30",
        error: "Enter a whole number of days from 1 to 365.",
      });
    }
  });

  it("an emptied box (deleting the last digit) keeps the terms and shows no error", () => {
    expect(commitCustomDays("", "Net 30")).toEqual({ terms: "Net 30", error: null });
  });
});

describe("W-1487: customDaysBlocksCreate (a bad custom box blocks create)", () => {
  it("a valid number, an empty box and an untouched box do not block", () => {
    expect(customDaysBlocksCreate("21")).toBe(false);
    expect(customDaysBlocksCreate("")).toBe(false);
    expect(customDaysBlocksCreate(undefined)).toBe(false);
  });

  it("0, 366, 7.5 and words block create, so Net 36 is never sent for a typed 366", () => {
    for (const bad of ["0", "366", "7.5", "abc"]) expect(customDaysBlocksCreate(bad)).toBe(true);
  });
});

describe("R-345 F1: Create settles the custom-days box (Expo web has no onEndEditing)", () => {
  const draft = { terms: "Net 30", dueDate: "2026-12-26" };

  it("no typed text: the draft goes as it is", () => {
    expect(settlePendingCustomTerms(undefined, draft)).toEqual({ blocked: false, ...draft });
  });

  it("a valid typed 21 that was never committed becomes Net 21 with its due date", () => {
    expect(settlePendingCustomTerms("21", draft)).toEqual({
      blocked: false,
      terms: "Net 21",
      dueDate: todayPlusDays(21),
    });
    expect(settlePendingCustomTerms(" 90 ", draft)).toEqual({
      blocked: false,
      terms: "Net 90",
      dueDate: todayPlusDays(90),
    });
  });

  it("text that equals the draft's terms keeps the draft's own due date", () => {
    expect(settlePendingCustomTerms("30", draft)).toEqual({ blocked: false, ...draft });
  });

  it.each(["0", "366", "7.5", "abc", "-3"])("an invalid %j blocks Create", (text) => {
    expect(settlePendingCustomTerms(text, draft)).toEqual({ blocked: true });
  });

  it("cleared text is no custom value: the draft goes as it is", () => {
    expect(settlePendingCustomTerms("", draft)).toEqual({ blocked: false, ...draft });
  });
});

describe("R-345 F1: the split-invoice screen wires the custom box for Expo web and NavBar Create", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "components", "SplitInvoiceScreen.tsx"),
    "utf8",
  );
  const box = src.slice(
    src.indexOf("Custom: number of days") - 900,
    src.indexOf("Custom: number of days"),
  );

  it("the custom-days box commits on blur as well as on end-editing, once per focus", () => {
    expect(box).toContain("onFocus={() => pendingCustomRef.current.add(draft.id)}");
    expect(box).toContain("onEndEditing={() => commitCustom(draft)}");
    expect(box).toContain("onBlur={() => commitCustom(draft)}");
    expect(src).toContain("if (!pendingCustomRef.current.delete(draft.id)) return;");
  });

  it("Create settles every draft's typed text before any request", () => {
    const submit = src.slice(
      src.indexOf("const submitAll = async"),
      src.indexOf("setBulkPending(true)"),
    );
    expect(submit).toContain("settleDraftsForCreate(submitable, customText)");
    const loop = src.slice(
      src.indexOf("setBulkPending(true)"),
      src.indexOf("setBulkPending(false)"),
    );
    expect(loop).toContain("for (const d of ready)");
    expect(loop).not.toContain("for (const d of submitable)");
  });
});

describe("R-345d N1/N3: Create sends the settled drafts, and a typed due date drops the custom box", () => {
  const d = (id: string, terms: string, dueDate: string) => ({ id, terms, dueDate, send: false });

  it("N1: no custom text keeps a hand-typed due date (terms cleared) as typed", () => {
    expect(settlePendingCustomTerms(undefined, { terms: "", dueDate: "2027-01-15" })).toEqual({
      blocked: false,
      terms: "",
      dueDate: "2027-01-15",
    });
  });

  it("N1: clearCustomFor drops one draft's entry and keeps the others", () => {
    expect(clearCustomFor({ a: "21", b: "45" }, "a")).toEqual({ a: undefined, b: "45" });
  });

  it("N3: over several drafts, no text goes as is and valid text takes its term and due date", () => {
    const drafts = [
      d("a", "Net 30", "2026-12-26"),
      d("b", "Net 30", "2026-12-26"),
      d("c", "", "2027-01-15"),
    ];
    const out = settleDraftsForCreate(drafts, { b: "21" });
    expect(out.blocked).toBe(false);
    if (out.blocked) return;
    expect(out.ready).toEqual([
      drafts[0],
      { ...drafts[1], terms: "Net 21", dueDate: todayPlusDays(21) },
      drafts[2],
    ]);
    expect(out.changed.map((x) => x.id)).toEqual(["b"]);
  });

  it("N3: one invalid box blocks the whole Create", () => {
    const drafts = [d("a", "Net 30", "2026-12-26"), d("b", "Net 30", "2026-12-26")];
    expect(settleDraftsForCreate(drafts, { a: "21", b: "366" })).toEqual({ blocked: true });
  });

  it("N1: the due-date box clears the draft's custom text and error before it writes the date", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "components", "SplitInvoiceScreen.tsx"),
      "utf8",
    );
    const at = src.indexOf('placeholder="YYYY-MM-DD"');
    const box = src.slice(at - 600, at);
    expect(box).toContain("setCustomText((prev) => clearCustomFor(prev, draft.id));");
    expect(box).toContain("setCustomError((prev) => clearCustomFor(prev, draft.id));");
    expect(box).toContain('updateDraft(draft.id, { dueDate: v, terms: "" });');
  });

  it("N3: submitAll writes back the changed drafts and sends settled.ready", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "components", "SplitInvoiceScreen.tsx"),
      "utf8",
    );
    const submit = src.slice(
      src.indexOf("const submitAll = async"),
      src.indexOf("setBulkPending(true)"),
    );
    expect(submit).toContain("const ready = settled.ready;");
    expect(submit).toContain(
      "for (const d of settled.changed) updateDraft(d.id, { terms: d.terms, dueDate: d.dueDate });",
    );
  });
});
