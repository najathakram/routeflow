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
jest.mock("@stripe/stripe-js", () => ({
  loadStripe: (k: string) => mockLoadStripe(k),
}));
let mockOptions: { clientSecret?: string; onComplete?: () => void } = {};
jest.mock("@stripe/react-stripe-js", () => ({
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
}));
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

describe("EmbeddedCheckoutHost", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    closeEmbeddedCheckout();
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

  it("mounts Stripe's frame with the secret and the publishable key", () => {
    renderHost();
    act(() => openEmbeddedCheckout("cs_secret_1"));
    expect(screen.getByTestId("stripe-frame")).toBeInTheDocument();
    expect(mockOptions.clientSecret).toBe("cs_secret_1");
    expect(mockLoadStripe).toHaveBeenCalledWith("pk_test_placeholder");
  });

  it("13: onComplete goes to the success URL in the app, refetches billing, writes nothing", () => {
    const { invalidate } = renderHost();
    act(() => openEmbeddedCheckout("cs_secret_2"));
    act(() => mockOptions.onComplete?.());
    expect(mockPush).toHaveBeenCalledWith("/settings/billing?checkout=success");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["billing"] });
    expect(mockPost).not.toHaveBeenCalled();
    expect(screen.queryByTestId("stripe-frame")).toBeNull();
    expect(getEmbeddedCheckoutSecret()).toBeNull();
  });

  it("14: Back removes the panel and the secret, with no request", async () => {
    renderHost();
    act(() => openEmbeddedCheckout("cs_secret_3"));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByTestId("stripe-frame")).toBeNull();
    expect(getEmbeddedCheckoutSecret()).toBeNull();
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
