import { judgeOfflineDrift, type ServerLine } from "./offline-drift";

const server = (over: Partial<ServerLine> = {}): ServerLine => ({
  productId: "p1",
  unitPrice: 12,
  unitsPerBox: null,
  unitLabel: null,
  override: false,
  ...over,
});
const q = (index: number, unitPrice: number, extra: object = {}) => ({
  index,
  unitPrice,
  unitsPerBox: null,
  unitLabel: null,
  ...extra,
});

describe("judgeOfflineDrift (SA-1124 item 7)", () => {
  it("the same prices and total: nothing", () => {
    expect(judgeOfflineDrift([server()], 13.2, { total: 13.2, lines: [q(0, 12)] })).toEqual([]);
  });

  it("a one-cent move on a line flags that line with shown and now", () => {
    expect(judgeOfflineDrift([server()], 12, { total: 11.99, lines: [q(0, 11.99)] })).toEqual([
      { kind: "LINE", lineIndex: 0, productId: "p1", shown: 11.99, now: 12 },
    ]);
  });

  it("works in whole cents: a server price that rounds to the shown cent is no drift", () => {
    const flat = judgeOfflineDrift([server({ unitPrice: 12.004 })], 12, {
      total: 12,
      lines: [q(0, 12)],
    });
    expect(flat).toEqual([]);
    const moved = judgeOfflineDrift([server({ unitPrice: 12.006 })], 12.01, {
      total: 12.01,
      lines: [q(0, 12)],
    });
    expect(moved).toHaveLength(1);
  });

  it("a staff-typed override line is judged as online and never flagged for price or unit", () => {
    const lines = [q(0, 10, { unitsPerBox: 24, unitLabel: "Case" })];
    expect(judgeOfflineDrift([server({ override: true })], 12, { total: 12, lines })).toEqual([]);
  });

  it("a changed pack or unit label raises the same kind with unitChanged, even at the same price", () => {
    const out = judgeOfflineDrift([server()], 12, {
      total: 12,
      lines: [q(0, 12, { unitsPerBox: 24, unitLabel: "Case" })],
    });
    expect(out).toEqual([
      { kind: "LINE", lineIndex: 0, productId: "p1", shown: 12, now: 12, unitChanged: true },
    ]);
  });

  it("S1: a qty-sold line (server pack snapshot null) whose quote sends the product's pack size gets no flag", () => {
    const lines = [q(0, 12, { unitsPerBox: 24 })];
    expect(judgeOfflineDrift([server()], 12, { total: 12, lines })).toEqual([]);
  });

  it("S1: a box-split line compares the pack: the same pack is no drift, another pack or none is", () => {
    const s = server({ unitsPerBox: 24 });
    const same = { total: 12, lines: [q(0, 12, { unitsPerBox: 24 })] };
    expect(judgeOfflineDrift([s], 12, same)).toEqual([]);
    for (const unitsPerBox of [12, null]) {
      const out = judgeOfflineDrift([s], 12, { total: 12, lines: [q(0, 12, { unitsPerBox })] });
      expect(out).toEqual([
        { kind: "LINE", lineIndex: 0, productId: "p1", shown: 12, now: 12, unitChanged: true },
      ]);
    }
  });

  it("S1: a null and an empty unit label are the same label", () => {
    const empty = { total: 12, lines: [q(0, 12, { unitLabel: "" })] };
    expect(judgeOfflineDrift([server()], 12, empty)).toEqual([]);
    const none = { total: 12, lines: [q(0, 12)] };
    expect(judgeOfflineDrift([server({ unitLabel: "" })], 12, none)).toEqual([]);
  });

  it("unit labels compare case- and space-insensitively", () => {
    const s = server({ unitLabel: "Case", unitsPerBox: 24 });
    const lines = [q(0, 12, { unitLabel: " case ", unitsPerBox: 24 })];
    expect(judgeOfflineDrift([s], 12, { total: 12, lines })).toEqual([]);
  });

  it("no line flagged but the total moved (tax or a promotion): one order-level finding", () => {
    expect(judgeOfflineDrift([server()], 13.2, { total: 13.7, lines: [q(0, 12)] })).toEqual([
      { kind: "TOTAL", shownTotal: 13.7, nowTotal: 13.2 },
    ]);
  });

  it("a flagged line suppresses the order-level total finding", () => {
    const out = judgeOfflineDrift([server()], 13.2, { total: 11, lines: [q(0, 10)] });
    expect(out.map((f) => f.kind)).toEqual(["LINE"]);
  });

  it("a quote line past the server's lines is ignored, never a throw", () => {
    const lines = [q(0, 12), q(5, 99)];
    expect(judgeOfflineDrift([server()], 12, { total: 12, lines })).toEqual([]);
  });

  it("only the lines that moved are flagged", () => {
    const out = judgeOfflineDrift([server(), server({ productId: "p2", unitPrice: 5 })], 17, {
      total: 17,
      lines: [q(0, 12), q(1, 4)],
    });
    expect(out).toEqual([{ kind: "LINE", lineIndex: 1, productId: "p2", shown: 4, now: 5 }]);
  });
});
