import { csvFilename, downloadCsv, downloadCsvBlob } from "./export";

function captureBlob(): { get: () => Blob } {
  let blob: Blob | undefined;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
    blob = b;
    return "blob:x";
  };
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return { get: () => blob as Blob };
}

const readText = (b: Blob) =>
  new Promise<string>((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.readAsText(b, "utf-8");
  });
const readBytes = (b: Blob) =>
  new Promise<Uint8Array>((res) => {
    const r = new FileReader();
    r.onload = () => res(new Uint8Array(r.result as ArrayBuffer));
    r.readAsArrayBuffer(b);
  });

describe("downloadCsv", () => {
  afterEach(() => jest.restoreAllMocks());

  it("starts with a UTF-8 BOM", async () => {
    const cap = captureBlob();
    downloadCsv("a.csv", ["h"], [["x"]]);
    const bytes = await readBytes(cap.get());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("neutralises formula leads on strings, never on numbers/booleans", async () => {
    const cap = captureBlob();
    downloadCsv("a.csv", ["h"], [["=1+1"], ["+x"], ["-x"], ["@x"], ["\tx"], [-5], [true], [null]]);
    const text = (await readText(cap.get())).replace(/^﻿/, "");
    const lines = text.split("\r\n");
    expect(lines.slice(1, 5)).toEqual(["'=1+1", "'+x", "'-x", "'@x"]);
    expect(lines[5]).toBe("'\tx");
    expect(lines[6]).toBe("-5");
    expect(lines[7]).toBe("true");
    expect(lines[8]).toBe("");
  });

  it("leaves numeric-looking strings alone (toFixed money) but still prefixes real leads", async () => {
    const cap = captureBlob();
    downloadCsv("a.csv", ["h"], [["-12.50"], ["+3"], ["7.00"], ["-cmd|' /C calc'!A0"], ["-1.2.3"]]);
    const text = (await readText(cap.get())).replace(/^﻿/, "");
    expect(text.split("\r\n").slice(1)).toEqual([
      "-12.50",
      "+3",
      "7.00",
      "'-cmd|' /C calc'!A0",
      "'-1.2.3",
    ]);
  });

  it("neutralises the full-width formula leads exactly like the server", async () => {
    const cap = captureBlob();
    downloadCsv("a.csv", ["h"], [["＝1"], ["＋1"], ["－1"], ["＠x"], ["\nx"]]);
    const text = (await readText(cap.get())).replace(/^﻿/, "");
    expect(text.split("\r\n").slice(1, 5)).toEqual(["'＝1", "'＋1", "'－1", "'＠x"]);
    expect(text).toContain('"\'\nx"');
  });

  it("still escapes commas, quotes and newlines", async () => {
    const cap = captureBlob();
    downloadCsv("a.csv", ["h,1"], [['a "b"'], ["l1\nl2"]]);
    const text = (await readText(cap.get())).replace(/^﻿/, "");
    expect(text).toBe('"h,1"\r\n"a ""b"""\r\n"l1\nl2"');
  });
});

describe("csvFilename", () => {
  it("uses a single day when no range, a range otherwise", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-29T12:00:00Z"));
    expect(csvFilename("products")).toBe("products-2026-09-29.csv");
    expect(csvFilename("sales", "2026-07-01", "2026-07-31")).toBe(
      "sales-2026-07-01-to-2026-07-31.csv",
    );
    jest.useRealTimers();
  });
});

describe("downloadCsvBlob", () => {
  it("clicks an anchor with the filename and revokes the URL", () => {
    const cap = captureBlob();
    const click = HTMLAnchorElement.prototype.click as jest.Mock;
    const b = new Blob(["x"]);
    downloadCsvBlob("f.csv", b);
    expect(cap.get()).toBe(b);
    expect(click).toHaveBeenCalledTimes(1);
  });
});
