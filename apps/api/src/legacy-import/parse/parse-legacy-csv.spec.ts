import { collectLegacyCsv, parseLegacyCsv } from "./parse-legacy-csv";
import { buildSyntheticSalesFile } from "../testing/synthetic-sales-file";

// T2 (SA-1295): quoted LF inside a field, CRLF record ends, one short row.
describe("streamed parser (T2)", () => {
  it("keeps a quoted bare LF inside one field and ends records on CRLF", async () => {
    const out = await collectLegacyCsv(
      Buffer.from('a,b,c\r\n1,"line one\nline two\nline three",x\r\n2,y,z\r\n'),
    );
    expect(out.records).toHaveLength(2);
    expect(out.records[0].cells[1]).toBe("line one\nline two\nline three");
    expect(out.issues).toEqual([]);
  });

  it("turns a short row into a row error and does NOT fill it", async () => {
    const out = await collectLegacyCsv(Buffer.from("a,b,c\r\n1,2,3\r\n4,5\r\n6,7,8\r\n"));
    expect(out.records.map((r) => r.cells[0])).toEqual(["1", "6"]);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]).toMatchObject({
      severity: "ERROR",
      code: "ROW_SHORT",
      physicalLine: 3,
      recordNo: 3,
    });
  });

  it("names the dropped row's document number on the issue when the first cell has one", async () => {
    const out = await collectLegacyCsv(Buffer.from("a,b,c\r\n 1001 ,2\r\n2002,5,6,7\r\n,8\r\n"));
    expect(out.issues.map((i) => [i.code, i.sourceDocKey])).toEqual([
      ["ROW_SHORT", "1001"],
      ["ROW_LONG", "2002"],
      ["ROW_SHORT", undefined],
    ]);
  });

  it("reports the right physical line after a skipped blank line (R-176 F4)", async () => {
    const out = await collectLegacyCsv(Buffer.from("a,b\r\n1,2\r\n\r\n3,4,5\r\n\r\n6,7\r\n"));
    expect(out.records.map((r) => [r.cells[0], r.physicalLine, r.recordNo])).toEqual([
      ["1", 2, 2],
      ["6", 6, 4],
    ]);
    expect(out.issues[0]).toMatchObject({ code: "ROW_LONG", physicalLine: 4, recordNo: 3 });
  });

  it("turns a long row into a row error too", async () => {
    const out = await collectLegacyCsv(Buffer.from("a,b\r\n1,2,3\r\n4,5\r\n"));
    expect(out.records).toHaveLength(1);
    expect(out.issues[0]).toMatchObject({ code: "ROW_LONG", physicalLine: 2 });
  });

  it("reads the synthetic twin of the sample's shape: 169 good records plus one row error", async () => {
    const twin = buildSyntheticSalesFile({ withShortRow: true });
    const out = await collectLegacyCsv(twin.bytes);
    expect(out.headers).toHaveLength(9);
    expect(out.records).toHaveLength(169);
    expect(out.issues.filter((i) => i.code === "ROW_SHORT")).toHaveLength(1);
    expect(out.issues.find((i) => i.code === "ROW_SHORT")?.physicalLine).toBe(
      twin.shortRowPhysicalLine,
    );
    expect(out.issues.filter((i) => i.code === "LEADING_BYTE_STRIPPED")).toHaveLength(1);
  });

  it("reads all 170 records when no row is short, with 25 multi-line descriptions intact", async () => {
    const twin = buildSyntheticSalesFile({ withShortRow: false });
    const out = await collectLegacyCsv(twin.bytes);
    expect(out.records).toHaveLength(170);
    expect(out.records.filter((r) => r.cells[4].includes("\n"))).toHaveLength(25);
    expect(out.records.filter((r) => r.cells[4].includes("—"))).toHaveLength(4);
  });

  it("fails loud on a malformed quote, never as a silent empty result", async () => {
    await expect(collectLegacyCsv(Buffer.from('a,b\r\n1,"unterminated\r\n'))).rejects.toMatchObject(
      { code: "CSV_SYNTAX" },
    );
  });

  it("streams: yields the header event before the records", async () => {
    const events: string[] = [];
    for await (const ev of parseLegacyCsv(Buffer.from("a,b\r\n1,2\r\n"))) events.push(ev.type);
    expect(events).toEqual(["header", "record"]);
  });
});
