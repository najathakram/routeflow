import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import SettingsPage from "./page";

// `?tab=notifications` mounts only NotificationsSettingsTab — see the
// SECTIONS map in app/(dashboard)/settings/page.tsx.
const searchParams = new URLSearchParams("tab=notifications");
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock("@/lib/api/notifications", () => ({
  useNotificationsStatus: () => ({ data: { configured: false, deviceCount: 0 } }),
  useSendTestNotification: () => ({ mutate: jest.fn(), isPending: false }),
}));

// The messaging matrix carries one seeded event ("Low stock") whose INTERNAL
// cell is `unavailable: "NO_TRIGGER"` — REG-B180 (T6's companion fixture: no
// firing site exists for LOW_STOCK yet, so the cell can't be a live toggle).
const messagingConfig = {
  events: [
    {
      eventKey: "LOW_STOCK",
      label: "Low stock",
      channels: [
        {
          channel: "INTERNAL",
          enabled: false,
          ruleId: "rule-low-stock-internal",
          locked: false,
          unavailable: "NO_TRIGGER",
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

jest.mock("@/lib/api/messaging", () => ({
  ...jest.requireActual("@/lib/api/messaging"),
  useMessagingConfig: () => ({ data: messagingConfig, isLoading: false }),
  useToggleRule: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdateTemplate: () => ({ mutate: jest.fn(), isPending: false }),
  usePreviewTemplate: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdateMessagingSettings: () => ({ mutate: jest.fn(), isPending: false }),
}));

describe("SettingsPage — Notifications tab", () => {
  beforeEach(() => jest.clearAllMocks());

  // T4 / REG-B160: in P6-2 the quiet-hours window is only recorded on the send
  // outcome — nothing is held, delayed or queued (cause-ruling.md §2 defers the
  // hold queue). The card copy must not claim a hold; the honest negation is
  // the contract.
  it("REG-B160 the quiet-hours card no longer claims a hold", async () => {
    renderWithProviders(<SettingsPage />);

    await screen.findByText("Quiet hours");

    expect(screen.queryByText(/messages are held outside this window/i)).not.toBeInTheDocument();
    expect(screen.getByText(/not yet held or delayed/i)).toBeInTheDocument();
    expect(screen.getByText(/record/i)).toBeInTheDocument();
  });

  // T9 / REG-B180: a cell with no firing site is `unavailable` — the matrix
  // must show a qualifier explaining why, not a live enable/disable switch.
  it("REG-B180 an unavailable cell renders a qualifier, not a switch", async () => {
    renderWithProviders(<SettingsPage />);

    const row = (await screen.findByText("Low stock")).closest("tr");
    expect(row).not.toBeNull();
    const cell = within(row as HTMLElement);

    expect(cell.queryByRole("switch", { name: /low stock via internal/i })).not.toBeInTheDocument();
    expect(cell.getByText(/no trigger|not available|unavailable/i)).toBeInTheDocument();
  });
});
