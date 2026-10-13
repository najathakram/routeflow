import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import SettingsPage from "./page";
import SettingsImportPage from "./import/page";
import MigrationHubPage from "./migration/page";
import { BillingExportButton } from "./billing/BillingExportButton";

// Perms PR1 M1: the api made account-level settings TENANT_ADMIN-only (an OPERATOR now gets 403), so
// the UI must stop offering those controls to anyone else. Reads that stay open keep working.

let mockRole = "OPERATOR";
let mockTab: string | null = null;
const get = jest.fn();
const post = jest.fn();
const patch = jest.fn();
const del = jest.fn();

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "me", username: "myself", role: mockRole } }),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockTab ? `tab=${mockTab}` : ""),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
    delete: (...a: unknown[]) => del(...a),
    put: jest.fn(),
  },
}));

const mine = {
  id: "me",
  username: "myself",
  email: "me@example.com",
  role: "OPERATOR",
  status: "ACTIVE",
  createdAt: new Date("2026-01-01").toISOString(),
};
const theirs = { ...mine, id: "u2", username: "theirs", email: "them@example.com" };
const mockChangeStatus = jest.fn();
jest.mock("@/lib/api/users", () => ({
  ...jest.requireActual("@/lib/api/users"),
  useUsers: () => ({ data: { data: [mine, theirs], meta: { total: 2 } }, isLoading: false }),
  useCreateOperator: () => ({ mutateAsync: jest.fn(), isPending: false, error: null }),
  useUpdateUser: () => ({ mutateAsync: jest.fn(), isPending: false, error: null }),
  useChangeUserStatus: () => ({ mutate: mockChangeStatus, isPending: false }),
  useResetUserPassword: () => ({ mutate: jest.fn(), isPending: false }),
}));

let driverOn = false;
const stripe = { configured: true, connected: false, chargesEnabled: false } as Record<
  string,
  unknown
>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = "OPERATOR";
  mockTab = null;
  driverOn = false;
  Object.assign(stripe, { configured: true, connected: false, chargesEnabled: false });
  get.mockImplementation((url: string) => {
    if (url === "/settings/stripe-connect") return Promise.resolve({ data: { ...stripe } });
    if (url === "/users/me")
      return Promise.resolve({ data: { id: "me", role: mockRole, canActAsDriver: driverOn } });
    if (url === "/import/numbering")
      return Promise.resolve({
        data: [
          {
            docType: "INVOICE",
            prefix: "INV-",
            nextNumber: 7,
            padding: 4,
            preview: "INV-0007",
            configured: true,
          },
        ],
      });
    if (url === "/import/resolution/incomplete" || url === "/import/migration")
      return Promise.resolve({ data: [] });
    if (url === "/settings/invoice")
      return Promise.resolve({ data: { defaultTerms: "Net 30", hideOriginalPrice: false } });
    return Promise.resolve({ data: {} });
  });
});

const urlsRequested = () => get.mock.calls.map((c) => String(c[0]));

