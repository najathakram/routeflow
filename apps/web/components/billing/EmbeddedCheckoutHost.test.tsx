import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EmbeddedCheckoutHost } from "./EmbeddedCheckoutHost";
import {
  closeEmbeddedCheckout,
  getEmbeddedCheckoutSecret,
  openEmbeddedCheckout,
} from "@/lib/checkout-embedded";

// SA-1139 PR-2 cases 13 and 14. Stripe is mocked at the module boundary: card data never touches our code.
const mockLoadStripe = jest.fn((_key: string) => Promise.resolve({ stub: true }));
// Counts how many Stripe modules were evaluated: at rest it must stay 0 (SA-1139 fix round 1, MUST 1).
const stripeEvaluated = () => (globalThis as { __stripeEval?: number }).__stripeEval ?? 0;
jest.mock("@stripe/stripe-js/pure", () => {
  const g = globalThis as { __stripeEval?: number };
  g.__stripeEval = (g.__stripeEval ?? 0) + 1;
  return { loadStripe: (k: string) => mockLoadStripe(k) };
});
jest.mock("@stripe/stripe-js", () => {
  const g = globalThis as { __stripeEval?: number };
  g.__stripeEval = (g.__stripeEval ?? 0) + 1;
  return { loadStripe: (k: string) => mockLoadStripe(k) };
});
let mockOptions: { clientSecret?: string; onComplete?: () => void } = {};
jest.mock("@stripe/react-stripe-js", () => {
  const g = globalThis as { __stripeEval?: number };
  g.__stripeEval = (g.__stripeEval ?? 0) + 1;
  return {
    EmbeddedCheckoutProvider: ({
      options,
      children,
    }: {
      options: typeof mockOptions;
      children: React.ReactNode;
    }) => {
      mockOptions = options;
      return <div data-testid="stripe-provider">{children}</div>;
    },
    EmbeddedCheckout: () => <div data-testid="stripe-frame" />,
  };
});
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: (...a: unknown[]) => mockPost(...a) },
}));

function renderHost() {
  const client = new QueryClient();
  const invalidate = jest.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <EmbeddedCheckoutHost />
    </QueryClientProvider>,
  );
  return { invalidate };
}

// Read once the host module has been imported: a static import of the panel would already have evaluated Stripe.
const evaluatedAtImport = (globalThis as { __stripeEval?: number }).__stripeEval ?? 0;
const RETURN = "/settings/billing?checkout=success";

describe("EmbeddedCheckoutHost", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    closeEmbeddedCheckout();
    (globalThis as { __stripeEval?: number }).__stripeEval = 0;
    mockOptions = {};
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_placeholder";
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  });

  it("renders nothing until a checkout is opened", () => {
    renderHost();
    expect(screen.queryByTestId("stripe-frame")).toBeNull();
  });

  it("no script at rest: the host with no secret loads no Stripe module and adds no js.stripe.com script", async () => {
    renderHost();
    await act(async () => {
      await Promise.resolve();
    });
    const scripts = Array.from(document.querySelectorAll("script")).filter((el) =>
      (el.getAttribute("src") ?? "").includes("js.stripe.com"),
    );
    expect(scripts).toHaveLength(0);
    expect(evaluatedAtImport).toBe(0);
    expect(stripeEvaluated()).toBe(0);
    expect(mockLoadStripe).not.toHaveBeenCalled();
  });

  it("mounts Stripe's frame with the secret and the publishable key", async () => {
    renderHost();
    act(() => openEmbeddedCheckout("cs_secret_1", RETURN));
    expect(await screen.findByTestId("stripe-frame")).toBeInTheDocument();
    expect(mockOptions.clientSecret).toBe("cs_secret_1");
    expect(mockLoadStripe).toHaveBeenCalledWith("pk_test_placeholder");
  });

  it.each([
    ["plan checkout", "/settings/billing?checkout=success"],
    ["payment-due pay", "/settings/billing?paid=1"],
    ["payment-due card add", "/settings/billing?paid=1&card=1"],
  ])(
    "13: onComplete (%s) goes to the path that flow opened with, refetches billing, writes nothing",
    async (_name, path) => {
      const { invalidate } = renderHost();
      act(() => openEmbeddedCheckout("cs_secret_2", path));
      await screen.findByTestId("stripe-frame");
      act(() => mockOptions.onComplete?.());
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith(path);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["billing"] });
      expect(mockPost).not.toHaveBeenCalled();
      expect(screen.queryByTestId("stripe-frame")).toBeNull();
      expect(getEmbeddedCheckoutSecret()).toBeNull();
    },
  );

  it("a new secret remounts the Stripe provider (key on the secret)", async () => {
    renderHost();
    act(() => openEmbeddedCheckout("cs_secret_a", RETURN));
    const first = await screen.findByTestId("stripe-provider");
    act(() => openEmbeddedCheckout("cs_secret_b", RETURN));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("stripe-provider")).not.toBe(first);
    expect(mockOptions.clientSecret).toBe("cs_secret_b");
  });

  it("14: Back removes the panel and the secret, with no request", async () => {
    renderHost();
    act(() => openEmbeddedCheckout("cs_secret_3", RETURN));
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(screen.queryByTestId("stripe-frame")).toBeNull();
    expect(getEmbeddedCheckoutSecret()).toBeNull();
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
