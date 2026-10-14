import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CommitEditRuleDto, EditRuleDto } from "./edit-rule.dto";

const ok = { jurisdiction: "STATE", states: ["TX"], surface: "ALL", reason: "  Legal  " };
async function errs<T extends object>(cls: new () => T, body: unknown): Promise<string[]> {
  const e = await validate(plainToInstance(cls, body) as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return e.map((x) => x.property).sort();
}

describe("EditRuleDto / CommitEditRuleDto", () => {
  it("accepts the full new settings and trims the reason", async () => {
    expect(await errs(EditRuleDto, ok)).toEqual([]);
    expect(plainToInstance(EditRuleDto, ok).reason).toBe("Legal");
  });

  it("accepts a null effectiveTo (open-ended) and refuses a non-date", async () => {
    expect(await errs(EditRuleDto, { ...ok, effectiveTo: null })).toEqual([]);
    expect(await errs(EditRuleDto, { ...ok, effectiveTo: "tomorrow" })).toEqual(["effectiveTo"]);
    expect(await errs(EditRuleDto, { ...ok, effectiveFrom: "x" })).toEqual(["effectiveFrom"]);
  });

  it("requires surface, jurisdiction and a non-empty reason (max 500); note max 500", async () => {
    expect(await errs(EditRuleDto, { ...ok, surface: undefined })).toEqual(["surface"]);
    expect(await errs(EditRuleDto, { ...ok, jurisdiction: "CITY" })).toEqual(["jurisdiction"]);
    expect(await errs(EditRuleDto, { ...ok, reason: "   " })).toEqual(["reason"]);
    expect(await errs(EditRuleDto, { ...ok, reason: "x".repeat(501) })).toEqual(["reason"]);
    expect(await errs(EditRuleDto, { ...ok, note: "x".repeat(501) })).toEqual(["note"]);
    expect(await errs(EditRuleDto, { ...ok, note: "fine" })).toEqual([]);
  });

  it("caps states like create (60 entries, 40 chars each)", async () => {
    expect(await errs(EditRuleDto, { ...ok, states: Array(61).fill("TX") })).toEqual(["states"]);
    expect(await errs(EditRuleDto, { ...ok, states: ["x".repeat(41)] })).toEqual(["states"]);
  });

  it("the commit also needs a positive integer expectedRevision and a confirmImpactHash", async () => {
    const commit = { ...ok, expectedRevision: 2, confirmImpactHash: "a".repeat(64) };
    expect(await errs(CommitEditRuleDto, commit)).toEqual([]);
    expect(await errs(CommitEditRuleDto, { ...commit, expectedRevision: 0 })).toEqual([
      "expectedRevision",
    ]);
    expect(await errs(CommitEditRuleDto, { ...commit, expectedRevision: 1.5 })).toEqual([
      "expectedRevision",
    ]);
    expect(await errs(CommitEditRuleDto, { ...commit, confirmImpactHash: undefined })).toEqual([
      "confirmImpactHash",
    ]);
    expect(await errs(CommitEditRuleDto, { ...commit, confirmImpactHash: "" })).toEqual([
      "confirmImpactHash",
    ]);
  });
});
