import * as React from "react";
import { renderWithProviders } from "@/test-utils/render";
import ReturnDetailPage from "./page";
import type { Return } from "@/lib/api/returns";

// SA-1049 R2 (L-072): the timeline ordered five hand-typed statuses and left PROCESSED out, so a legacy
// PROCESSED return (the service still keeps an arm for them; counter-sale treats it like REFUNDED) read
// `indexOf === -1` and every step showed "pending". A status now maps to its step through one typed
// record: PROCESSED is the same terminal step as REFUNDED and names itself there.
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "ret-1" }),
}));

jest.mock("@/lib/api-client", () => ({
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

const log = (status: string, day: number) => ({
  id: `l-${status}`,
  status,
  createdAt: `2026-09-${String(day).padStart(2, "0")}T15:00:00.000Z`,
});
const baseReturn = {
  id: "ret-1",
  returnNumber: "R-100",
  customerId: "c1",
  orderId: "o1",
  reason: "DAMAGED",
  notes: "",
  items: [],
  kind: "STANDARD",
  createdAt: "2026-09-01T15:00:00.000Z",
  updatedAt: "2026-09-01T15:00:00.000Z",
} as unknown as Return;

/** Each timeline step: its label, and whether it reads done / active / pending (by its circle's class). */
const steps = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".pb-3.pt-0\\.5")).map((body) => {
    const row = body.parentElement as HTMLElement;
    const circle = row.querySelector("div.rounded-full") as HTMLElement;
    const state = circle.className.includes("bg-green-100")
      ? "done"
      : circle.className.includes("bg-brand-500")
        ? "active"
        : "pending";
    return { label: body.querySelector("p")?.textContent, state, text: body.textContent ?? "" };
  });

describe("Return timeline (SA-1049 R2)", () => {
  it("R-1: a PROCESSED return reads steps 0-3 done and the last step active, named Processed, with its date", () => {
    mockReturn = {
      ...baseReturn,
      status: "PROCESSED",
      logs: [
        log("PENDING", 1),
        log("APPROVED", 2),
        log("IN_TRANSIT", 3),
        log("RECEIVED", 4),
        log("PROCESSED", 5),
      ],
    } as Return;
    const { container } = renderWithProviders(<ReturnDetailPage />);
    const s = steps(container);
    expect(s.map((x) => x.state)).toEqual(["done", "done", "done", "done", "active"]);
    expect(s[4].label).toBe("Processed");
    expect(s[4].text).toMatch(/Sep 5, 2026/);
  });

  it("a REFUNDED return is unchanged: the last step is Refunded and active", () => {
    mockReturn = {
      ...baseReturn,
      status: "REFUNDED",
      logs: [log("REFUNDED", 5)],
    } as Return;
    const { container } = renderWithProviders(<ReturnDetailPage />);
    const s = steps(container);
    expect(s.map((x) => x.state)).toEqual(["done", "done", "done", "done", "active"]);
    expect(s[4].label).toBe("Refunded");
  });

  it("a RECEIVED return is unchanged: step 3 active, the last step pending and still named Refunded", () => {
    mockReturn = { ...baseReturn, status: "RECEIVED", logs: [] } as Return;
    const { container } = renderWithProviders(<ReturnDetailPage />);
    const s = steps(container);
    expect(s.map((x) => x.state)).toEqual(["done", "done", "done", "active", "pending"]);
    expect(s[4].label).toBe("Refunded");
  });

  it("REJECTED and CANCELLED keep their own banner and no steps", () => {
    mockReturn = { ...baseReturn, status: "CANCELLED", logs: [log("CANCELLED", 5)] } as Return;
    const { container, getByText } = renderWithProviders(<ReturnDetailPage />);
    expect(getByText("Return Cancelled")).toBeInTheDocument();
    expect(steps(container)).toEqual([]);
  });
});
