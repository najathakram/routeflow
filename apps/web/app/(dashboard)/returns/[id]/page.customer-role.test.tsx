import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import ReturnDetailPage from "./page";
import type { Return } from "@/lib/api/returns";

/**
 * REG-B1: the return's status actions (approve, reject, in transit, receive, resolve) are staff-only in the API;
 * a CUSTOMER sees none of them but keeps Cancel Return. Harness as page.test.tsx plus a seeded session.
 */
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "ret-1" }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));

let mockReturn: Return | undefined;
jest.mock("@/lib/api/returns", () => ({
  useReturn: () => ({ data: mockReturn, isLoading: false, isError: false }),
  useApproveReturn: () => ({ mutate: jest.fn(), isPending: false }),
  useRejectReturn: () => ({ mutate: jest.fn(), isPending: false }),
  useMarkReturnInTransit: () => ({ mutate: jest.fn(), isPending: false }),
  useMarkReturnReceived: () => ({ mutate: jest.fn(), isPending: false }),
  useProcessRefund: () => ({ mutate: jest.fn(), isPending: false }),
  useCancelReturn: () => ({ mutate: jest.fn(), isPending: false }),
}));

const baseReturn = {
  id: "ret-1",
  returnNumber: "R-100",
  customerId: "c1",
  orderId: "o1",
  reason: "DAMAGED",
  notes: "",
  items: [],
  kind: "STANDARD",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
} as unknown as Return;

/** One staff action per status it appears in (button accessible names in page.tsx). */
const STAFF_ACTIONS: { status: string; label: string; name: RegExp }[] = [
  { status: "PENDING", label: "Approve", name: /^Approve$/ },
  { status: "PENDING", label: "Reject", name: /^Reject$/ },
  { status: "APPROVED", label: "Mark In Transit", name: /^Mark In Transit$/ },
  { status: "APPROVED", label: "Resolve without receiving", name: /^Resolve without receiving$/ },
  { status: "IN_TRANSIT", label: "Mark Received", name: /^Mark Received$/ },
  { status: "RECEIVED", label: "Resolve Return", name: /^Resolve Return$/ },
];

const countOf = (name: RegExp) => screen.queryAllByRole("button", { name }).length;

afterEach(() => seedSession(null));

describe("REG-B1 return detail by role", () => {
  it.each(STAFF_ACTIONS)(
    "REG-B1 a CUSTOMER sees no $label on a $status return",
    ({ status, label, name }) => {
      seedSession("CUSTOMER");
      mockReturn = { ...baseReturn, status } as Return;
      renderWithProviders(<ReturnDetailPage />);
      expect({ label, count: countOf(name) }).toEqual({ label, count: 0 });
    },
  );

  it("REG-B1 a CUSTOMER still sees Cancel Return on a received return", () => {
    seedSession("CUSTOMER");
    mockReturn = { ...baseReturn, status: "RECEIVED" } as Return;
    renderWithProviders(<ReturnDetailPage />);
    expect({ label: "Cancel Return", count: countOf(/^Cancel Return$/) }).toEqual({
      label: "Cancel Return",
      count: 1,
    });
  });

  it.each(STAFF_ACTIONS)(
    "REG-B1 an OPERATOR twin sees $label on a $status return",
    ({ status, label, name }) => {
      seedSession("OPERATOR");
      mockReturn = { ...baseReturn, status } as Return;
      renderWithProviders(<ReturnDetailPage />);
      expect({ label, count: countOf(name) >= 1 }).toEqual({ label, count: true });
    },
  );

  // A held INLINE return (RECEIVED, held, no credit note) waits for staff approval: HeldReturnActions.
  const held = () =>
    ({
      ...baseReturn,
      kind: "INLINE",
      status: "RECEIVED",
      holdReason: "DRIVER_CAP",
    }) as unknown as Return;

  it("REG-B1 a CUSTOMER on their own held inline return sees no Approve or Reject", () => {
    seedSession("CUSTOMER");
    mockReturn = held();
    renderWithProviders(<ReturnDetailPage />);
    for (const [label, name] of [
      ["Approve (held)", /^Approve$/],
      ["Reject (held)", /^Reject$/],
    ] as const) {
      expect({ label, count: countOf(name) }).toEqual({ label, count: 0 });
    }
  });

  it("REG-B1 an OPERATOR twin sees Approve on a held inline return", () => {
    seedSession("OPERATOR");
    mockReturn = held();
    renderWithProviders(<ReturnDetailPage />);
    expect({ label: "Approve (held)", count: countOf(/^Approve$/) >= 1 }).toEqual({
      label: "Approve (held)",
      count: true,
    });
  });
});
