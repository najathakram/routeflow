import * as React from "react";
import { fireEvent, renderWithProviders, screen, within } from "@/test-utils/render";
import { NotificationsSettingsTab } from "./_components/NotificationsSettingsTab";

/**
 * #1965 (spec 10) — the notifications page is a grouped list, not a mostly-"Not available" matrix:
 * recipient chip per row, channels that are not built appear ONCE as "coming soon", events with no
 * firing site are listed under "Coming soon" with no switch, and no raw reason string is rendered.
 */

let mockRole = "TENANT_ADMIN";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: mockRole } }),
}));

const senderState: {
  sender: { kind: string; label: string; mailboxAvailable: boolean } | null;
  enabledArg: boolean | undefined;
} = {
  sender: { kind: "default", label: "RouteFlow's address", mailboxAvailable: true },
  enabledArg: undefined,
};
// Mirrors production: the hook is told enabled=isAdmin and returns nothing when disabled.
jest.mock("./_components/useEmailSender", () => ({
  useEmailSender: (enabled: boolean) => {
    senderState.enabledArg = enabled;
    return { sender: enabled ? senderState.sender : null };
  },
}));

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
        eventKey: "INVOICE_SENT",
        label: "Invoice sent",
        audience: "CUSTOMER",
        hasTrigger: true,
        channels: [
          cell("PORTAL", {
            enabled: false,
            ruleId: "rule-inv-portal",
            unavailable: "NO_TRANSPORT",
          }),
          { ...cell("WHATSAPP", { enabled: false, ruleId: null }), locked: true },
          { ...cell("SMS", { enabled: false, ruleId: null }), locked: true },
        ],
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
  keepDataOnError: boolean;
} = {
  config: makeConfig(),
  isError: false,
  isLoading: false,
  refetch: jest.fn(),
  health: null,
  toggle: jest.fn(),
  keepDataOnError: false,
};

