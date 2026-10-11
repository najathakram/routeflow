import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * B297 PR5 / B771: a LOCKED filing renders as "Locked" (it used to fall into the `!== GENERATED` branch and read
 * "Failed"), keeps its CSV download, and only a tenant admin sees "Lock" on a GENERATED filing whose period has
 * ended. The lock needs a reason (the API requires one and audits it).
 */
const toast = jest.fn();
const mutate = jest.fn();
let role = "TENANT_ADMIN";

jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role } }) }));
jest.mock("@/lib/api/tracked-categories", () => ({
  fetchRegulatedFilingUrl: jest.fn(),
  useLockRegulatedFiling: () => ({ mutate, isPending: false }),
}));
jest.mock("@routeflow/ui/web", () => {
  const React = require("react");
  return {
    Badge: ({ label }: { label: string }) => <span data-testid="badge">{label}</span>,
    Button: ({ children, onClick, disabled }: any) => (
      <button onClick={onClick} disabled={disabled}>
        {children}
      </button>
    ),
    Modal: ({ open, children, footer, title }: any) =>
      open ? (
        <div role="dialog" aria-label={title}>
          {children}
          {footer}
        </div>
      ) : null,
    Textarea: ({ label, value, onChange, placeholder }: any) => (
      <label>
        {label}
        <textarea value={value} onChange={onChange} placeholder={placeholder} />
      </label>
    ),
    useToast: () => ({ toast }),
  };
});

import { RegulatedFilingsTable } from "./RegulatedFilingsTable";

const filing = (over: Record<string, unknown> = {}) =>
  ({
    id: "f-1",
    trackedCategoryId: "cat-1",
    reportTemplate: "GENERIC",
    cadence: "MONTHLY",
    periodKey: "2026-09",
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: "2026-10-01T00:00:00.000Z",
    status: "GENERATED",
    totalQty: "0",
    totalUnitBasisQty: "0",
    totalNetSales: "100.00",
    totalCategoryTax: "5.00",
    csvKey: "k.csv",
    generationCount: 1,
    generatedAt: "2026-10-02T00:00:00.000Z",
    ...over,
  }) as any;

beforeEach(() => {
  mutate.mockClear();
  toast.mockClear();
  role = "TENANT_ADMIN";
});

describe("RegulatedFilingsTable status", () => {
  it("renders a LOCKED filing as Locked (not Failed) and keeps its CSV", () => {
    render(<RegulatedFilingsTable filings={[filing({ status: "LOCKED", lockReason: "filed" })]} />);
    expect(screen.getByTestId("badge")).toHaveTextContent("Locked");
    expect(screen.queryByText("Failed")).toBeNull();
    expect(screen.getByRole("button", { name: /CSV/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Lock/ })).toBeNull(); // already locked: no action
  });

  it("still renders GENERATED and FAILED as before", () => {
    render(
      <RegulatedFilingsTable
        filings={[filing({ id: "a" }), filing({ id: "b", status: "FAILED", periodKey: "2026-08" })]}
      />,
    );
    expect(screen.getAllByTestId("badge").map((b) => b.textContent)).toEqual([
      "Generated",
      "Failed",
    ]);
  });
});

describe("the lock action", () => {
  it("is offered to a tenant admin for a generated filing whose period has ended, and needs a reason", () => {
    render(<RegulatedFilingsTable filings={[filing()]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Lock$/ }));
    const confirm = screen.getByRole("button", { name: "Lock filing" });
    expect(confirm).toBeDisabled(); // no reason yet
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Filed with the state" },
    });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(mutate).toHaveBeenCalledWith(
      { id: "f-1", reason: "Filed with the state" },
      expect.any(Object),
    );
  });

  it("is hidden for other roles, a running period and a FAILED filing", () => {
    role = "OPERATOR";
    const { rerender } = render(<RegulatedFilingsTable filings={[filing()]} />);
    expect(screen.queryByRole("button", { name: /^Lock$/ })).toBeNull();
    role = "TENANT_ADMIN";
    rerender(
      <RegulatedFilingsTable filings={[filing({ periodEnd: "2099-01-01T00:00:00.000Z" })]} />,
    );
    expect(screen.queryByRole("button", { name: /^Lock$/ })).toBeNull();
    rerender(<RegulatedFilingsTable filings={[filing({ status: "FAILED" })]} />);
    expect(screen.queryByRole("button", { name: /^Lock$/ })).toBeNull();
  });
});
