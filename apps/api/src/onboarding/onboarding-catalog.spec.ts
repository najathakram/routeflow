import { ONBOARDING_STAGE_VALUES } from "@routeflow/types";
import {
  AUTO_CHECK_KEYS,
  CATALOG_VERSION,
  STAGE_ORDER,
  STEPS,
  catalogStep,
  gateBlockers,
  nextStage,
  type GateStep,
} from "./onboarding-catalog";
import { AUTO_CHECKERS } from "./onboarding-auto-checks";

describe("onboarding catalog (#2159 S1)", () => {
  it("has unique step keys", () => {
    const keys = STEPS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("orders the stages exactly as the Prisma enum declares them", () => {
    expect([...STAGE_ORDER]).toEqual([...ONBOARDING_STAGE_VALUES]);
  });

  it("gives every stage at least one REQUIRED step, so no gate is vacuous", () => {
    for (const stage of STAGE_ORDER) {
      expect(STEPS.some((s) => s.stage === stage && s.required)).toBe(true);
    }
  });

  it("keeps each stage's steps contiguous, in stage order (the checklist reads top to bottom)", () => {
    const idx = STEPS.map((s) => STAGE_ORDER.indexOf(s.stage));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it("wires every autoCheck to a real checker, and every checker to a step", () => {
    for (const s of STEPS.filter((x) => x.autoCheck)) {
      expect(AUTO_CHECKERS[s.autoCheck!]).toEqual(expect.any(Function));
    }
    expect(Object.keys(AUTO_CHECKERS).sort()).toEqual([...AUTO_CHECK_KEYS].sort());
    const used = new Set(STEPS.map((s) => s.autoCheck).filter(Boolean));
    expect([...used].sort()).toEqual([...AUTO_CHECK_KEYS].sort());
  });

  it("carries a non-blank title and evidence hint on every step", () => {
    for (const s of STEPS) {
      expect(s.title.trim()).not.toBe("");
      expect(s.evidenceHint.trim()).not.toBe("");
    }
  });

  it("is at version 1 (bump when a key is added)", () => {
    expect(CATALOG_VERSION).toBe(1);
  });

  it("looks steps up by key", () => {
    expect(catalogStep("activate.paid")?.stage).toBe("ACTIVATE");
    expect(catalogStep("nope")).toBeUndefined();
  });

  it("advances strictly one stage at a time and ends after HYPERCARE", () => {
    expect(nextStage("FOLLOW_UP")).toBe("AGREE");
    expect(nextStage("GO_LIVE")).toBe("HYPERCARE");
    expect(nextStage("HYPERCARE")).toBeNull();
  });
});

describe("gateBlockers", () => {
  const rows: GateStep[] = [
    { key: "a", stage: "AGREE", title: "A", required: true, status: "PENDING" },
    { key: "b", stage: "AGREE", title: "B", required: true, status: "DONE" },
    { key: "c", stage: "AGREE", title: "C", required: true, status: "WAIVED" },
    { key: "d", stage: "AGREE", title: "D", required: false, status: "PENDING" },
    { key: "e", stage: "ACTIVATE", title: "E", required: true, status: "PENDING" },
  ];

  it("lists only the current stage's required PENDING steps", () => {
    expect(gateBlockers(rows, "AGREE")).toEqual([{ key: "a", title: "A" }]);
  });

  it("treats WAIVED like DONE and never counts optional or later-stage steps", () => {
    const cleared = rows.map((r) => (r.key === "a" ? { ...r, status: "DONE" as const } : r));
    expect(gateBlockers(cleared, "AGREE")).toEqual([]);
  });
});