jest.mock("@/lib/api/messaging", () => ({
  ...jest.requireActual("@/lib/api/messaging"),
  useMessagingConfig: () => ({
    data: state.isError && !state.keepDataOnError ? undefined : state.config,
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
  senderState.sender = { kind: "default", label: "RouteFlow's address", mailboxAvailable: true };
  senderState.enabledArg = undefined;
  mockRole = "TENANT_ADMIN";
  state.config = makeConfig();
  state.isError = false;
  state.isLoading = false;
  state.health = null;
  state.refetch = jest.fn();
  state.toggle = jest.fn();
  state.keepDataOnError = false;
});

describe("Notifications page — grouped list (#1965)", () => {
  it("T5 renders no 'Not available' text, no WhatsApp/SMS/Portal column, and coming-soon channels in ONE place (the disclosure)", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.queryByText(/not available/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /whatsapp|sms|portal/i })).toBeNull();
    const soon = screen.getByText(/^coming soon$/i).closest("details") as HTMLElement;
    expect(
      within(soon).getByText(/whatsapp, sms and customer portal messages/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/whatsapp, sms and customer portal messages/i)).toHaveLength(1);
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
      // keyboard/screen-reader users get the same text (a title alone is mouse-only)
      expect(sw).toHaveAccessibleDescription("Set up WhatsApp to use this");
      fireEvent.click(sw);
    }
    expect(state.toggle).not.toHaveBeenCalled();
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

  it("apple-ux: 'Low stock' under Coming soon points an admin to the live daily digest below", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    const soon = screen.getByText(/^coming soon$/i).closest("details") as HTMLElement;
    const link = within(soon).getByRole("link", { name: "The daily low-stock digest is below" });
    expect(link).toHaveAttribute("href", "#low-stock-digest");
  });

  it("apple-ux: a non-admin sees no digest pointer (the digest card is admin-only)", () => {
    mockRole = "OPERATOR";
    try {
      renderWithProviders(<NotificationsSettingsTab />);
      expect(screen.queryByRole("link", { name: /daily low-stock digest/i })).toBeNull();
    } finally {
      mockRole = "TENANT_ADMIN";
    }
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
    // nothing editable for a read-only user
    expect(screen.queryByRole("button", { name: /edit .* email text/i })).toBeNull();
  });

  it("T12 a load error shows a sentence and a working Retry", () => {
    state.isError = true;
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.getByText("Couldn't load notification settings.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(state.refetch).toHaveBeenCalled();
  });

  it("T2 (review F2) a live event with no cell in any visible column is not listed (no dead 'Invoice sent' row)", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.queryByText("Invoice sent")).not.toBeInTheDocument();
    expect(screen.getByText(/invoices are emailed when you press send/i)).toBeInTheDocument();
  });

  it("T2b (review c) an event whose only visible cell is policy-locked is not listed either", () => {
    state.config = makeConfig({
      channelStatus: {
        EMAIL: "NOT_BUILT",
        WHATSAPP: "LIVE",
        SMS: "NOT_BUILT",
        PORTAL: "NOT_BUILT",
      },
      events: [
        {
          eventKey: "INVOICE_SENT",
          label: "Invoice sent",
          audience: "CUSTOMER",
          hasTrigger: true,
          channels: [{ ...cell("WHATSAPP", { enabled: false, ruleId: null }), locked: true }],
        },
      ],
    });
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.queryByText("Invoice sent")).not.toBeInTheDocument();
  });

  it("T3 (review F3) the template editor shows only live channels and opens on Email", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    fireEvent.click(screen.getByRole("button", { name: /edit order confirmed email text/i }));
    expect(screen.getByRole("button", { name: "Email" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /whatsapp|sms|portal/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/meta template name/i)).not.toBeInTheDocument();
  });

  it("T12b (review nit 7) a failed background refetch keeps the list and shows an inline alert", () => {
    state.isError = true;
    state.keepDataOnError = true;
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.getByText("Order confirmed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh notification settings.");
  });

  it("T14 (review nit 8) the policy-lock info icon is keyboard reachable and named", () => {
    state.config = makeConfig({
      channelStatus: { EMAIL: "LIVE", WHATSAPP: "LIVE", SMS: "LIVE", PORTAL: "NOT_BUILT" },
      events: [
        {
          eventKey: "INVOICE_SENT",
          label: "Invoice sent",
          audience: "CUSTOMER",
          hasTrigger: true,
          channels: [
            cell("EMAIL", { ruleId: "rule-inv-email" }),
            { ...cell("WHATSAPP", { enabled: false, ruleId: null }), locked: true },
          ],
        },
      ],
    });
    renderWithProviders(<NotificationsSettingsTab />);
    const info = screen.getByRole("img", {
      name: /invoices are sent by email or the buyer portal only/i,
    });
    expect(info).toHaveAttribute("tabindex", "0");
  });

  it("T16 the sender row says which sender is in use and links to mailbox setup (admin)", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    const row = document.querySelector("[data-sender-row]") as HTMLElement;
    expect(row).toHaveTextContent("Sending from: RouteFlow's address");
    expect(within(row).getByRole("link", { name: /use your own mailbox/i })).toHaveAttribute(
      "href",
      "/settings?tab=email",
    );
  });

  it("T16b a connected sender is named; an unknown sender hides the row; without the mailbox add-on the link says Set up email", () => {
    senderState.sender = {
      kind: "mailbox",
      label: "your connected mailbox (ops@acme.test)",
      mailboxAvailable: true,
    };
    const first = renderWithProviders(<NotificationsSettingsTab />);
    expect(document.querySelector("[data-sender-row]")).toHaveTextContent(
      "Sending from: your connected mailbox (ops@acme.test)",
    );
    first.unmount();
    senderState.sender = null;
    const second = renderWithProviders(<NotificationsSettingsTab />);
    expect(document.querySelector("[data-sender-row]")).toBeNull();
    second.unmount();
    senderState.sender = { kind: "default", label: "RouteFlow's address", mailboxAvailable: false };
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.queryByRole("link", { name: /use your own mailbox/i })).toBeNull();
    expect(screen.getByRole("link", { name: /set up email/i })).toHaveAttribute(
      "href",
      "/settings?tab=email",
    );
  });

  it("T16c (Q11) an operator: the hook is told enabled=false, NO sender row renders and no setup link", () => {
    mockRole = "OPERATOR";
    renderWithProviders(<NotificationsSettingsTab />);
    expect(senderState.enabledArg).toBe(false);
    expect(document.querySelector("[data-sender-row]")).toBeNull();
    expect(screen.queryByText(/sending from/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /set up email|use your own mailbox/i })).toBeNull();
  });

  it("T16d an admin: the hook is told enabled=true", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    expect(senderState.enabledArg).toBe(true);
  });

  it("T22 the team group says plainly that nothing is emailed to the team yet", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    const team = screen
      .getByRole("heading", { name: "Emails to your team" })
      .closest("section") as HTMLElement;
    expect(within(team).getByText(/your team isn't emailed about orders yet/i)).toBeInTheDocument();
  });

  it("T17 the loading state is an accessible status region", () => {
    state.isLoading = true;
    renderWithProviders(<NotificationsSettingsTab />);
    expect(
      screen.getByRole("status", { name: /loading notification settings/i }),
    ).toBeInTheDocument();
  });

  it("T18 (a11y) the sender row and footnote are >= 4.5:1 (text-navy/70 = 6.4:1; /50 was 3.3:1)", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    const row = document.querySelector("[data-sender-row]") as HTMLElement;
    expect(row.className).toMatch(/text-navy\/70/);
    const foot = screen.getByText(/invoices are emailed when you press send/i);
    expect(foot.className).toMatch(/text-navy\/70/);
    expect(foot.className).not.toMatch(/text-navy\/(?:[0-5]\d)/);
  });

  it("T18b (a11y) the non-admin caption is also >= 4.5:1", () => {
    mockRole = "OPERATOR";
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.getByText("Only admins can change notifications").className).toMatch(
      /text-navy\/70/,
    );
  });

  it("T19 (a11y, WCAG 2.5.8) every switch pads its hit area to >= 44px without changing its 36x20 visual", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    for (const sw of screen.getAllByRole("switch")) {
      expect(sw.className).toMatch(/before:-inset-y-3/);
      expect(sw.className).toMatch(/before:-inset-x-2/);
      expect(sw.className).toMatch(/h-5 w-9/);
    }
  });

  it("T13 the health strip maps a reason code to a count sentence + fix link, warns on failures, and never prints the raw code", () => {
    state.health = {
      windowDays: 7,
      sent: 40,
      failed: 2,
      skipped: 1,
      byReason: [{ reasonCode: "NO_FROM_ADDRESS", count: 2, fixLink: "SETTINGS_EMAIL" }],
    };
    renderWithProviders(<NotificationsSettingsTab />);
    const strip = screen.getByRole("region", { name: /email delivery, last 7 days/i });
    expect(strip).toHaveTextContent("40 sent");
    expect(strip).toHaveTextContent("2 failed");
    expect(strip).toHaveTextContent("1 skipped");
    expect(
      within(strip).getByText("2 emails weren't sent: no sending email address is set up."),
    ).toBeInTheDocument();
    expect(strip.textContent).not.toMatch(/\(2\)/);
    expect(within(strip).getByText("2 failed").className).toMatch(/text-danger|text-red/);
    expect(within(strip).getByRole("link", { name: /set up email/i })).toHaveAttribute(
      "href",
      expect.stringContaining("tab=email"),
    );
    expect(screen.queryByText(/NO_FROM_ADDRESS/)).not.toBeInTheDocument();
  });

  it("T13c (review nit 6) a partial health payload renders nothing and windowDays drives the label", () => {
    state.health = { windowDays: 7, sent: 4, byReason: [] };
    const { unmount } = renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    expect(screen.queryByText(/last 7 days/i)).not.toBeInTheDocument();
    unmount();
    state.health = { windowDays: 30, sent: 1, failed: 0, skipped: 0, byReason: [] };
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.getByRole("region", { name: /last 30 days/i })).toHaveTextContent("1 sent");
  });

  it("T20 (mobile) each row stacks: one labelled switch per channel beside its name", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    const row = screen.getByText("Order confirmed").closest("[data-event-row]") as HTMLElement;
    const sw = within(row).getByRole("switch", { name: /order confirmed via email/i });
    expect(within(row).getByText("Email")).toBeInTheDocument();
    expect(sw).toBeInTheDocument();
    expect(row.tagName).toBe("LI");
  });

  it("T21 every live event carries a one-line description (who gets it, and when)", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.getByText("Sent when an order is confirmed.")).toBeInTheDocument();
  });

  it("T23 a not-set-up channel is stated ONCE, above the list, not as a column", () => {
    state.config = makeConfig({
      channelStatus: {
        EMAIL: "LIVE",
        WHATSAPP: "NOT_CONFIGURED",
        SMS: "NOT_BUILT",
        PORTAL: "NOT_BUILT",
      },
    });
    renderWithProviders(<NotificationsSettingsTab />);
    const note = screen.getByText(/^whatsapp · not set up$/i);
    const firstRow = document.querySelector("[data-event-row]") as HTMLElement;
    expect(note.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("columnheader")).toBeNull();
  });

  it("T24 (error) Retry is a 44px tap target and the push card still renders", () => {
    state.isError = true;
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.getByRole("button", { name: /retry/i }).className).toMatch(/min-h-11/);
    expect(screen.getByText("Push notifications")).toBeInTheDocument();
  });

  it("T13d the health strip fix link is admin-only: a non-admin still sees the sentence, no link", () => {
    mockRole = "OPERATOR";
    state.health = {
      windowDays: 7,
      sent: 40,
      failed: 2,
      skipped: 0,
      byReason: [{ reasonCode: "NO_FROM_ADDRESS", count: 2, fixLink: "SETTINGS_EMAIL" }],
    };
    renderWithProviders(<NotificationsSettingsTab />);
    const strip = screen.getByRole("region", { name: /email delivery, last 7 days/i });
    expect(strip).toHaveTextContent("2 emails weren't sent: no sending email address is set up.");
    expect(within(strip).queryByRole("link")).toBeNull();
  });

  it("T25 (deploy skew) a payload WITHOUT channelStatus renders the page without throwing and omits the rules section", () => {
    state.config = makeConfig({ channelStatus: undefined });
    renderWithProviders(<NotificationsSettingsTab />);
    // the rest of the tab still renders
    expect(screen.getByText("Quiet hours")).toBeInTheDocument();
    expect(screen.getByText("Push notifications")).toBeInTheDocument();
    // channel availability is unknown, so the rules list is not shown (and nothing throws)
    expect(screen.queryByText("Notification rules")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /order confirmed/i })).toBeNull();
  });

  it("T13b the health strip renders nothing when the endpoint has no data", () => {
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.queryByText(/last 7 days/i)).not.toBeInTheDocument();
  });
});
