/** WP7 round: schema fix (task.priority accepts a missing/null prev for a task with no priority). */
import * as fs from "fs";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-explicit-any */
const V: any = require("../src/domain/validate");
const FIX = path.join(__dirname, "fixtures", "acme");
const readJsonl = (rel: string): any[] =>
  fs
    .readFileSync(path.join(FIX, rel), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const ctx = () => ({
  taskIds: [
    ...readJsonl("registers/features.jsonl"),
    ...readJsonl("registers/bugs.jsonl"),
    ...readJsonl("registers/deferred.jsonl"),
  ].map((r) => r.id as string),
  releaseIds: readJsonl("registers/releases.jsonl").map((r) => r.id as string),
});
const files = (): Array<{ file: string; text: string }> => {
  const dir = path.join(FIX, "state", "events");
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .sort()
    .map((n) => ({ file: n, text: fs.readFileSync(path.join(dir, n), "utf8") }));
};
const withOwnerLine = (body: Record<string, unknown>) =>
  files().map((f) => {
    if (f.file !== "owner.jsonl") return f;
    const ls = f.text.split("\n").filter(Boolean);
    const last = JSON.parse(ls[ls.length - 1]);
    const ts = new Date(Date.parse(last.ts) + 60_000).toISOString().replace(".000Z", "Z");
    const line = JSON.stringify({
      seq: last.seq + 1,
      ts,
      lane: "owner",
      by: "owner",
      type: "task.priority",
      task: "RF-3",
      priority: "P1",
      ...body,
    });
    return { ...f, text: [...ls, line].join("\n") + "\n" };
  });

describe("task.priority: a first priority has no prev", () => {
  it("prev omitted is valid", () => {
    expect(V.validateEvents(withOwnerLine({}), ctx())).toEqual([]);
  });
  it("prev null is valid", () => {
    expect(V.validateEvents(withOwnerLine({ prev: null }), ctx())).toEqual([]);
  });
  it("a real prev still validates, and a bad prev is still refused", () => {
    expect(V.validateEvents(withOwnerLine({ prev: "P2" }), ctx())).toEqual([]);
    expect(V.validateEvents(withOwnerLine({ prev: "P9" }), ctx()).length).toBeGreaterThan(0);
  });
});
