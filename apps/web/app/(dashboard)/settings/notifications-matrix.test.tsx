import * as React from "react";
import { fireEvent, renderWithProviders, screen, within } from "@/test-utils/render";
import { NotificationsSettingsTab } from "./_components/NotificationsSettingsTab";

/**
 * #1965 (spec 10) — the notifications page is a grouped list, not a mostly-"Not available" matrix:
 * recipient chip per row, channels that are not built appear ONCE as "coming soon", events with no
 * firing site are listed under "Coming soon" with no switch, and no raw reason string is rendered.
 */

let mockRole = "TENANT_ADMIN";
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: mockRole } }) }));

jest.mock("@/lib/api/notifications", () => ({
  useNotificationsStatus: () => ({ data: { configured: false, deviceCount: 0 } }),
  useSendTestNotification: () => ({ mutate: jest.fn(), isPending: false }),
}));

const cell = (channel: string, extra: Record<string, unknown> = {}) => ({
  channel,
  enabled: true,
  ruleId: `rule-${channel}`,
  locked: false,
  template: null,
  ...extra,
});

function makeConfig(over: Record<string, unknown> = {}) {
  return {
    channelStatus: { EMAIL: "LIVE", WHATSAPP: "NOT_BUILT", SMS: "NOT_BUILT", PORTAL: "NOT_BUILT" },
    events: [
      {
        eventKey: "ORDER_CONFIRMED",
        label: "Order confirmed",
        audience: "CUSTOMER",
        hasTrigger: true,
        channels: [
          cell("EMAIL", { ruleId: "rule-oc-email" }),
          cell("WHATSAPP", { enabled: false, ruleId: "rule-oc-wa", unavailable: "NO_TRANSPORT" }),
          cell("PORTAL", { enabled: false, ruleId: "rule-oc-portal", unavailable: "NO_TRANSPORT" }),
        ],
      },
      {
        eventKey: "DELIVERED",
        label: "Delivered",
        audience: "CUSTOMER",
        hasTrigger: true,
        channels: [cell("EMAIL", { ruleId: "rule-d-email" })],
      },
      {
        eventKey: "PAYMENT_REMINDER",
        label: "Payment reminder",
        audience: "CUSTOMER",
        hasTrigger: false,
        channels: [
          cell("EMAIL", { enabled: false, ruleId: "rule-pr-email", unavailable: "NO_TRIGGER" }),
        ],
      },
      {
        eventKey: "LOW_STOCK",
        label: "Low stock",
        audience: "STAFF",
        hasTrigger: false,
        channels: [
          cell("INTERNAL", { enabled: false, ruleId: "rule-ls", unavailable: "NO_TRIGGER" }),
        ],
      },
    ],
    settings: {
      quietHoursEnabled: false,
      quietHoursStart: "21:00",
      quietHoursEnd: "07:00",
      timezone: null,
    },
    msgsMeter: { used: 0, included: 200, remaining: 200, resetsAt: null },
    ...over,
  };
}

const state: {
  config: ReturnType<typeof makeConfig>;
  isError: boolean;
  isLoading: boolean;
  refetch: jest.Mock;
  health: unknown;
  toggle: jest.Mock;
} = {
  config: makeConfig(),
  isError: false,
  isLoading: false,
  refetch: jest.fn(),
  health: null,
  toggle: jest.fn(),
};

jest.mock("@/lib/api/messaging", () => ({
  ...jest.requireActual("@/lib/api/messaging"),
  useMessagingConfig: () => ({
    data: state.isError ? undefined : state.config,
    isLoading: state.isLoading,
    isError: state.isError,
    refetch: state.refetch,
  }),
  useDeliveryHealth: () => ({ data: state.health }),
  useToggleRule: () => ({ mutate: state.toggle, isPending: false }),
  useUpdateTemplate: () => ({ mutate: jest.fn(), isPending: false }),
  usePreviewTemplate: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdateMessagingSettings: () => ({ mutate: jest.fn(), isPending: false }),
}));

beforeEach(() => {
  mockRole = "TENANT_ADMIN";
  state.config = makeConfig();
  state.isError = false;
  state.isLoading = false;
  state.health = null;
  state.refetch = jest.fn();
  state.toggle = jest.fn();
});

