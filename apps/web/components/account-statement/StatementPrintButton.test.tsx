import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { StatementPrintButton } from "./StatementPrintButton";

/**
 * SA-1078 W-1096 PR-3: PD6 (desktop Print) and PD7 (touch: Print or share, then Open PDF).
 */

const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a) },
}));
const mockFetchBlob = jest.fn();
jest.mock("@/lib/fetch-pdf-blob", () => ({
  fetchPdfBlob: (...a: unknown[]) => mockFetchBlob(...a),
}));
const mockPrint = jest.fn();
jest.mock("@/lib/print-pdf-blob", () => ({ printPdfBlob: (...a: unknown[]) => mockPrint(...a) }));
let mockShell = false;
jest.mock("@/lib/in-shell", () => ({ isInShell: () => mockShell }));

const SIGNED = "https://files.example.test/statement-pdfs/c1/current.pdf?sig=abc";

function setCoarse(on: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: on && q === "(pointer: coarse)",
    media: q,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    onchange: null,
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  mockShell = false;
  setCoarse(false);
  mockGet.mockReset();
  mockGet.mockResolvedValue({ data: { url: SIGNED } });
  mockFetchBlob.mockReset();
  mockFetchBlob.mockResolvedValue(new Blob(["%PDF"], { type: "application/pdf" }));
  mockPrint.mockReset();
});

describe("PD6: desktop Print", () => {
  it("fetches this customer's statement PDF and hands its bytes to printPdfBlob", async () => {
    const user = userEvent.setup();
    renderWithProviders(<StatementPrintButton customerId="c1" />);
    await user.click(screen.getByRole("button", { name: "Print" }));
    await waitFor(() => expect(mockPrint).toHaveBeenCalledTimes(1));
    expect(mockGet).toHaveBeenCalledWith("/customers/c1/account-statement/pdf");
    expect(mockFetchBlob).toHaveBeenCalledWith(SIGNED, expect.anything());
    expect(mockPrint.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(screen.queryByTestId("statement-open-pdf")).toBeNull();
  });

  it("a failed render shows a toast, and the button is usable again", async () => {
    mockGet.mockRejectedValueOnce(new Error("boom"));
    const user = userEvent.setup();
    renderWithProviders(<StatementPrintButton customerId="c1" />);
    await user.click(screen.getByRole("button", { name: "Print" }));
    expect(await screen.findByText("Couldn't print the statement")).toBeInTheDocument();
    expect(mockPrint).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Print" })).toBeEnabled();
  });

  it("a failed download of the bytes shows the same toast and prints nothing", async () => {
    mockFetchBlob.mockRejectedValueOnce(new Error("401"));
    const user = userEvent.setup();
    renderWithProviders(<StatementPrintButton customerId="c1" />);
    await user.click(screen.getByRole("button", { name: "Print" }));
    expect(await screen.findByText("Couldn't print the statement")).toBeInTheDocument();
    expect(mockPrint).not.toHaveBeenCalled();
  });
});

describe("PD7: touch, Print or share, then Open PDF", () => {
  it.each([
    ["a coarse pointer", () => setCoarse(true)],
    [
      "the app shell",
      () => {
        mockShell = true;
      },
    ],
  ])(
    "%s: one tap makes a real link to the signed URL, and nothing is printed from a frame",
    async (_n, arm) => {
      arm();
      const user = userEvent.setup();
      renderWithProviders(<StatementPrintButton customerId="c1" />);
      expect(screen.queryByRole("button", { name: "Print" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Print or share" }));
      const link = await screen.findByTestId("statement-open-pdf");
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute("href", SIGNED);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
      expect(link).toHaveTextContent("Open PDF");
      expect(mockPrint).not.toHaveBeenCalled();
      expect(mockFetchBlob).not.toHaveBeenCalled();
    },
  );

  it("a failed render shows the toast and no link", async () => {
    setCoarse(true);
    mockGet.mockRejectedValueOnce(new Error("boom"));
    const user = userEvent.setup();
    renderWithProviders(<StatementPrintButton customerId="c1" />);
    await user.click(screen.getByRole("button", { name: "Print or share" }));
    expect(await screen.findByText("Couldn't print the statement")).toBeInTheDocument();
    expect(screen.queryByTestId("statement-open-pdf")).toBeNull();
  });
});
