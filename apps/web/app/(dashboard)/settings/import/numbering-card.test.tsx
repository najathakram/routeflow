import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, within } from "@/test-utils/render";
import SettingsImportPage from "./page";

// This card has no `next/navigation` dependency, unlike other settings pages —
// no router/search-params mock needed here.

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock("@/lib/page-title-context", () => ({
  usePageTitle: () => ({ title: "", setTitle: jest.fn() }),
}));

jest.mock("@/lib/api/import-resolution", () => ({
  useIncompleteProducts: () => ({ data: [], isLoading: false }),
  useCompleteSetup: () => ({ mutate: jest.fn() }),
}));

// The three post-fix server rows (build-plan.md FIX1/FIX2): INVOICE is
// configured (a saved year-0 row); ESTIMATE/CREDIT_NOTE are unconfigured
// (per-year preview). PAYMENT is gone from the card (Q6/REG-B861-F).
const serverRows = [
  {
    docType: "INVOICE",
    prefix: "INV-",
    nextNumber: 10543,
    padding: 5,
    preview: "INV-10543",
    configured: true,
  },
  {
    docType: "ESTIMATE",
    prefix: "EST-",
    nextNumber: 1,
    padding: 4,
    preview: "EST-2026-0001",
    configured: false,
  },
  {
    docType: "CREDIT_NOTE",
    prefix: "CN-",
    nextNumber: 1,
    padding: 4,
    preview: "CN-2026-0001",
    configured: false,
  },
];

const mockUpdateMutate = jest.fn();

jest.mock("@/lib/api/numbering", () => ({
  // Keep the real client-side formatter — only the two hooks are faked.
  ...jest.requireActual("@/lib/api/numbering"),
  useNumberingSettings: () => ({ data: serverRows, isLoading: false }),
  useUpdateNumbering: () => ({ mutate: mockUpdateMutate }),
}));

describe("SettingsImportPage — NumberingCard (B861)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Pin P-4 (no REG token): an untouched row shows the server-computed preview,
  // not a client re-derivation.
  it("P-4 an untouched row shows the server preview", async () => {
    renderWithProviders(<SettingsImportPage />);

    expect(await screen.findByText("INV-10543")).toBeInTheDocument();
    expect(screen.getByText("EST-2026-0001")).toBeInTheDocument();
  });

  // REG-B861-L: today's card still sends `nextNumber`/`padding` unconditionally
  // and no `expectedNextNumber` — the failure output shows `"padding": 5`.
  it("REG-B861-L a prefix-only edit sends the prefix and the loaded next number, nothing else", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsImportPage />);

    const prefixInput = await screen.findByLabelText("Invoices prefix");
    const row = prefixInput.closest("div") as HTMLElement;

    await user.clear(prefixInput);
    await user.type(prefixInput, "ACME-");
    await user.click(within(row).getByRole("button", { name: "Save" }));

    expect(mockUpdateMutate).toHaveBeenCalledTimes(1);
    expect(mockUpdateMutate.mock.calls[0][0]).toEqual({
      docType: "INVOICE",
      // `expectedNextNumber` does not exist on `UpdateNumberingInput` yet (FIX1/FIX2
      // add it) — the fixture below is what the fixed card must send.
      data: { prefix: "ACME-", expectedNextNumber: 10543 } as any,
    });
  });

  // REG-B861-M: today's card never drops the draft on a 409, so the prefix
  // input keeps the stale "ACME-" instead of re-seeding from the server.
  it("REG-B861-M after a 409 the row re-seeds from the server instead of keeping the stale draft", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsImportPage />);

    const prefixInput = await screen.findByLabelText("Invoices prefix");
    const row = prefixInput.closest("div") as HTMLElement;

    await user.clear(prefixInput);
    await user.type(prefixInput, "ACME-");
    await user.click(within(row).getByRole("button", { name: "Save" }));

    expect(mockUpdateMutate).toHaveBeenCalledTimes(1);
    const onError = mockUpdateMutate.mock.calls[0][1].onError;
    act(() => {
      onError({
        response: {
          status: 409,
          data: { message: "Invoices numbering changed since you opened it" },
        },
      });
    });

    expect((screen.getByLabelText("Invoices prefix") as HTMLInputElement).value).toBe("INV-");
  });

  // B1188: the same shared prefix validator as the Settings card, inline, and Save is blocked.
  it("B1188 a trailing-digit prefix shows the shared message inline and cannot be saved", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsImportPage />);

    const prefixInput = await screen.findByLabelText("Invoices prefix");
    const row = prefixInput.closest("div") as HTMLElement;
    await user.clear(prefixInput);
    await user.type(prefixInput, "INV2");

    expect(within(row).getByRole("alert")).toHaveTextContent(/cannot end with a digit/i);
    const save = within(row).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(mockUpdateMutate).not.toHaveBeenCalled();
  });
});
