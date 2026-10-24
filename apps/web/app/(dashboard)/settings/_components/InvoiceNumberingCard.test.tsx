import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { InvoiceNumberingCard } from "./InvoiceNumberingCard";

// B1188: Settings > Invoicing "Save Numbering" PATCHed /settings {invoicePrefix, paymentDueDays},
// which the api accepted and dropped. The prefix now saves to the numbering sequence
// (PUT /import/numbering/INVOICE) behind a server PREVIEW + explicit CONFIRM, carrying the
// preview's version token; the days control is a select bound to invoice.defaultTerms
// (PATCH /settings/invoice).

const mockGet = jest.fn();
const mockPut = jest.fn();
const mockPatch = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "x", role: "TENANT_ADMIN" } }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => mockGet(...a),
    put: (...a: unknown[]) => mockPut(...a),
    patch: (...a: unknown[]) => mockPatch(...a),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

const numberingRows = [
  {
    docType: "INVOICE",
    prefix: "INV-",
    nextNumber: 7,
    padding: 4,
    preview: "INV-0007",
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
];

beforeEach(() => {
  onTermsChange.mockReset();
  mockGet.mockReset();
  mockPut.mockReset();
  mockPatch.mockReset();
  mockGet.mockImplementation((url: string, config?: { params?: { prefix?: string } }) => {
    if (url === "/import/numbering") return Promise.resolve({ data: numberingRows });
    if (url === "/settings/invoice")
      return Promise.resolve({ data: { defaultTerms: "Net 30", hideOriginalPrice: false } });
    if (url === "/import/numbering/INVOICE/preview")
      return Promise.resolve({
        data: {
          docType: "INVOICE",
          prefix: config?.params?.prefix,
          preview: `${config?.params?.prefix}0042`,
          expectedNextNumber: 7,
        },
      });
    return Promise.resolve({ data: {} });
  });
  mockPut.mockResolvedValue({
    data: { ...numberingRows[0], prefix: "NEW-", preview: "NEW-0042" },
  });
  mockPatch.mockResolvedValue({ data: {} });
});

const onTermsChange = jest.fn();
function Harness({ initial = "Net 30" }: { initial?: string }) {
  const [terms, setTerms] = React.useState(initial);
  return (
    <InvoiceNumberingCard
      terms={terms}
      onTermsChange={(v) => {
        onTermsChange(v);
        setTerms(v);
      }}
    />
  );
}
const prefixInput = () => screen.findByLabelText(/invoice number prefix/i);

async function typePrefix(value: string) {
  const input = (await prefixInput()) as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe("INV-"));
  await userEvent.clear(input);
  await userEvent.type(input, value);
}

const putCalls = () => mockPut.mock.calls;
const patchesTo = (url: string) => mockPatch.mock.calls.filter((c) => c[0] === url);

