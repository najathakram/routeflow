import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AutoLocksCard } from "./AutoLocksCard";

const mockGet = jest.fn();
const mockPatch = jest.fn();
jest.mock("@/lib/admin-api", () => ({
  superAdminClient: {
    get: (...args: unknown[]) => mockGet(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
  },
}));

const DUE = [
  { tenantId: "t-aaa", kind: "trial_expired", key: "2026-10-01T00:00:00.000Z" },
  { tenantId: "t-bbb", kind: "subscription_cancelled", key: "2026-10-02T00:00:00.000Z" },
];

function state(over: Record<string, unknown> = {}) {
  return {
    paused: true,
    since: null,
    reason: null,
    wouldLockNow: DUE,
    skipped: [],
    ...over,
  };
}

function route(s: Record<string, unknown>, preview?: Record<string, unknown> | Error) {
  mockGet.mockImplementation((url: string) => {
    if (url.endsWith("/preview")) {
      if (preview instanceof Error) return Promise.reject(preview);
      return Promise.resolve({
        data: preview ?? { generatedAt: "t", paused: true, wouldLock: DUE },
      });
    }
    return Promise.resolve({ data: s });
  });
}

beforeEach(() => {
  mockGet.mockReset();
  mockPatch.mockReset();
  mockPatch.mockResolvedValue({ data: {} });
});

const typeReason = (text = "owner go-live ruling") =>
  fireEvent.change(screen.getByLabelText(/Reason for the change/), { target: { value: text } });

describe("AutoLocksCard", () => {
  it("shows the paused banner with the number of tenants and the list by id and kind", async () => {
    route(state());
    render(<AutoLocksCard />);
    expect(
      await screen.findByText("Automatic locks paused — 2 tenants would be locked now"),
    ).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Tenants that would be locked now" });
    expect(within(list).getByText("t-aaa — Trial ended")).toBeInTheDocument();
    expect(
      within(list).getByText("t-bbb — Cancellation reached its period end"),
    ).toBeInTheDocument();
  });

  it("UNPAUSE: the button needs a reason, then opens a confirm that loads the preview first and does NOT flip the switch", async () => {
    route(state());
    render(<AutoLocksCard />);
    const open = await screen.findByRole("button", { name: /Unpause automatic locks/ });
    expect(open).toBeDisabled();
    typeReason();
    expect(open).toBeEnabled();
    fireEvent.click(open);

    expect(
      await screen.findByText("Unpausing will lock these 2 tenants within the hour:"),
    ).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("/platform-admin/config/auto-locks/preview");
    expect(mockPatch).not.toHaveBeenCalled();
    // initial focus is Cancel, so a stray Enter never confirms
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  });

  it("UNPAUSE: Cancel writes nothing; the explicit confirm sends {paused:false, reason}", async () => {
    route(state());
    render(<AutoLocksCard />);
    typeReason("  owner go-live ruling  ");
    fireEvent.click(await screen.findByRole("button", { name: /Unpause automatic locks/ }));
    await screen.findByText("Unpausing will lock these 2 tenants within the hour:");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockPatch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Unpause automatic locks/ }));
    await screen.findByText("Unpausing will lock these 2 tenants within the hour:");
    fireEvent.click(screen.getByRole("button", { name: "Unpause and allow locks" }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/platform-admin/config/auto-locks", {
        paused: false,
        reason: "owner go-live ruling",
      }),
    );
  });

  it("UNPAUSE: if the preview cannot load, confirm stays disabled (no blind unpause)", async () => {
    route(state(), new Error("boom"));
    render(<AutoLocksCard />);
    typeReason();
    fireEvent.click(await screen.findByRole("button", { name: /Unpause automatic locks/ }));
    expect(await screen.findByText(/Couldn't load the unpause preview/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpause and allow locks" })).toBeDisabled();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("PAUSE (switch is on): one click with a reason sends {paused:true, reason}", async () => {
    route(state({ paused: false, wouldLockNow: [] }));
    render(<AutoLocksCard />);
    expect(await screen.findByText("Automatic locks are on")).toBeInTheDocument();
    typeReason();
    fireEvent.click(screen.getByRole("button", { name: "Pause automatic locks" }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/platform-admin/config/auto-locks", {
        paused: true,
        reason: "owner go-live ruling",
      }),
    );
  });

  it("a failed change shows fixed copy, never the server's text", async () => {
    route(state({ paused: false, wouldLockNow: [] }));
    mockPatch.mockRejectedValue({ response: { data: { message: "SECRET internals" } } });
    render(<AutoLocksCard />);
    typeReason();
    fireEvent.click(await screen.findByRole("button", { name: "Pause automatic locks" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't change the switch. Nothing was changed.",
    );
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();
  });

  it("a status load failure shows a plain alert (no crash, no controls)", async () => {
    mockGet.mockRejectedValue(new Error("down"));
    render(<AutoLocksCard />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Couldn't load the automatic-locks status/,
    );
    expect(screen.queryByRole("button", { name: /automatic locks/i })).not.toBeInTheDocument();
  });
});
