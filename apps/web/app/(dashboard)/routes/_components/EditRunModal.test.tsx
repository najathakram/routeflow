/**
 * Component-level proof that EditRunModal is actually WIRED to the B59 seam
 * (`edit-run-modal.logic.ts`). T1/T2 assert the seam's pure functions; these
 * cases assert the shipped component calls them — the gap that let both B59
 * defects survive a green unit run.
 */
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { EditRunModal, type EditableRun } from "./EditRunModal";

jest.mock("@/lib/api/drivers", () => ({
  useDrivers: () => ({
    data: {
      data: [
        { id: "d1", contactName: "Driver One", status: "ACTIVE" },
        { id: "d2", contactName: "Driver Two", status: "ACTIVE" },
      ],
    },
  }),
  useDriver: () => ({ data: undefined }),
}));

const mutate = jest.fn();
jest.mock("@/lib/api/routes", () => ({
  useUpdateRouteRun: () => ({ mutate, isPending: false }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const run: EditableRun = {
  id: "r1",
  driverId: "d1",
  // Stored UTC-midnight calendar date — the previous local-getter read rendered
  // this as "2026-06-09" for any negative-UTC-offset viewer.
  scheduledDate: "2026-06-10T00:00:00.000Z",
  notes: "",
  status: "SCHEDULED",
};

function dateInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('input[type="date"]');
  if (!el) throw new Error("date input not found");
  return el as HTMLInputElement;
}

describe("EditRunModal", () => {
  beforeEach(() => jest.clearAllMocks());

  it("REG-B59 EditRunModal sends no scheduledDate when only the driver changes", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<EditRunModal run={run} onClose={jest.fn()} />);

    expect(dateInput(container).value).toBe("2026-06-10");

    await user.selectOptions(screen.getByRole("combobox"), "d2");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    const body = mutate.mock.calls[0][0];
    expect(body).not.toHaveProperty("scheduledDate");
    expect(body.driverId).toBe("d2");
  });

  it("REG-B59 EditRunModal sends scheduledDate when the date itself changes", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<EditRunModal run={run} onClose={jest.fn()} />);

    await user.clear(dateInput(container));
    await user.type(dateInput(container), "2026-06-12");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0][0].scheduledDate).toBe("2026-06-12");
  });
});