describe("T1.3 operator: account-admin controls are not offered", () => {
  beforeEach(() => {
    mockRole = "OPERATOR";
  });

  it("hub: Import data, Migration, Email and Claude AI scanner are not listed or searchable", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("Business profile")).toBeInTheDocument();
    for (const label of ["Import data", "Migration", "Email (SMTP)", "Claude AI scanner"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    // SA: GoHighLevel stays for operators (its tab is safe; sync, import, retry and handoffs are open to them)
    // (a one-item group renders as one row under the group title, so find the tile by where it goes)
    expect(
      screen
        .getAllByRole("link")
        .some((a) => a.getAttribute("href") === "/settings?tab=gohighlevel"),
    ).toBe(true);
    await user.type(screen.getByLabelText("Search settings"), "smtp");
    expect(screen.queryByText("Email (SMTP)")).not.toBeInTheDocument();
  });

  it("Stripe: status is shown read-only, with no Connect button", async () => {
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("Card payments (Stripe)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect stripe/i })).not.toBeInTheDocument();
  });

  it("Stripe: a connected account shows no Disconnect button", async () => {
    Object.assign(stripe, {
      connected: true,
      chargesEnabled: true,
      stripeAccountId: "acct_1234567890",
      livemode: true,
    });
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText(/Connected account/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /disconnect/i })).not.toBeInTheDocument();
  });

  it("billing export: renders nothing", () => {
    renderWithProviders(<BillingExportButton />);
    expect(screen.queryByRole("button", { name: /download billing data/i })).toBeNull();
  });

  it("invoicing: never requests the numbering endpoints, hides the prefix, keeps payment terms", async () => {
    mockTab = "invoicing";
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByLabelText("Payment Due Days")).toBeInTheDocument();
    expect(screen.queryByLabelText("Invoice Number Prefix")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save numbering/i })).not.toBeInTheDocument();
    await waitFor(() => expect(urlsRequested()).toContain("/settings/invoice"));
    expect(urlsRequested().filter((u) => u.startsWith("/import"))).toEqual([]);
  });

  it("/settings/import: title and one line only, no API calls", async () => {
    renderWithProviders(<SettingsImportPage />);
    expect(await screen.findByText("Only an admin can import data.")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("/settings/migration: title and one line only, no API calls", async () => {
    renderWithProviders(<MigrationHubPage />);
    expect(await screen.findByText("Only an admin can import data.")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  describe("users tab", () => {
    beforeEach(() => {
      mockTab = "users";
    });

    it("lists users but offers no Add User and no status toggle", async () => {
      renderWithProviders(<SettingsPage />);
      expect(await screen.findByText("theirs")).toBeInTheDocument();
      expect(screen.getByText("myself")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^add user$/i })).not.toBeInTheDocument();
      expect(screen.queryByTitle(/^(Deactivate|Activate)$/)).not.toBeInTheDocument();
    });

    it("keeps Edit on the viewer's own row only, and Reset password is gone from it", async () => {
      const user = userEvent.setup();
      renderWithProviders(<SettingsPage />);
      await screen.findByText("theirs");
      const edits = screen.getAllByTitle("Edit user");
      expect(edits).toHaveLength(1);
      const ownRow = screen.getByText("myself").closest("tr")!;
      expect(within(ownRow).getByTitle("Edit user")).toBe(edits[0]);
      await user.click(edits[0]);
      const dialog = within(await screen.findByRole("dialog"));
      expect(dialog.getByLabelText("Username")).toBeInTheDocument();
      expect(dialog.getByLabelText("Email")).toBeInTheDocument();
      expect(dialog.queryByRole("button", { name: /reset password/i })).not.toBeInTheDocument();
    });
  });

  describe("my account: Act as driver", () => {
    beforeEach(() => {
      mockTab = "account";
    });

    it("has no switch; shows a read-only line when driver access is already on", async () => {
      driverOn = true;
      renderWithProviders(<SettingsPage />);
      expect(
        await screen.findByText("Driver access is on. Ask an admin to change it."),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Toggle driver access")).not.toBeInTheDocument();
    });

    it("shows nothing about driver access when it is off", async () => {
      renderWithProviders(<SettingsPage />);
      await screen.findByText("Google Sign-In");
      expect(screen.queryByLabelText("Toggle driver access")).not.toBeInTheDocument();
      expect(screen.queryByText(/Driver access is on/)).not.toBeInTheDocument();
    });
  });
});

describe("T1.4 admin: the same controls are all there", () => {
  it.each(["TENANT_ADMIN", "SUPER_ADMIN"])("%s: hub lists the admin tiles", async (role) => {
    mockRole = role;
    renderWithProviders(<SettingsPage />);
    for (const label of [
      "Import data",
      "Migration",
      "Email (SMTP)",
      "Claude AI scanner",
      "GoHighLevel",
    ]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  it("Stripe: Connect is offered, and Disconnect once connected", async () => {
    mockRole = "TENANT_ADMIN";
    const first = renderWithProviders(<SettingsPage />);
    expect(await screen.findByRole("button", { name: /connect stripe/i })).toBeInTheDocument();
    first.unmount();
    Object.assign(stripe, {
      connected: true,
      chargesEnabled: true,
      stripeAccountId: "acct_1234567890",
    });
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByRole("button", { name: /^disconnect$/i })).toBeInTheDocument();
  });

  it("billing export button renders", () => {
    mockRole = "TENANT_ADMIN";
    renderWithProviders(<BillingExportButton />);
    expect(screen.getByRole("button", { name: /download billing data/i })).toBeInTheDocument();
  });

  it("invoicing: fetches numbering and shows the prefix next to payment terms", async () => {
    mockRole = "TENANT_ADMIN";
    mockTab = "invoicing";
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByLabelText("Invoice Number Prefix")).toBeInTheDocument();
    expect(screen.getByLabelText("Payment Due Days")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save numbering/i })).toBeInTheDocument();
    await waitFor(() => expect(urlsRequested()).toContain("/import/numbering"));
  });

  it("/settings/import and /settings/migration render their pages", async () => {
    mockRole = "TENANT_ADMIN";
    const a = renderWithProviders(<SettingsImportPage />);
    expect(await screen.findByText("Import from Zoho")).toBeInTheDocument();
    a.unmount();
    renderWithProviders(<MigrationHubPage />);
    expect(screen.queryByText("Only an admin can import data.")).not.toBeInTheDocument();
  });

  it("users tab: Add User, status toggles, Edit on every row and Reset password", async () => {
    mockRole = "TENANT_ADMIN";
    mockTab = "users";
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByRole("button", { name: /^add user$/i })).toBeInTheDocument();
    // SA M2 (UI): never on the viewer's OWN row, so only "theirs" can be deactivated
    expect(screen.getAllByTitle("Deactivate")).toHaveLength(1);
    const edits = screen.getAllByTitle("Edit user");
    expect(edits).toHaveLength(2);
    await user.click(edits[1]);
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("button", { name: /reset password/i })).toBeInTheDocument();
  });

  it("my account: the Act as driver switch is offered", async () => {
    mockRole = "TENANT_ADMIN";
    mockTab = "account";
    driverOn = true;
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByLabelText("Toggle driver access")).toBeInTheDocument();
    expect(screen.queryByText(/Driver access is on/)).not.toBeInTheDocument();
  });
});

