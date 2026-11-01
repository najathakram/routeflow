import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { StaffOrderEmailCard } from "./StaffOrderEmailCard";

const get = jest.fn();
const put = jest.fn();
const patch = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    put: (...a: unknown[]) => put(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));
const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

const settings = (over: Record<string, unknown> = {}) => ({
  staffCc: [],
  effectiveMode: "dark",
  policyMode: "dark",
  recipients: ["owner@acme.test"],
  ...over,
});

function serve(s: unknown, prefs: Record<string, string> = {}) {
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url.includes("staff-email-settings") ? s : prefs }),
  );
}

beforeEach(() => jest.clearAllMocks());

describe("StaffOrderEmailCard (SA-1063)", () => {
  it("shows the business switch off by default (dark reads as off) and no personal row", async () => {
    serve(settings());
    renderWithProviders(<StaffOrderEmailCard />);
    const sw = await screen.findByRole("switch", { name: "Email your team about customer orders" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("switch", { name: "Email me about customer orders" })).toBeNull();
  });

  it("shows where the emails would go while the switch is off (rollout needs the address on screen)", async () => {
    serve(settings());
    renderWithProviders(<StaffOrderEmailCard />);
    expect(await screen.findByText("owner@acme.test")).toBeInTheDocument();
    expect(screen.getByText(/goes to/i)).toBeInTheDocument();
  });

  it("says there is no address, and what to do, while the switch is off too", async () => {
    serve(settings({ recipients: [] }));
    renderWithProviders(<StaffOrderEmailCard />);
    expect(await screen.findByText(/add one to send these emails/i)).toBeInTheDocument();
  });

  it("the switch is named by its visible label (voice control says what it sees)", async () => {
    serve(settings());
    renderWithProviders(<StaffOrderEmailCard />);
    await screen.findByRole("switch", { name: "Email your team about customer orders" });
    expect(screen.getByText("Email your team about customer orders")).toBeInTheDocument();
  });

  it('turning it on sends mode "on" and nothing else', async () => {
    serve(settings());
    put.mockResolvedValue({ data: settings({ policyMode: "on" }) });
    renderWithProviders(<StaffOrderEmailCard />);
    fireEvent.click(
      await screen.findByRole("switch", { name: "Email your team about customer orders" }),
    );
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/messaging/staff-email-settings", { mode: "on" }),
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "success" })),
    );
  });

  it("when on: lists where the emails go and says they haven't started if the platform hasn't", async () => {
    serve(settings({ policyMode: "on", effectiveMode: "dark" }));
    renderWithProviders(<StaffOrderEmailCard />);
    expect(await screen.findByText("owner@acme.test")).toBeInTheDocument();
    expect(screen.getByText(/goes to/i)).toBeInTheDocument();
    expect(screen.getByText(/emails haven.t started yet/i)).toBeInTheDocument();
  });

  it("when on and sending: no 'not started' line", async () => {
    serve(settings({ policyMode: "on", effectiveMode: "on" }));
    renderWithProviders(<StaffOrderEmailCard />);
    await screen.findByText("owner@acme.test");
    expect(screen.queryByText(/haven.t started/i)).toBeNull();
  });

  it("when on with no admin address: says there is nowhere to send", async () => {
    serve(settings({ policyMode: "on", effectiveMode: "on", recipients: [] }));
    renderWithProviders(<StaffOrderEmailCard />);
    expect(await screen.findByText(/add one to send these emails/i)).toBeInTheDocument();
  });

  it("personal row: on by default, and opting out writes both preferences as the string false", async () => {
    serve(settings({ policyMode: "on", effectiveMode: "on" }));
    patch.mockResolvedValue({ data: {} });
    renderWithProviders(<StaffOrderEmailCard />);
    const sw = await screen.findByRole("switch", { name: "Email me about customer orders" });
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/users/me/preferences", {
        staffOrderEmail: "false",
        staffBuyerChangeEmail: "false",
      }),
    );
  });

  it("personal row: reads an existing opt-out", async () => {
    serve(settings({ policyMode: "on", effectiveMode: "on" }), { staffOrderEmail: "false" });
    renderWithProviders(<StaffOrderEmailCard />);
    const sw = await screen.findByRole("switch", { name: "Email me about customer orders" });
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
  });

  it("a failed save shows an error toast", async () => {
    serve(settings());
    put.mockRejectedValue(new Error("boom"));
    renderWithProviders(<StaffOrderEmailCard />);
    fireEvent.click(
      await screen.findByRole("switch", { name: "Email your team about customer orders" }),
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "error" })),
    );
  });

  it("a failed load offers Retry", async () => {
    get.mockRejectedValue(new Error("down"));
    renderWithProviders(<StaffOrderEmailCard />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
