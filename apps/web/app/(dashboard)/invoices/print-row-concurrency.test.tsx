import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import InvoicesPage from "./page";

/**
 * Opus review finding F1 on PR #756: the list row's Print button called the
 * ONE shared `useDownloadInvoicePdf()` mutation's `.mutate(id, { onSuccess,
 * onError, onSettled })` per row. TanStack Query v5's `useMutation` is a
 * single observer — concurrent `.mutate()` calls on it share state, so the
 * per-call callbacks passed to an EARLIER call are overwritten by whichever
 * row calls `.mutate()` last. Printing row A then row B (before A settles)
 * silently dropped row A's print, its error toast, and left its spinner
 * stuck forever. Fixed by switching to `mutateAsync` with a local
 * try/catch/finally per click (page.tsx).
 *
 * This test proves the fix behaviorally: two rows' downloads resolve OUT OF
 * ORDER (row B first, then row A) and each row's own print + spinner-clear
 * must fire independently. Under the pre-fix code this fails — row A's
 * printPdfBlob call and spinner-clear never happen.
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => "/invoices",
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@/lib/page-title-context", () => ({
  usePageTitle: () => ({ setTitle: jest.fn() }),
}));

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "ADMIN" } }),
}));

function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-a",
    invoiceNumber: "INV-A",
    customerId: "cust-1",
    status: "SENT",
    subtotal: 10,
    total: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const INVOICE_A = makeInvoice({ id: "inv-a", invoiceNumber: "INV-A" });
const INVOICE_B = makeInvoice({ id: "inv-b", invoiceNumber: "INV-B" });

/** A promise this test resolves on its own schedule, to control ordering. */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const deferredA = createDeferred<{ url: string; blob: Blob }>();
const deferredB = createDeferred<{ url: string; blob: Blob }>();

const mutateAsyncMock = jest.fn((id: string) => {
  if (id === "inv-a") return deferredA.promise;
  if (id === "inv-b") return deferredB.promise;
  return Promise.reject(new Error(`unexpected id: ${id}`));
});

const printPdfBlobMock = jest.fn();

jest.mock("@/lib/print-pdf-blob", () => ({
  printPdfBlob: (...args: unknown[]) => printPdfBlobMock(...args),
}));

jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useInvoices: () => ({
    data: { data: [INVOICE_A, INVOICE_B], meta: { total: 2, page: 1, limit: 20, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useInvoiceKpiSummary: () => ({ data: undefined }),
  useDeleteInvoice: () => ({ mutate: jest.fn(), isPending: false }),
  useDownloadInvoicePdf: () => ({ mutateAsync: mutateAsyncMock, isPending: false }),
}));

jest.mock("@/lib/api/bookkeeping", () => ({
  ...jest.requireActual("@/lib/api/bookkeeping"),
  useBookkeepingSummary: () => ({ data: undefined }),
}));

describe("InvoicesPage — row Print concurrency (F1)", () => {
  it("row B resolving before row A still prints and clears row A independently", async () => {
    const user = userEvent.setup();
    renderWithProviders(<InvoicesPage />);

    const printA = await screen.findByRole("button", { name: "Print invoice INV-A" });
    const printB = await screen.findByRole("button", { name: "Print invoice INV-B" });

    // Start row A's print, then row B's — row A's mutateAsync call is still
    // pending when row B's fires (the exact concurrency the bug depended on).
    await user.click(printA);
    await user.click(printB);

    await waitFor(() => {
      expect(printA).toBeDisabled();
      expect(printB).toBeDisabled();
    });

    // Resolve OUT OF ORDER: B first.
    deferredB.resolve({ url: "https://x/b.pdf", blob: new Blob(["b"]) });
    await waitFor(() => expect(printB).not.toBeDisabled());
    expect(printPdfBlobMock).toHaveBeenCalledTimes(1);

    // Row A must still be its own independent pending state — not silently
    // cleared or dropped by row B's settle (the exact bug: a shared mutation
    // observer's onSettled fires for whichever row called .mutate() last).
    expect(printA).toBeDisabled();

    deferredA.resolve({ url: "https://x/a.pdf", blob: new Blob(["a"]) });
    await waitFor(() => expect(printA).not.toBeDisabled());

    expect(printPdfBlobMock).toHaveBeenCalledTimes(2);
    const printedBlobs = printPdfBlobMock.mock.calls.map((call) => call[0]);
    expect(printedBlobs).toHaveLength(2);
  });
});
