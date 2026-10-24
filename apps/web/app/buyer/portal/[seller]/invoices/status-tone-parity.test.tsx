import * as React from "react";
import { INVOICE_STATUS_VALUES, type InvoiceStatus } from "@routeflow/types";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { invoiceItem, invoiceListItem } from "@/test-utils/buyer-invoice-fixtures";
import type { BuyerInvoiceDetail } from "@/lib/api/buyer";
import { invoiceStatusVariant } from "@/lib/buyer-invoice-status";
import BuyerInvoicesPage from "./page";
import BuyerInvoiceDetailPage from "./[id]/page";

/**
 * B1122 fold: the buyer invoices LIST and DETAIL pages share ONE status -> tone helper
 * (`invoiceStatusVariant`). Before, each page had its own mapping and the same invoice wore two
 * different colours (SENT, VOID, WRITTEN_OFF, VIEWED). This pins, for every real InvoiceStatus,
 * that both pages paint the same tone.
 */

const mockUseBuyerInvoice = jest.fn((..._args: unknown[]) => ({
  data: undefined as BuyerInvoiceDetail | undefined,
  isLoading: false,
  isError: false,
}));
const mockGet = jest.fn();

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme", id: "inv-1" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/buyer-api-client", () => ({
  buyerApiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({
    isLoading: false,
    activeSeller: {
      id: "seller-1",
      slug: "acme",
      tenant: { slug: "acme", name: "Acme Wholesale" },
      customer: { businessName: "Sample Buyer Co" },
    },
  }),
}));
jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerInvoice: (...args: unknown[]) => mockUseBuyerInvoice(...args),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn(), dismiss: jest.fn() }),
}));

const TONE_CLASS = {
  success: "bg-success-bg",
  warning: "bg-warning-bg",
  danger: "bg-danger-bg",
  info: "bg-info-bg",
  neutral: "bg-sunken",
} as const;

type Tone = keyof typeof TONE_CLASS;

/** Which tone a pill element is painted in, read back from its Badge class. */
function toneOf(el: HTMLElement): Tone {
  const hit = (Object.keys(TONE_CLASS) as Tone[]).filter((t) =>
    el.classList.contains(TONE_CLASS[t]),
  );
  expect(hit).toHaveLength(1);
  return hit[0];
}

function detailInvoice(status: InvoiceStatus): BuyerInvoiceDetail {
  return {
    id: "inv-1",
    invoiceNumber: "INV-0001",
    status,
    subtotal: 100,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 100,
    dueDate: null,
    sentAt: null,
    viewedAt: null,
    paidAt: null,
    issueDate: "2026-01-01",
    pdfUrl: null,
    notes: null,
    terms: null,
    orderId: null,
    items: [invoiceItem({ id: "item-1", qty: 1, unitPrice: 100, subtotal: 100 })],
    payments: [],
    customer: { id: "cust-1", businessName: "Acme Foods" },
  };
}

describe("buyer invoice status tone: list and detail agree", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockUseBuyerInvoice.mockReset();
  });

  it.each(INVOICE_STATUS_VALUES)("%s renders the same tone on both pages", async (status) => {
    const expected = invoiceStatusVariant(status);
    const label = new RegExp(`^${status.replace(/_/g, " ")}$`, "i");

    // LIST page
    mockGet.mockResolvedValue({
      data: {
        data: [invoiceListItem({ id: "inv-1", status })],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      },
    });
    const list = renderWithProviders(<BuyerInvoicesPage />);
    const table = await screen.findByTestId("buyer-invoices-table");
    const listTone = toneOf(within(table).getByText(label));
    list.unmount();

    // DETAIL page
    mockUseBuyerInvoice.mockReturnValue({
      data: detailInvoice(status),
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<BuyerInvoiceDetailPage />);
    const pills = (await screen.findAllByText(label)).filter((el) =>
      Object.values(TONE_CLASS).some((c) => el.classList.contains(c)),
    );
    expect(pills).toHaveLength(1);
    const detailTone = toneOf(pills[0]);

    expect(detailTone).toBe(listTone);
    expect(listTone).toBe(expected);
  });
});
