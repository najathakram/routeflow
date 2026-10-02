import * as React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ScanPoButton } from "./ScanPoButton";

const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast }) };
});
jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

let flag = { enabled: true, resolved: true, failed: false };
jest.mock("@/lib/api/plan-flags", () => ({ usePlanFlag: () => flag }));

let modalProps: Record<string, any> | null = null;
let modalMounts = 0;
jest.mock("@/components/ScanInvoiceModal", () => ({
  ScanInvoiceModal: (props: Record<string, any>) => {
    modalProps = props;
    modalMounts += 1;
    return <div data-testid="scan-modal" />;
  },
}));

beforeEach(() => {
  flag = { enabled: true, resolved: true, failed: false };
  modalProps = null;
  modalMounts = 0;
  toast.mockClear();
});

describe("ScanPoButton", () => {
  it("opens the scanner in purchase-order mode", () => {
    render(<ScanPoButton onDrafted={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Scan supplier invoice/ }));
    expect(screen.getByTestId("scan-modal")).toBeInTheDocument();
    expect(modalProps?.intent).toBe("purchase-order");
  });

  it("toasts 'drafted — open it below' and reports the PO id when a PO is raised", () => {
    const onDrafted = jest.fn();
    render(<ScanPoButton onDrafted={onDrafted} />);
    fireEvent.click(screen.getByRole("button", { name: /Scan supplier invoice/ }));
    act(() => modalProps!.onPurchaseOrderCreated({ id: "po1", poNumber: "PO-0007" }));
    expect(onDrafted).toHaveBeenCalledWith("po1");
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "PO PO-0007 drafted — open it below" }),
    );
  });

  it("on a plan without scanning shows the lock and a friendly notice, never the scanner", () => {
    flag = { enabled: false, resolved: true, failed: false };
    render(<ScanPoButton onDrafted={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Scan supplier invoice/ }));
    expect(screen.getByText("Invoice scanning isn't on your plan")).toBeInTheDocument();
    expect(screen.getByText(/create purchase orders by hand on any plan/)).toBeInTheDocument();
    expect(modalMounts).toBe(0);
  });

  it("is disabled while the plan is still loading", () => {
    flag = { enabled: true, resolved: false, failed: false };
    render(<ScanPoButton onDrafted={jest.fn()} />);
    expect(screen.getByRole("button", { name: /Scan supplier invoice/ })).toBeDisabled();
  });
});
