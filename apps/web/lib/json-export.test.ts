import { downloadJsonFile, jsonExportFilename } from "./json-export";

describe("jsonExportFilename", () => {
  it("prefers the Content-Disposition filename", () => {
    expect(jsonExportFilename("billing", 'attachment; filename="acme-billing.json"')).toBe(
      "acme-billing.json",
    );
  });
  it("falls back to prefix-YYYY-MM-DD.json (UTC day)", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-30T23:59:00Z"));
    expect(jsonExportFilename("billing", undefined)).toBe("billing-2026-09-30.json");
    expect(jsonExportFilename("billing", 42)).toBe("billing-2026-09-30.json");
    jest.useRealTimers();
  });
});

describe("downloadJsonFile", () => {
  it("saves pretty-printed JSON as an application/json blob under the filename", async () => {
    const created: Blob[] = [];
    const click = jest.fn();
    const anchor = { click, href: "", download: "" } as unknown as HTMLAnchorElement;
    jest.spyOn(document, "createElement").mockReturnValueOnce(anchor);
    (URL as any).createObjectURL = jest.fn((b: Blob) => (created.push(b), "blob:x"));
    (URL as any).revokeObjectURL = jest.fn();
    downloadJsonFile("b.json", { a: 1, nested: { b: [2] } });
    expect(anchor.download).toBe("b.json");
    expect(click).toHaveBeenCalled();
    expect(created[0].type).toBe("application/json");
    const text = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.readAsText(created[0]);
    });
    expect(JSON.parse(text)).toEqual({ a: 1, nested: { b: [2] } });
    expect(text).toContain("\n  ");
    jest.restoreAllMocks();
  });
});