describe("InvoiceNumberingCard (B1188)", () => {
  it("inventory: prefix input, payment-terms select, Save Numbering button, all present", async () => {
    renderWithProviders(<Harness />);
    const prefix = (await prefixInput()) as HTMLInputElement;
    await waitFor(() => expect(prefix.value).toBe("INV-"));
    expect(prefix).toHaveAttribute("placeholder", "INV-");
    expect(screen.getByText(/prepended to invoice numbers/i)).toBeInTheDocument();

    const days = (await screen.findByLabelText(/payment due days/i)) as HTMLSelectElement;
    expect(days.tagName).toBe("SELECT");
    expect(
      within(days)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Due on Receipt", "Net 15", "Net 30", "Net 45", "Net 60"]);
    expect(days.value).toBe("Net 30");
    expect(screen.getByText(/default days until payment is due/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save numbering/i })).toBeInTheDocument();
  });

  it("shows the server's next number for the NEW prefix and does NOT save until confirmed", async () => {
    renderWithProviders(<Harness />);
    await typePrefix("NEW-");
    await userEvent.click(screen.getByRole("button", { name: /save numbering/i }));

    expect(await screen.findByText(/NEW-0042/)).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("/import/numbering/INVOICE/preview", {
      params: { prefix: "NEW-" },
    });
    expect(putCalls()).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    // The version token is the one the PREVIEW returned, so a sequence that moved since is refused.
    expect(putCalls()[0]).toEqual([
      "/import/numbering/INVOICE",
      { prefix: "NEW-", expectedNextNumber: 7 },
    ]);
  });

  it("Cancel on the confirmation sends nothing", async () => {
    renderWithProviders(<Harness />);
    await typePrefix("NEW-");
    await userEvent.click(screen.getByRole("button", { name: /save numbering/i }));
    await screen.findByText(/NEW-0042/);
    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(putCalls()).toHaveLength(0);
    expect(patchesTo("/settings")).toHaveLength(0);
  });

  it("refuses a trailing-digit prefix inline (shared validator): no preview, no save", async () => {
    renderWithProviders(<Harness />);
    await typePrefix("INV2");
    await userEvent.click(screen.getByRole("button", { name: /save numbering/i }));
    expect(await screen.findByText(/ends with a digit|digit/i)).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalledWith(
      "/import/numbering/INVOICE/preview",
      expect.anything(),
    );
    expect(putCalls()).toHaveLength(0);
  });

  it("the days select reports its pick to the shared terms value, never PATCHing /settings", async () => {
    renderWithProviders(<Harness />);
    const days = (await screen.findByLabelText(/payment due days/i)) as HTMLSelectElement;
    await userEvent.selectOptions(days, "Net 45");
    expect(onTermsChange).toHaveBeenCalledWith("Net 45");
    expect(days.value).toBe("Net 45");
    expect(patchesTo("/settings")).toHaveLength(0);
    expect(putCalls()).toHaveLength(0);
  });

  it("unconfigured tenant: empty prefix, format placeholder and the server's next number", async () => {
    mockGet.mockImplementation((url: string) =>
      url === "/import/numbering"
        ? Promise.resolve({
            data: [
              {
                docType: "INVOICE",
                prefix: "INV-",
                nextNumber: 1,
                padding: 4,
                preview: "INV-2026-0039",
                configured: false,
              },
            ],
          })
        : Promise.resolve({ data: {} }),
    );
    renderWithProviders(<Harness />);
    const input = (await prefixInput()) as HTMLInputElement;
    await screen.findByText("Next invoice: INV-2026-0039 (yearly numbering)");
    expect(input.value).toBe("");
    expect(input).toHaveAttribute("placeholder", "INV-2026-");
    // Untouched field + Save = nothing to save: no preview, no write.
    await userEvent.click(screen.getByRole("button", { name: /save numbering/i }));
    expect(putCalls()).toHaveLength(0);
  });

  it("a 409 shows the fixed stale-sequence copy (never the server text) and no success", async () => {
    mockPut.mockRejectedValue({
      response: {
        status: 409,
        data: { message: "invoice numbering changed since you opened it — reload and try again." },
      },
    });
    renderWithProviders(<Harness />);
    await typePrefix("NEW-");
    await userEvent.click(screen.getByRole("button", { name: /save numbering/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^confirm$/i }));
    expect(
      await screen.findByText(
        "The invoice sequence changed since your preview. Review the new next number and confirm again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/numbering saved/i)).not.toBeInTheDocument();
  });

  it("the confirm shows the NEW next number and the CURRENT format, in the exact sentence", async () => {
    renderWithProviders(<Harness />);
    await typePrefix("NEW-");
    await userEvent.click(screen.getByRole("button", { name: /save numbering/i }));
    expect(
      await screen.findByText(
        "Next invoice: NEW-0042 (currently INV-0007). Existing invoices keep their numbers.",
      ),
    ).toBeInTheDocument();
  });

  it("a double click on Confirm sends ONE PUT", async () => {
    let release: (v: unknown) => void = () => undefined;
    mockPut.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderWithProviders(<Harness />);
    await typePrefix("NEW-");
    await userEvent.click(screen.getByRole("button", { name: /save numbering/i }));
    const confirm = await screen.findByRole("button", { name: /^confirm$/i });
    // Two clicks in ONE tick (before React re-renders the button as loading): only the ref guard
    // can stop the second one.
    act(() => {
      confirm.click();
      confirm.click();
    });
    await userEvent.click(confirm);
    expect(putCalls()).toHaveLength(1);
    release({ data: { ...numberingRows[0], prefix: "NEW-", preview: "NEW-0042" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: /^confirm$/i })).toBeNull());
    expect(putCalls()).toHaveLength(1);
  });
});