describe("Notifications page — grouped list (#1965)", () => {
  it("T5 renders no 'Not available' text, no WhatsApp/SMS/Portal column, and ONE coming-soon line", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.queryByText(/not available/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /whatsapp|sms|portal/i })).toBeNull();
    expect(screen.getAllByText(/whatsapp, sms and portal: coming soon/i)).toHaveLength(1);
  });

  it("T6 every live row shows a recipient chip; order rows say 'Your customer'", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    for (const name of ["Order confirmed", "Delivered"]) {
      const row = screen.getByText(name).closest("[data-event-row]") as HTMLElement;
      expect(row).not.toBeNull();
      expect(within(row).getByText("Your customer")).toBeInTheDocument();
    }
  });

  it("T7 a NOT_CONFIGURED channel gets one 'Not set up' header link and disabled cells with a tooltip", () => {
    state.config = makeConfig({
      channelStatus: {
        EMAIL: "LIVE",
        WHATSAPP: "NOT_CONFIGURED",
        SMS: "NOT_BUILT",
        PORTAL: "NOT_BUILT",
      },
    });
    renderWithProviders(<NotificationsSettingsTab />);
    const link = screen.getByRole("link", { name: /set up whatsapp/i });
    expect(link).toHaveAttribute("href", expect.stringContaining("/settings"));
    // "Not set up" is stated once in the header, never per cell.
    expect(screen.getAllByText(/^whatsapp · not set up$/i)).toHaveLength(1);
    const disabled = screen.getAllByRole("switch", { name: /whatsapp/i });
    expect(disabled.length).toBeGreaterThan(0);
    for (const sw of disabled) {
      expect(sw).toHaveAttribute("aria-disabled", "true");
      expect(sw).toHaveAttribute("title", "Set up WhatsApp to use this");
    }
  });

  it("T8 events without a firing site have no switch and appear only under 'Coming soon'", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.queryByRole("switch", { name: /payment reminder/i })).toBeNull();
    expect(screen.queryByRole("switch", { name: /low stock/i })).toBeNull();
    const soon = screen.getByText(/^coming soon$/i).closest("details") as HTMLElement;
    expect(soon).not.toBeNull();
    expect(within(soon).getByText("Payment reminder")).toBeInTheDocument();
    expect(within(soon).getByText("Low stock")).toBeInTheDocument();
    expect(within(soon).queryAllByRole("switch")).toHaveLength(0);
  });

  it("T9 the message meter is hidden unless a metered channel is LIVE", () => {
    const { unmount } = renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.queryByText(/messages used/i)).not.toBeInTheDocument();
    unmount();
    state.config = makeConfig({
      channelStatus: { EMAIL: "LIVE", WHATSAPP: "LIVE", SMS: "NOT_BUILT", PORTAL: "NOT_BUILT" },
    });
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.getByText(/messages used/i)).toBeInTheDocument();
  });

  it("T10 a non-admin sees read-only switches and the caption", () => {
    mockRole = "OPERATOR";
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.getByText("Only admins can change notifications")).toBeInTheDocument();
    for (const sw of screen.getAllByRole("switch", { name: /order confirmed|delivered/i })) {
      expect(sw).toBeDisabled();
    }
  });

  it("T11 a failed toggle shows a fixed sentence, never the server message", async () => {
    state.toggle = jest.fn((_vars, opts) =>
      opts.onError({ response: { data: { message: "P2002 raw provider text" } } }),
    );
    renderWithProviders(<NotificationsSettingsTab />);
    fireEvent.click(screen.getByRole("switch", { name: /order confirmed/i }));
    expect(await screen.findByText("Couldn't save, please try again")).toBeInTheDocument();
    expect(screen.queryByText(/P2002/)).not.toBeInTheDocument();
  });

  it("T12 a load error shows a sentence and a working Retry", () => {
    state.isError = true;
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.getByText("Couldn't load notification settings.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(state.refetch).toHaveBeenCalled();
  });

  it("T13 the health strip maps a reason code to a sentence + fix link and never prints the raw code", () => {
    state.health = {
      windowDays: 7,
      sent: 40,
      failed: 2,
      skipped: 1,
      byReason: [{ reasonCode: "NO_FROM_ADDRESS", count: 2, fixLink: "SETTINGS_EMAIL" }],
    };
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.getByText(/40 sent/i)).toBeInTheDocument();
    expect(screen.getByText(/no sending email address is set up/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /set up email/i })).toHaveAttribute(
      "href",
      expect.stringContaining("tab=email"),
    );
    expect(screen.queryByText(/NO_FROM_ADDRESS/)).not.toBeInTheDocument();
  });

  it("T13b the health strip renders nothing when the endpoint has no data", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.queryByText(/last 7 days/i)).not.toBeInTheDocument();
  });
});
