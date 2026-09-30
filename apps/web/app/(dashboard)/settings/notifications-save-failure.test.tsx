import * as React from "react";
import { MutationCache, QueryClient } from "@tanstack/react-query";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { handleMutationError } from "@/lib/mutation-error-toast";
import { NotificationsSettingsTab } from "./_components/NotificationsSettingsTab";

/**
 * #1965 review F1: a failed save must show EXACTLY ONE toast, with no server text, and the switch
 * must revert. This runs the REAL hooks (`useMessagingConfig`/`useToggleRule`) against a mocked
 * transport and the REAL app-wide MutationCache handler, so a second (global) toast is visible here.
 */

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "TENANT_ADMIN" } }),
}));
jest.mock("@/lib/api/notifications", () => ({
  useNotificationsStatus: () => ({ data: { configured: false, deviceCount: 0 } }),
  useSendTestNotification: () => ({ mutate: jest.fn(), isPending: false }),
}));

const config = {
  channelStatus: { EMAIL: "LIVE", WHATSAPP: "NOT_BUILT", SMS: "NOT_BUILT", PORTAL: "NOT_BUILT" },
  events: [
    {
      eventKey: "ORDER_CONFIRMED",
      label: "Order confirmed",
      audience: "CUSTOMER",
      hasTrigger: true,
      channels: [
        {
          channel: "EMAIL",
          enabled: true,
          ruleId: "rule-oc-email",
          locked: false,
          template: null,
        },
      ],
    },
  ],
  settings: {
    quietHoursEnabled: false,
    quietHoursStart: "21:00",
    quietHoursEnd: "07:00",
    timezone: null,
  },
  msgsMeter: null,
};

const mockGet = jest.fn();
const mockPatch = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => mockGet(...a),
    patch: (...a: unknown[]) => mockPatch(...a),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

describe("Notifications save failure (#1965 review F1)", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPatch.mockReset();
    // The FIRST config read resolves; every later one (the refetch after the failed save) never
    // settles, so the switch can only return to "on" through the optimistic rollback itself.
    let configReads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url.includes("delivery-health")) return Promise.reject({ response: { status: 404 } });
      configReads += 1;
      return configReads === 1 ? Promise.resolve({ data: config }) : new Promise(() => undefined);
    });
  });

  it("T11 one toast, no server text, and the switch reverts to on", async () => {
    mockPatch.mockRejectedValue({
      message: "Request failed with status code 500",
      response: { status: 500, data: { message: "Internal server error boom" } },
    });
    const globalToast = jest.fn();
    const queryClient = new QueryClient({
      mutationCache: new MutationCache({
        onError: (error, _v, _c, mutation) =>
          handleMutationError(error, mutation, globalToast, { push: jest.fn() }),
      }),
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    renderWithProviders(<NotificationsSettingsTab />, { queryClient });
    const sw = await screen.findByRole("switch", { name: /order confirmed/i });
    expect(sw).toHaveAttribute("aria-checked", "true");

    fireEvent.click(sw);

    expect(await screen.findAllByText("Couldn't save, please try again")).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /order confirmed/i })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    expect(globalToast).not.toHaveBeenCalled();
    expect(screen.queryByText(/boom|Internal server error|status code/i)).not.toBeInTheDocument();
  });
});
