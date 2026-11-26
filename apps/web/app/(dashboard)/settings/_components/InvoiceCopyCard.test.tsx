import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { InvoiceCopyCard } from "./InvoiceCopyCard";

const get = jest.fn();
const patch = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));
let role = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

const SWITCH = "Send me a copy of invoices I email";

beforeEach(() => {
  jest.clearAllMocks();
  role = "OPERATOR";
  get.mockResolvedValue({ data: {} });
  patch.mockResolvedValue({ data: {} });
});

describe("InvoiceCopyCard (W-1443)", () => {
  it("T19: an operator sees the card and the switch is OFF when the preference is absent", async () => {
    renderWithProviders(<InvoiceCopyCard />);
    const sw = await screen.findByRole("switch", { name: SWITCH });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Copies of emails you send")).toBeInTheDocument();
    expect(
      screen.getByText(/we also send a copy to you at the email address on your account/),
    ).toBeInTheDocument();
  });

  it('T19: the switch is on only for the exact value "true"', async () => {
    get.mockResolvedValue({ data: { invoiceEmailCopy: "true" } });
    renderWithProviders(<InvoiceCopyCard />);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: SWITCH })).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("T20: clicking the switch PATCHes only invoiceEmailCopy true", async () => {
    renderWithProviders(<InvoiceCopyCard />);
    const sw = await screen.findByRole("switch", { name: SWITCH });
    await waitFor(() => expect(sw).not.toBeDisabled());
    fireEvent.click(sw);
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/users/me/preferences", { invoiceEmailCopy: "true" }),
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Your preference is saved" }),
      ),
    );
  });

  it("T20: turning it off writes the string false", async () => {
    get.mockResolvedValue({ data: { invoiceEmailCopy: "true" } });
    renderWithProviders(<InvoiceCopyCard />);
    const sw = await screen.findByRole("switch", { name: SWITCH });
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(sw);
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/users/me/preferences", { invoiceEmailCopy: "false" }),
    );
  });

  it.each(["DRIVER", "CUSTOMER", "SUPER_ADMIN"])("T21: %s does not see the card", (r) => {
    role = r;
    renderWithProviders(<InvoiceCopyCard />);
    expect(screen.queryByRole("switch", { name: SWITCH })).toBeNull();
    expect(screen.queryByText("Copies of emails you send")).toBeNull();
  });
});
