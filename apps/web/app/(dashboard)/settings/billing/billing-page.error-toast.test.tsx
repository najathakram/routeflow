import * as React from "react";
import { MutationCache, QueryClient } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { API_ERROR_CODES } from "@routeflow/types";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { handleMutationError } from "@/lib/mutation-error-toast";
import BillingSettingsPage from "./page";

/**
 * #3224 pixel review: a checkout refused with ADDON_BILLING_PENDING_CHECKOUT showed the page's own
 * (correct) message AND the app-wide generic toast on top of it. This runs the REAL billing hooks
 * against a mocked transport and the REAL app-wide MutationCache handler, so a second (global) toast is
 * visible here. Only the codes this page maps (and renders itself) opt out of the global toast; every
 * unmapped error keeps it.
 */

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "TENANT_ADMIN" } }),
}));

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => mockGet(...a),
    post: (...a: unknown[]) => mockPost(...a),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

const PENDING_MESSAGE =
  "Turn off Customer pack (+100) before adding your card, or contact support to set them up.";
const GENERIC_409 =
  "That conflicts with something that already exists or is in use. Check it and try again.";

const ADDON = {
  sku: "ROUTE_PLUS",
  name: "Route Plus",
  monthlyPrice: 49,
  unit: "tenant",
  includedAtPlan: null,
  meteredKey: null,
  capacityPerUnit: null,
  stackable: false,
  grantsFlags: [],
  sortOrder: 1,
};

const subscription = (over: Record<string, unknown> = {}) => ({
  planKey: "LITE",
  planName: "Lite",
  status: "ACTIVE",
  cycle: "MONTHLY",
  monthlyPrice: 99,
  annualPrice: null,
  isCustom: false,
  renewalAt: null,
  cancelAtPeriodEnd: false,
  downgradeToPlanKey: null,
  downgradeEffectiveAt: null,
  trialEndsAt: null,
  addons: [],
  flags: [],
  paymentRequired: false,
  ...over,
});

const reject = (status: number, data: Record<string, unknown>) =>
  Promise.reject(Object.assign(new Error("Request failed"), { response: { status, data } }));

function serve(sub: Record<string, unknown>) {
  mockGet.mockImplementation((url: string) => {
    if (url === "/billing/subscription") return Promise.resolve({ data: sub });
    if (url === "/billing/usage") return Promise.resolve({ data: [] });
    if (url === "/billing/plans") return Promise.resolve({ data: { plans: [], addons: [ADDON] } });
    if (url === "/billing/proration-preview")
      return Promise.resolve({
        data: {
          sku: "ROUTE_PLUS",
          name: "Route Plus",
          monthly: 49,
          proratedToday: 24.5,
          daysRemaining: 15,
          daysInCycle: 30,
          effectiveAt: "2026-10-02T00:00:00.000Z",
          nextChargeAt: "2026-10-17T00:00:00.000Z",
          billing: "STRIPE",
          billed: true,
          refusal: null,
        },
      });
    return Promise.resolve({ data: {} });
  });
}

function setup() {
  const globalToast = jest.fn();
  const queryClient = new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _v, _c, mutation) =>
        handleMutationError(error, mutation, globalToast, { push: jest.fn() }),
    }),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  renderWithProviders(<BillingSettingsPage />, { queryClient });
  return { globalToast };
}

describe("BillingSettingsPage: the global error toast only yields to codes the page maps", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  const completePayment = async () => {
    serve(
      subscription({
        status: "TRIAL",
        trialEndsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        paymentRequired: true,
      }),
    );
    const view = setup();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Complete payment" }));
    return view;
  };

  it("checkout refused with ADDON_BILLING_PENDING_CHECKOUT: only the server message, no generic toast", async () => {
    mockPost.mockImplementation(() =>
      reject(409, {
        code: API_ERROR_CODES.ADDON_BILLING_PENDING_CHECKOUT,
        message: PENDING_MESSAGE,
      }),
    );
    const { globalToast } = await completePayment();
    expect(await screen.findByText(PENDING_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(GENERIC_409)).toBeNull();
    expect(globalToast).not.toHaveBeenCalled();
  });

  it("checkout refused with any OTHER code keeps the generic toast beside the page's fixed copy", async () => {
    mockPost.mockImplementation(() => reject(409, { code: "SOMETHING_ELSE", message: "x" }));
    const { globalToast } = await completePayment();
    expect(
      await screen.findByText("We couldn't start checkout. Nothing was changed. Please try again."),
    ).toBeInTheDocument();
    await waitFor(() => expect(globalToast).toHaveBeenCalledTimes(1));
    expect(globalToast).toHaveBeenCalledWith({ title: GENERIC_409, variant: "error" });
  });

  const openEnable = async () => {
    serve(subscription());
    const view = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Enable" }));
    const dialog = within(await screen.findByRole("dialog"));
    await waitFor(() =>
      expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeEnabled(),
    );
    await user.click(dialog.getByRole("button", { name: "Enable add-on" }));
    return { ...view, dialog };
  };

  it("enable refused with ADDON_INCLUDED_IN_PLAN: only the sheet's own copy, no generic toast", async () => {
    mockPost.mockImplementation(() =>
      reject(409, { code: API_ERROR_CODES.ADDON_INCLUDED_IN_PLAN, message: "internal" }),
    );
    const { globalToast, dialog } = await openEnable();
    expect(
      await dialog.findByText("Route Plus is already included in your plan."),
    ).toBeInTheDocument();
    expect(globalToast).not.toHaveBeenCalled();
  });

  it("enable refused with ADDON_ANNUAL_NOT_SUPPORTED: only the sheet's own copy, no generic toast", async () => {
    mockPost.mockImplementation(() =>
      reject(409, { code: API_ERROR_CODES.ADDON_ANNUAL_NOT_SUPPORTED, message: "internal" }),
    );
    const { globalToast, dialog } = await openEnable();
    expect(
      await dialog.findByText(
        "Add-ons can't be added to an annual plan online yet. Please contact support.",
      ),
    ).toBeInTheDocument();
    expect(globalToast).not.toHaveBeenCalled();
  });

  it("enable failing with an UNMAPPED error keeps the generic toast", async () => {
    mockPost.mockImplementation(() => reject(503, { message: "api_connection_error" }));
    const { globalToast, dialog } = await openEnable();
    expect(
      await dialog.findByText(
        "We couldn't turn this add-on on. Nothing was changed. Please try again.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(globalToast).toHaveBeenCalledTimes(1));
    expect(globalToast).toHaveBeenCalledWith({
      title: "Something went wrong on our side. Please try again.",
      variant: "error",
    });
  });

  it("an enable 409 with an unknown code keeps the generic toast beside the BLOCKED sheet", async () => {
    mockPost.mockImplementation(() => reject(409, { code: "SOMETHING_NEW", message: "x" }));
    const { globalToast, dialog } = await openEnable();
    expect(
      await dialog.findByText(
        "This add-on can't be turned on online right now. Please contact support.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(globalToast).toHaveBeenCalledTimes(1));
  });

  it("Cancel subscription failing shows the page's own toast once, with no second generic toast", async () => {
    serve(subscription());
    mockPost.mockImplementation(() => reject(500, { message: "stripe internal sk_live_detail" }));
    const { globalToast } = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^cancel$/i }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Cancel subscription" }));
    expect(
      await screen.findByText("We couldn't cancel your subscription. Nothing was changed."),
    ).toBeInTheDocument();
    expect(globalToast).not.toHaveBeenCalled();
    expect(screen.queryByText(/sk_live_detail/)).toBeNull();
  });
});
