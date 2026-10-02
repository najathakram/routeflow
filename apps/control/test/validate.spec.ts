/**
 * T1-T4 (R1, R5) — `validateEvents` over the synthetic acme state tree.
 *
 * Contract under test (src/domain/validate.ts):
 *   validateEvents(files: {file: string; text: string}[],
 *                  ctx: {taskIds: string[]; releaseIds: string[]}) -> {file, line, reason}[]
 *   - `file` is the events file name (`<lane>.jsonl`; the basename minus `.jsonl` is the file lane)
 *   - `line` is 1-based; `ctx` carries the register-side ids (F-, B, D- tasks and releases);
 *     RF- tasks, lanes and aliases come from the events themselves.
 */
import * as fs from "fs";
import * as path from "path";

function tryRequire(load: () => unknown): any {
  try {
    return load();
  } catch (e: any) {
    if (e && e.code === "MODULE_NOT_FOUND") return undefined;
    throw e;
  }
}
const mod = tryRequire(() => require("../src/domain/validate"));

const FIX = path.join(__dirname, "fixtures", "acme");
type F = { file: string; text: string };

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

function fixtureFiles(): F[] {
  const dir = path.join(FIX, "state", "events");
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .sort()
    .map((n) => ({ file: n, text: fs.readFileSync(path.join(dir, n), "utf8") }));
}

const lines = (f: F) => f.text.split("\n").filter(Boolean);
const last = (f: F) => JSON.parse(lines(f)[lines(f).length - 1]);
const put = (files: F[], name: string, fn: (ls: string[]) => string[]): F[] =>
  files.map((f) => (f.file === name ? { ...f, text: fn(lines(f)).join("\n") + "\n" } : f));
/** Append a valid-looking next line (seq = last+1, ts = last ts + 1 min) to `name`. */
const append = (files: F[], name: string, body: Record<string, unknown>): F[] => {
  const f = files.find((x) => x.file === name)!;
  const prev = last(f);
  const laneId = name.replace(/\.jsonl$/, "");
  const ts = new Date(Date.parse(prev.ts) + 60_000).toISOString().replace(".000Z", "Z");
  const line = JSON.stringify({ seq: prev.seq + 1, ts, lane: laneId, by: "agent", ...body });
  return put(files, name, (ls) => [...ls, line]);
};
const need = () => {
  expect(mod).toBeDefined();
  expect(typeof mod.validateEvents).toBe("function");
  return mod.validateEvents as (files: F[], c: ReturnType<typeof ctx>) => any[];
};

describe("validateEvents on the acme tree (T1)", () => {
  it("returns [] for the valid fixture (incl. the seq-0 segment header on owner.jsonl)", () => {
    const validate = need();
    expect(validate(fixtureFiles(), ctx())).toEqual([]);
  });
});

