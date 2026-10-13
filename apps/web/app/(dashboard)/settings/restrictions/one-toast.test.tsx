import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import RestrictionsSettingsPage from "./page";

/**
 * End to end for the toast contract (B594 class): the REAL global MutationCache handler
 * (app/providers.tsx) around the REAL page, only the network mocked. Each failed save must raise
 * exactly ONE toast — the page's own for the guided cases (which HANDLED_CODES tells the global
 * handler to skip), the global handler's for everything else.
 */
const toast = jest.fn();
const patch = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "TENANT_ADMIN" } }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: jest.fn(async (url: string) =>
      url.includes("unknown-state-customers")
        ? {
            data: {
              noAddress: { total: 0, rows: [], nextCursor: null },
              unusableState: { total: 0, rows: [], nextCursor: null },
              needsReview: { total: 0, rows: [], nextCursor: null },
            },
          }
        : { data: { enabled: false, governingAddress: "BILLING_FIRST" } },
    ),
    patch: (...a: unknown[]) => patch(...a),
  },
}));

const reject = (status: number, data: object) =>
  patch.mockRejectedValueOnce(
    Object.assign(new Error("Request failed"), { response: { status, data } }),
  );
const flip = async () => {
  render(
    <Providers>
      <RestrictionsSettingsPage />
    </Providers>,
  );
  fireEvent.click(await screen.findByRole("switch"));
};

beforeEach(() => jest.clearAllMocks());

describe("one failed save = exactly one toast", () => {
  it("a not-ready 409 is no longer a guided state: the global handler's toast only, fixed copy", async () => {
    reject(409, { code: "SELLING_RESTRICTIONS_NOT_READY", message: "raw", readiness: {} });
    await flip();
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].title).not.toMatch(/can't enable yet|raw/i);
  });

  it("400 enable+policy (guided): the page's toast only, never the raw server text", async () => {
    reject(400, {
      code: "SELLING_RESTRICTIONS_ENABLE_AND_POLICY_TOGETHER",
      message: "raw server text",
    });
    await flip();
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].title).toMatch(/two steps/i);
  });

  it("any other error: the global handler's toast only, with FIXED copy (B980)", async () => {
    reject(500, { message: "Boom" });
    await flip();
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toMatchObject({
      title: "Something went wrong on our side. Please try again.",
      variant: "error",
    });
  });
});
