import * as React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { NotificationsSettingsTab } from "./NotificationsSettingsTab";

let role = "TENANT_ADMIN";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("./LowStockDigestToggle", () => ({
  LowStockDigestToggle: () => <div>low-stock-digest-toggle</div>,
}));
jest.mock("@/lib/api/notifications", () => ({
  useNotificationsStatus: () => ({ data: undefined }),
  useSendTestNotification: () => ({ mutate: jest.fn(), isPending: false }),
}));
const mutation = () => ({ mutate: jest.fn(), isPending: false });
jest.mock("@/lib/api/messaging", () => ({
  ...jest.requireActual("@/lib/api/messaging"),
  useMessagingConfig: () => ({
    isLoading: false,
    data: {
      events: [],
      // The matrix API always returns channelStatus (#1965 PR-A); the tab reads it.
      channelStatus: {
        EMAIL: "LIVE",
        WHATSAPP: "NOT_BUILT",
        SMS: "NOT_BUILT",
        PORTAL: "NOT_BUILT",
      },
      msgsMeter: null,
      settings: { quietHoursEnabled: false, quietHoursStart: "21:00", quietHoursEnd: "07:00" },
    },
  }),
  useToggleRule: () => mutation(),
  useUpdateTemplate: () => mutation(),
  usePreviewTemplate: () => mutation(),
  useUpdateMessagingSettings: () => mutation(),
}));

describe("NotificationsSettingsTab low-stock digest toggle", () => {
  it("is shown to a TENANT_ADMIN (the digest recipients)", () => {
    role = "TENANT_ADMIN";
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.getByText("low-stock-digest-toggle")).toBeInTheDocument();
  });

  it("is hidden from an OPERATOR (the digest never reaches them)", () => {
    role = "OPERATOR";
    renderWithProviders(<NotificationsSettingsTab />);
    expect(screen.queryByText("low-stock-digest-toggle")).not.toBeInTheDocument();
  });
});