describe("validateEvents corruptions (T2): exactly one error naming file:line + reason", () => {
  const longNote = "x".repeat(1100);
  // name, target file, 1-based line of the error, reason keyword, corruption
  const CASES: [string, string, number, RegExp, (f: F[]) => F[]][] = [
    [
      "invalid JSON",
      "lane-b.jsonl",
      5,
      /invalid json/i,
      (f) => put(f, "lane-b.jsonl", (l) => [...l, "{not json"]),
    ],
    [
      "unknown type",
      "lane-b.jsonl",
      4,
      /unknown type/i,
      (f) =>
        put(f, "lane-b.jsonl", (l) => [
          ...l.slice(0, -1),
          JSON.stringify({ ...JSON.parse(l[l.length - 1]), type: "lane.shout" }),
        ]),
    ],
    [
      "extra key",
      "lane-b.jsonl",
      4,
      /extra key/i,
      (f) =>
        put(f, "lane-b.jsonl", (l) => [
          ...l.slice(0, -1),
          JSON.stringify({ ...JSON.parse(l[l.length - 1]), bogus: 1 }),
        ]),
    ],
    [
      "missing key",
      "lane-b.jsonl",
      4,
      /missing/i,
      (f) =>
        put(f, "lane-b.jsonl", (l) => {
          const o = JSON.parse(l[l.length - 1]);
          delete o.note;
          return [...l.slice(0, -1), JSON.stringify(o)];
        }),
    ],
    [
      "seq gap",
      "lane-b.jsonl",
      4,
      /seq/i,
      (f) =>
        put(f, "lane-b.jsonl", (l) => [
          ...l.slice(0, -1),
          JSON.stringify({ ...JSON.parse(l[l.length - 1]), seq: 5 }),
        ]),
    ],
    [
      "seq duplicate",
      "lane-b.jsonl",
      4,
      /seq/i,
      (f) =>
        put(f, "lane-b.jsonl", (l) => [
          ...l.slice(0, -1),
          JSON.stringify({ ...JSON.parse(l[l.length - 1]), seq: 3 }),
        ]),
    ],
    [
      "ts decrease",
      "lane-b.jsonl",
      4,
      /\bts\b|timestamp/i,
      (f) =>
        put(f, "lane-b.jsonl", (l) => [
          ...l.slice(0, -1),
          JSON.stringify({ ...JSON.parse(l[l.length - 1]), ts: "2026-01-10T09:00:00Z" }),
        ]),
    ],
    [
      "lane mismatch",
      "lane-b.jsonl",
      4,
      /lane mismatch/i,
      (f) =>
        put(f, "lane-b.jsonl", (l) => [
          ...l.slice(0, -1),
          JSON.stringify({ ...JSON.parse(l[l.length - 1]), lane: "lane-u" }),
        ]),
    ],
    [
      "unregistered lane",
      "ghost.jsonl",
      1,
      /unregistered lane/i,
      (f) => [
        ...f,
        {
          file: "ghost.jsonl",
          text:
            JSON.stringify({
              seq: 1,
              ts: "2026-01-10T12:00:00Z",
              lane: "ghost",
              type: "lane.note",
              by: "agent",
              note: "hi",
            }) + "\n",
        },
      ],
    ],
    [
      "dangling task",
      "lane-u.jsonl",
      5,
      /dangling task/i,
      (f) => append(f, "lane-u.jsonl", { type: "task.progress", task: "RF-404", phase: "qa" }),
    ],
    [
      "dangling release",
      "owner.jsonl",
      5,
      /dangling release/i,
      (f) =>
        append(f, "owner.jsonl", {
          type: "task.release",
          task: "F-01",
          release: "R9",
          prev: "R3",
          by: "owner",
        }),
    ],
    [
      "glob with ..",
      "owner.jsonl",
      5,
      /unsafe glob|\.\./i,
      (f) =>
        append(f, "owner.jsonl", {
          type: "task.areas",
          task: "RF-1",
          areas: ["apps/../secrets/**"],
          by: "owner",
        }),
    ],
    [
      "line > 1024 bytes",
      "lane-b.jsonl",
      5,
      /1,?024/,
      (f) => append(f, "lane-b.jsonl", { type: "lane.note", note: longNote }),
    ],
  ];

  it("has 13 corruption cases", () => {
    expect(CASES).toHaveLength(13);
  });

  it.each(CASES)("%s", (_name, file, line, reason, corrupt) => {
    const validate = need();
    const errors = validate(corrupt(fixtureFiles()), ctx());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file, line });
    expect(errors[0].reason).toMatch(reason);
  });

  it("a backslash in a glob is an error too", () => {
    const validate = need();
    const errors = validate(
      append(fixtureFiles(), "owner.jsonl", {
        type: "task.areas",
        task: "RF-1",
        areas: ["apps\\api\\**"],
        by: "owner",
      }),
      ctx(),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: "owner.jsonl", line: 5 });
    expect(errors[0].reason).toMatch(/unsafe glob|backslash/i);
  });

  it("a duplicate RF- mint is an error", () => {
    const validate = need();
    const errors = validate(
      append(fixtureFiles(), "lead.jsonl", {
        type: "task.created",
        id: "RF-1",
        title: "acme: duplicate mint",
        kind: "chore",
      }),
      ctx(),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: "lead.jsonl", line: 9 });
    expect(errors[0].reason).toMatch(/duplicate/i);
  });
});

describe("validateEvents transitions (T3)", () => {
  it("task.done on a never-started planned task -> illegal transition planned→done", () => {
    const validate = need();
    const errors = validate(
      append(fixtureFiles(), "lane-b.jsonl", { type: "task.done", task: "F-03" }),
      ctx(),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: "lane-b.jsonl", line: 5 });
    expect(errors[0].reason).toMatch(/illegal transition planned→done/);
  });
});

describe("validateEvents emitters (T4)", () => {
  it("task.created from lane-u -> unauthorised emitter", () => {
    const validate = need();
    const errors = validate(
      append(fixtureFiles(), "lane-u.jsonl", {
        type: "task.created",
        id: "RF-50",
        title: "acme: sneaky mint",
        kind: "chore",
      }),
      ctx(),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: "lane-u.jsonl", line: 5 });
    expect(errors[0].reason).toMatch(/unauthori[sz]ed emitter/i);
  });
});
