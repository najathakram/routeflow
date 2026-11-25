import { Readable } from "node:stream";
import { collectLegacyCsv } from "./parse-legacy-csv";

const EM_DASH = "—";

function bytes(text: string, lead: number[] = []): Buffer {
  return Buffer.concat([Buffer.from(lead), Buffer.from(text, "utf8")]);
}

// T1 (SA-1295): a lone leading 0xA0 glued to the first header cell, valid UTF-8 elsewhere.
describe("decoder (T1 leading 0xA0)", () => {
  const body =
    `Invoice Number,Customer Name,Item Name\r\n` + `1001,Acme Foods,Widget ${EM_DASH} large\r\n`;

  it("reads the first header key as 'Invoice Number', keeps the em dash, reports one issue", async () => {
    const out = await collectLegacyCsv(bytes(body, [0xa0]));
    expect(out.headers[0]).toBe("Invoice Number");
    expect(out.records[0].cells[2]).toBe(`Widget ${EM_DASH} large`);
    const issues = out.issues.filter((i) => i.code === "LEADING_BYTE_STRIPPED");
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("WARNING");
  });

  it("strips a UTF-8 BOM silently", async () => {
    const out = await collectLegacyCsv(bytes(body, [0xef, 0xbb, 0xbf]));
    expect(out.headers[0]).toBe("Invoice Number");
    expect(out.issues).toEqual([]);
  });

  it("trims header keys", async () => {
    const out = await collectLegacyCsv(bytes(" Invoice Number , Customer Name \r\n1,a\r\n"));
    expect(out.headers).toEqual(["Invoice Number", "Customer Name"]);
  });

  it("is chunk-boundary safe: a multi-byte character split across chunks decodes intact", async () => {
    const all = bytes(body, [0xa0]);
    const cut = all.indexOf(0xe2) + 1; // inside the 3-byte em dash
    const stream = Readable.from([all.subarray(0, cut), all.subarray(cut)]);
    const out = await collectLegacyCsv(stream);
    expect(out.records[0].cells[2]).toBe(`Widget ${EM_DASH} large`);
  });

  it("fails loud on invalid UTF-8 elsewhere instead of garbling", async () => {
    const bad = Buffer.concat([
      Buffer.from("a,b\r\n1,"),
      Buffer.from([0xff, 0xfe]),
      Buffer.from("\r\n"),
    ]);
    await expect(collectLegacyCsv(bad)).rejects.toMatchObject({ code: "INVALID_UTF8" });
  });

  it("decodes as Windows-1252 only when the caller asks for it", async () => {
    const cp = Buffer.concat([
      Buffer.from("a,b\r\n1,caf"),
      Buffer.from([0xe9]),
      Buffer.from("\r\n"),
    ]);
    const out = await collectLegacyCsv(cp, { encoding: "windows-1252" });
    expect(out.records[0].cells[1]).toBe("café");
  });
});
