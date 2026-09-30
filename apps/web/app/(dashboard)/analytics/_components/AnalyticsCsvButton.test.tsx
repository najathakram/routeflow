import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { AnalyticsCsvButton } from "./AnalyticsCsvButton";

let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { role: mockRole } }),
}));

const ROW = { id: "1", name: "=cmd", totalRevenue: 12.5, unitsSold: 3 };
const RANGE = { from: "2026-01-01", to: "2026-01-31" };

let blobs: Blob[] = [];
let anchors: string[] = [];
beforeEach(() => {
  mockRole = "OPERATOR";
  blobs = [];
  anchors = [];
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
    blobs.push(b);
    return "blob:x";
  };
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    anchors.push(this.download);
  });
});
afterEach(() => jest.restoreAllMocks());

function readBlob(b: Blob): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsText(b);
  });
}

function readBytes(b: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.readAsArrayBuffer(b);
  });
}

describe("AnalyticsCsvButton", () => {
  it.each(["DRIVER", "CUSTOMER"])("renders nothing for %s", (role) => {
    mockRole = role;
    render(<AnalyticsCsvButton slug="top-products" data={[ROW]} {...RANGE} />);
    expect(screen.queryByTestId("analytics-csv-top-products")).toBeNull();
  });

  it.each(["OPERATOR", "TENANT_ADMIN"])("is enabled for %s once data has loaded", (role) => {
    mockRole = role;
    render(<AnalyticsCsvButton slug="top-products" data={[ROW]} {...RANGE} />);
    expect(screen.getByTestId("analytics-csv-top-products")).toBeEnabled();
  });

  it("is hidden while loading", () => {
    render(<AnalyticsCsvButton slug="top-products" data={[]} loading {...RANGE} />);
    expect(screen.queryByTestId("analytics-csv-top-products")).toBeNull();
  });

  it("is disabled with a Nothing to export tooltip when empty", () => {
    render(<AnalyticsCsvButton slug="top-products" data={[]} {...RANGE} />);
    const btn = screen.getByTestId("analytics-csv-top-products");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "Nothing to export");
  });

  it("treats a null scalar (aov) as empty", () => {
    render(<AnalyticsCsvButton slug="aov" data={null} {...RANGE} />);
    expect(screen.getByTestId("analytics-csv-aov")).toBeDisabled();
  });

  it("downloads analytics-<slug>-<from>-to-<to>.csv with BOM, header and a guarded name", async () => {
    render(<AnalyticsCsvButton slug="top-products" data={[ROW]} {...RANGE} />);
    fireEvent.click(screen.getByTestId("analytics-csv-top-products"));
    expect(anchors).toEqual(["analytics-top-products-2026-01-01-to-2026-01-31.csv"]);
    const bytes = new Uint8Array(await readBytes(blobs[0]));
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = (await readBlob(blobs[0])).split("\r\n"); // decoding drops the BOM
    expect(lines[0]).toBe("Product,Revenue,Units sold");
    expect(lines[1]).toBe("'=cmd,12.5,3");
  });
});