describe("T1.3 deep links: an operator who opens an admin-only screen by URL", () => {
  it.each(["email", "integrations"])(
    "?tab=%s shows the admin-only line and requests nothing behind it",
    async (tab) => {
      mockRole = "OPERATOR";
      mockTab = tab;
      renderWithProviders(<SettingsPage />);
      expect(await screen.findByText("Only an admin can change this.")).toBeInTheDocument();
      const urls = get.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(
        urls.some((u) => u.startsWith("/settings/email") || u.startsWith("/settings/anthropic")),
      ).toBe(false);
    },
  );

  it.each(["email", "integrations"])(
    "a tenant admin still gets the full ?tab=%s screen",
    async (tab) => {
      mockRole = "TENANT_ADMIN";
      mockTab = tab;
      renderWithProviders(<SettingsPage />);
      await waitFor(() => expect(screen.queryByText("Only an admin can change this.")).toBeNull());
    },
  );
});

describe("SA #3412 musts: the users tab never offers a lockout, and says why when the API refuses", () => {
  beforeEach(() => {
    mockRole = "TENANT_ADMIN";
    mockTab = "users";
  });

  it("no Deactivate on the viewer's own row", async () => {
    renderWithProviders(<SettingsPage />);
    const own = (await screen.findByText("myself")).closest("tr") as HTMLElement;
    expect(within(own).queryByTitle(/^(Deactivate|Activate)$/)).toBeNull();
    const other = screen.getByText("theirs").closest("tr") as HTMLElement;
    expect(within(other).getByTitle("Deactivate")).toBeInTheDocument();
  });

  it.each([
    ["LAST_TENANT_ADMIN", "This is the only active admin. Make someone else an admin first."],
    ["SELF_DEACTIVATION_REFUSED", "You can't deactivate your own account. Ask another admin."],
  ])("a %s refusal reads as its own sentence", async (code, copy) => {
    const user = userEvent.setup();
    mockChangeStatus.mockImplementation((_v: unknown, opts: { onError?: (e: unknown) => void }) =>
      opts.onError?.({ response: { status: 409, data: { code } } }),
    );
    renderWithProviders(<SettingsPage />);
    const other = (await screen.findByText("theirs")).closest("tr") as HTMLElement;
    await user.click(within(other).getByTitle("Deactivate"));
    expect(await screen.findByText(copy)).toBeInTheDocument();
  });
});
