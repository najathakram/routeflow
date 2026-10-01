import { exportErrorMessage, exportTailWarning, isoDay } from "./csv-export-request";

const blobOf = (s: string) => new Blob([s], { type: "application/json" });

describe("exportErrorMessage", () => {
  it("reads the server message out of a Blob error body (responseType blob)", async () => {
    const err = {
      message: "Request failed with status code 400",
      response: { status: 400, data: blobOf(JSON.stringify({ message: "from must be a date" })) },
    };
    await expect(exportErrorMessage(err)).resolves.toBe("from must be a date");
  });

  it("shows a fixed friendly line, never the raw client error, when the Blob is not JSON", async () => {
    const err = {
      message: "Request failed with status code 403",
      response: { status: 403, data: blobOf("<html>nope</html>") },
    };
    await expect(exportErrorMessage(err)).resolves.toBe(
      "The export failed. Please try again or contact support.",
    );
  });

  it("still handles plain-object bodies, the 429 line and a bare error", async () => {
    await expect(
      exportErrorMessage({ response: { status: 500, data: { message: "db down" } } }),
    ).resolves.toBe("db down");
    await expect(exportErrorMessage({ response: { status: 429 } })).resolves.toMatch(
      /try again in a minute/i,
    );
    await expect(exportErrorMessage({ message: "boom" })).resolves.toBe("boom");
    await expect(exportErrorMessage({})).resolves.toMatch(/try again/i);
  });
});

describe("exportTailWarning", () => {
  it("flags a file that ends with the export-failed line", async () => {
    const b = new Blob(["Name\r\nA\r\n# export failed: the file is incomplete\r\n"]);
    await expect(exportTailWarning(b)).resolves.toBe(true);
  });

  it("flags a file that ends with the truncation row", async () => {
    const b = new Blob(["Name\r\nA\r\n# truncated at 3 rows\r\n"]);
    await expect(exportTailWarning(b)).resolves.toBe(true);
  });

  it("does not flag a complete file, even one with '# ...' earlier or in a cell", async () => {
    const b = new Blob(["Name\r\n# export failed\r\n"].concat(["x".repeat(2000), "\r\nB\r\n"]));
    await expect(exportTailWarning(b)).resolves.toBe(false);
    await expect(exportTailWarning(new Blob(["Name\r\nA\r\n"]))).resolves.toBe(false);
  });
});

describe("isoDay", () => {
  it("is UTC today minus N days", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-29T12:00:00Z"));
    expect(isoDay(0)).toBe("2026-09-29");
    expect(isoDay(6)).toBe("2026-09-23");
    jest.useRealTimers();
  });
});
